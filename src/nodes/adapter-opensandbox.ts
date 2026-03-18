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
import type { OpenSandboxClient, OpenSandboxConnection } from "../../sdk/opensandbox/types.ts";

export interface OpenSandboxNodeAdapterOptions {
  readonly defaultImage?: string;
  readonly defaultTimeoutSeconds?: number;
}

export class OpenSandboxNodeAdapter implements NodeExecutionAdapter {
  private readonly nodeInstances = new Map<string, string>();
  private readonly defaultImage: string;
  private readonly defaultTimeoutSeconds: number;

  public constructor(
    private readonly client: OpenSandboxClient,
    options: OpenSandboxNodeAdapterOptions = {},
  ) {
    this.defaultImage = options.defaultImage ?? client.config.defaultImage ?? "ubuntu";
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? client.config.defaultTimeoutSeconds ?? 600;
  }

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
      image: this.defaultImage,
      timeout_seconds: this.defaultTimeoutSeconds,
      metadata: buildMetadata(taskPackage, workspaceId, "job"),
      skip_health_check: true,
      entrypoint: ["tail", "-f", "/dev/null"],
    });

    try {
      await this.stageTaskArtifacts(connection, taskPackage);
      const result = await connection.runCommand(
        taskPackage.instructions,
        {
          cwd: "/workspace",
          timeout_ms: taskPackage.timeout.hard_ms ?? taskPackage.timeout.soft_ms,
          env: {},
        },
        {
          onStdout: (message) => onEvent?.({ event: "stdout", data: { chunk: message.text, instance_id: connection.instance_id } }),
          onStderr: (message) => onEvent?.({ event: "stderr", data: { chunk: message.text, instance_id: connection.instance_id } }),
          onResult: (resultEvent) => {
            const exitCode =
              typeof resultEvent["exit_code"] === "number"
                ? resultEvent["exit_code"]
                : typeof resultEvent["exitCode"] === "number"
                  ? resultEvent["exitCode"]
                  : 0;
            return onEvent?.({
              event: "result",
              data: {
                ...resultEvent,
                instance_id: connection.instance_id,
                exit_code: exitCode,
              },
            });
          },
          onError: (errorEvent) => onEvent?.({ event: "error", data: { ...errorEvent, instance_id: connection.instance_id } }),
        },
      );
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
    const endpoint = await connection.getEndpoint(service.target_port);
    await connection.close().catch(() => undefined);
    return {
      target_url: endpoint.url ?? `${this.client.config.protocol ?? "http"}://${endpoint.endpoint}`,
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
    this.requireService(node, serviceId);
    await this.disposeNodeConnection(workspaceId, node.manifest.node_id);
    const { connection } = await this.ensureNodeConnection(workspaceId, node);
    await connection.close().catch(() => undefined);
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
    return (await this.disposeNodeConnection(workspaceId, node.manifest.node_id)) ? 1 : 0;
  }

  private async ensureNodeConnection(
    workspaceId: string,
    node: StoredNode,
  ): Promise<{ connection: OpenSandboxConnection; reused: boolean }> {
    const cacheKey = getNodeCacheKey(workspaceId, node.manifest.node_id);
    const existingId = this.nodeInstances.get(cacheKey);
    if (existingId !== undefined) {
      return { connection: await this.client.connect(existingId), reused: true };
    }

    const connection = await this.client.create({
      workspace_id: workspaceId,
      image: this.defaultImage,
      timeout_seconds: this.defaultTimeoutSeconds,
      metadata: buildNodeMetadata(workspaceId, node),
      skip_health_check: true,
      entrypoint: ["tail", "-f", "/dev/null"],
    });
    this.nodeInstances.set(cacheKey, connection.instance_id);
    return { connection, reused: false };
  }

  private async disposeNodeConnection(workspaceId: string, nodeId: string): Promise<boolean> {
    const cacheKey = getNodeCacheKey(workspaceId, nodeId);
    const instanceId = this.nodeInstances.get(cacheKey);
    if (instanceId === undefined) {
      return false;
    }

    this.nodeInstances.delete(cacheKey);
    const connection = await this.client.connect(instanceId).catch(() => null);
    if (connection !== null) {
      await connection.kill().catch(() => undefined);
      await connection.close().catch(() => undefined);
      return true;
    }
    await this.client.kill(instanceId).catch(() => undefined);
    return true;
  }

  private async stageTaskArtifacts(connection: OpenSandboxConnection, taskPackage: TaskPackage): Promise<void> {
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

const toWorkspacePath = (path: string): string => {
  if (path.startsWith("/")) {
    return path;
  }
  return `/workspace/${path.replace(/^\.\//, "")}`;
};

const getNodeCacheKey = (workspaceId: string, nodeId: string): string => `${workspaceId}:${nodeId}`;
