import type { TaskPackage } from "../contracts/index.ts";
import type { StoredNode } from "../db/index.ts";
import type {
  InternalServiceLaunch,
  NodeExecutionAdapter,
  NodeExecutionResult,
  NodeServiceDescriptor,
  ProviderExecEvent,
  ProviderRequestContext,
} from "./execution-adapter.ts";
import type { CloudflareSandboxClient, CloudflareSandboxConnection } from "../../sdk/cloudflare-sandbox/types.ts";

export class CloudflareSandboxNodeAdapter implements NodeExecutionAdapter {
  private readonly nodeInstances = new Map<string, string>();
  private readonly serviceProcesses = new Map<string, string>();
  private readonly servicePorts = new Map<string, number>();

  public constructor(private readonly client: CloudflareSandboxClient) {}

  public async executeTask(workspaceId: string, taskPackage: TaskPackage): Promise<NodeExecutionResult> {
    return await this.executeTaskWithProgress(workspaceId, taskPackage);
  }

  public async executeTaskWithProgress(
    workspaceId: string,
    taskPackage: TaskPackage,
    onEvent?: (event: ProviderExecEvent) => Promise<void> | void,
  ): Promise<NodeExecutionResult> {
    const connection = await this.client.create({
      workspace_id: workspaceId,
      sandbox_id: buildJobSandboxId(workspaceId, taskPackage.job_id),
      cwd: "/workspace",
      metadata: buildMetadata(taskPackage, workspaceId, "job"),
    });

    try {
      await this.stageTaskArtifacts(connection, taskPackage);
      const result = await connection.exec(taskPackage.instructions, {
        cwd: "/workspace",
        timeout_ms: taskPackage.timeout.hard_ms ?? taskPackage.timeout.soft_ms,
        env: {},
        stream: true,
      });
      if (result.stdout !== "") {
        await onEvent?.({ event: "stdout", data: { chunk: result.stdout, instance_id: connection.instance_id } });
      }
      if (result.stderr !== "") {
        await onEvent?.({ event: "stderr", data: { chunk: result.stderr, instance_id: connection.instance_id } });
      }
      await onEvent?.({
        event: "result",
        data: { instance_id: connection.instance_id, exit_code: result.exit_code, ...result.meta },
      });
      return {
        instance_id: connection.instance_id,
        exit_code: result.exit_code,
      };
    } finally {
      await connection.kill().catch(() => undefined);
      await connection.close().catch(() => undefined);
    }
  }

  public listServices(node: StoredNode): NodeServiceDescriptor[] {
    return node.manifest.capabilities
      .filter((capability) => capability.startsWith("service:"))
      .map(parseServiceCapability)
      .filter((service): service is NodeServiceDescriptor => service !== null);
  }

  public async prepareServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<InternalServiceLaunch> {
    void requestContext;
    const service = this.requireService(node, serviceId);
    const { connection, reused } = await this.ensureNodeConnection(workspaceId, node);
    const serviceKey = getServiceCacheKey(workspaceId, node.manifest.node_id, serviceId);
    let processId = this.serviceProcesses.get(serviceKey);
    if (processId === undefined) {
      const process = await connection.startProcess(resolveServiceCommand(service), {
        cwd: "/workspace",
        process_id: `svc-${serviceId}`,
      });
      processId = process.process_id;
      this.serviceProcesses.set(serviceKey, processId);
      await connection.waitForPort(processId, service.target_port, { timeout_ms: 30_000 });
    }
    const exposed = await connection.exposePort(service.target_port, { name: serviceId });
    this.servicePorts.set(serviceKey, service.target_port);
    await connection.close().catch(() => undefined);
    return {
      target_url: exposed.url,
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: reused,
      service_status: "ready",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  public async restartService(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<{ service_id: string; status: "ready" }> {
    void requestContext;
    await this.revokeServiceLaunch(workspaceId, node, serviceId);
    await this.prepareServiceLaunch(workspaceId, node, serviceId);
    return { service_id: serviceId, status: "ready" };
  }

  public async revokeServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<number> {
    void requestContext;
    this.requireService(node, serviceId);
    const cacheKey = getNodeCacheKey(workspaceId, node.manifest.node_id);
    const instanceId = this.nodeInstances.get(cacheKey);
    if (instanceId === undefined) {
      return 0;
    }
    const serviceKey = getServiceCacheKey(workspaceId, node.manifest.node_id, serviceId);
    const port = this.servicePorts.get(serviceKey);
    const processId = this.serviceProcesses.get(serviceKey);
    const connection = await this.client.connect(instanceId).catch(() => null);
    if (connection !== null) {
      if (port !== undefined) {
        await connection.unexposePort(port).catch(() => undefined);
      }
      if (processId !== undefined) {
        await connection.killProcess(processId).catch(() => undefined);
      }
      await connection.close().catch(() => undefined);
    }
    this.servicePorts.delete(serviceKey);
    this.serviceProcesses.delete(serviceKey);
    return port !== undefined || processId !== undefined ? 1 : 0;
  }

  private async ensureNodeConnection(
    workspaceId: string,
    node: StoredNode,
  ): Promise<{ connection: CloudflareSandboxConnection; reused: boolean }> {
    const cacheKey = getNodeCacheKey(workspaceId, node.manifest.node_id);
    const existingId = this.nodeInstances.get(cacheKey);
    if (existingId !== undefined) {
      return { connection: await this.client.connect(existingId), reused: true };
    }

    const connection = await this.client.create({
      workspace_id: workspaceId,
      sandbox_id: buildNodeSandboxId(workspaceId, node.manifest.node_id),
      cwd: "/workspace",
      metadata: buildNodeMetadata(workspaceId, node),
    });
    this.nodeInstances.set(cacheKey, connection.instance_id);
    return { connection, reused: false };
  }

  private async stageTaskArtifacts(connection: CloudflareSandboxConnection, taskPackage: TaskPackage): Promise<void> {
    const directoryPaths = new Set<string>();
    for (const artifact of taskPackage.artifacts) {
      const normalizedPath = toWorkspacePath(artifact.path);
      const directory = normalizedPath.split("/").slice(0, -1).join("/") || "/";
      if (directory !== "/") {
        directoryPaths.add(directory);
      }
    }

    if (directoryPaths.size > 0) {
      await connection.createDirectories([...directoryPaths].map((path) => ({ path })));
    }

    const textArtifacts = taskPackage.artifacts.filter((artifact) => artifact.text !== undefined);
    if (textArtifacts.length === 0) {
      return;
    }

    await connection.writeFiles(
      textArtifacts.map((artifact) => ({
        path: toWorkspacePath(artifact.path),
        data: artifact.text ?? "",
      })),
    );
  }

  private requireService(node: StoredNode, serviceId: string): NodeServiceDescriptor {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      throw new Error(`service ${serviceId} is not available on node ${node.manifest.node_id}`);
    }
    return service;
  }
}

const parseServiceCapability = (capability: string): NodeServiceDescriptor | null => {
  const [, serviceId, port] = capability.split(":");
  const targetPort = Number.parseInt(port ?? "", 10);
  if (!serviceId || !Number.isInteger(targetPort) || targetPort <= 0) {
    return null;
  }
  return {
    service_id: serviceId,
    label: serviceId,
    status: "ready",
    launchable: true,
    target_port: targetPort,
  };
};

const buildMetadata = (taskPackage: TaskPackage, workspaceId: string, role: "job"): Record<string, string> => ({
  or3_workspace_id: workspaceId,
  or3_role: role,
  or3_job_id: taskPackage.job_id,
});

const buildNodeMetadata = (workspaceId: string, node: StoredNode): Record<string, string> => ({
  or3_workspace_id: workspaceId,
  or3_role: "service",
  or3_node_id: node.manifest.node_id,
});

const buildJobSandboxId = (workspaceId: string, jobId: string): string =>
  `or3-job-${workspaceId}-${jobId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

const buildNodeSandboxId = (workspaceId: string, nodeId: string): string =>
  `or3-node-${workspaceId}-${nodeId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

const resolveServiceCommand = (service: NodeServiceDescriptor): string => {
  return `python3 -m http.server ${String(service.target_port)} --directory /workspace`;
};

const toWorkspacePath = (path: string): string => {
  if (path.startsWith("/")) {
    return path;
  }
  return `/workspace/${path.replace(/^\.\//, "")}`;
};

const getNodeCacheKey = (workspaceId: string, nodeId: string): string => `${workspaceId}:${nodeId}`;

const getServiceCacheKey = (workspaceId: string, nodeId: string, serviceId: string): string =>
  `${workspaceId}:${nodeId}:${serviceId}`;