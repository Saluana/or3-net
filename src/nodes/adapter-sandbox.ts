/**
 * @module src/nodes/adapter-sandbox
 *
 * Purpose:
 * Bridges sandbox runtime primitives into the higher-level node and preview
 * workflows used by OR3 Net service actions.
 */
import type { PreviewDescriptor, PreviewLaunchMetadata, TaskPackage } from "../contracts/index.ts";
import type { AuditContext } from "../contracts/platform/types.ts";
import type { StoredNode } from "../db/index.ts";
import { WarmPoolManager } from "../scheduler/warmpool.ts";
import type { SandboxClient, SandboxExecEvent, SandboxInfo, SandboxRequestContext, SandboxTunnel } from "../../sdk/sandbox/index.ts";

/** Purpose: Human-facing description of a service exposed by a sandbox-backed node. */
export interface NodeServiceDescriptor {
  readonly service_id: string;
  readonly label: string;
  readonly status: "ready" | "unknown";
  readonly launchable: boolean;
  readonly target_port: number;
}

interface InternalServiceLaunch {
  readonly target_url: string;
  readonly delivery_mode: PreviewLaunchMetadata["delivery_mode"];
  readonly supports_iframe: boolean;
  readonly supports_new_tab: boolean;
  readonly reused_tunnel: boolean;
  readonly service_status: PreviewLaunchMetadata["service_status"];
  readonly expires_at: string;
}

/**
 * Purpose:
 * Provides sandbox-backed execution and service-launch helpers for nodes that
 * map to ephemeral OR3 sandboxes.
 */
export class SandboxNodeAdapter {
  private readonly executionWarmPool: WarmPoolManager;
  private readonly serviceWarmPool: WarmPoolManager;
  private readonly nodeSandboxes = new Map<string, SandboxInfo>();

  public constructor(private readonly sandboxClient: SandboxClient) {
    this.executionWarmPool = new WarmPoolManager(sandboxClient);
    this.serviceWarmPool = new WarmPoolManager(sandboxClient, { allowTunnels: true });
  }

  /** Purpose: Executes a task and returns the sandbox plus final exit code. */
  public async executeTask(workspaceId: string, taskPackage: TaskPackage): Promise<{ sandbox: SandboxInfo; exit_code: number }> {
    return await this.executeTaskWithProgress(workspaceId, taskPackage);
  }

  /** Purpose: Executes a task while optionally streaming raw sandbox exec events. */
  public async executeTaskWithProgress(
    workspaceId: string,
    taskPackage: TaskPackage,
    onEvent?: (event: SandboxExecEvent) => Promise<void> | void,
  ): Promise<{ sandbox: SandboxInfo; exit_code: number }> {
    const requestContext = getSandboxRequestContext(taskPackage);
    const sandbox = await this.executionWarmPool.acquire(workspaceId);
    try {
      for (const artifact of taskPackage.artifacts) {
        if (artifact.text !== undefined) {
          await this.sandboxClient.writeFile(sandbox.id, { path: artifact.path, content: artifact.text }, requestContext);
        }
      }
      let exitCode: number | null = null;
      for await (const event of this.sandboxClient.execStream(
        sandbox.id,
        {
          command: ["sh", "-lc", taskPackage.instructions],
        },
        requestContext,
      )) {
        await onEvent?.({
          ...event,
          data: {
            ...event.data,
            sandbox_id: sandbox.id,
          },
        });
        if (event.event === "result" && typeof event.data["exit_code"] === "number") {
          exitCode = event.data["exit_code"];
        }
      }
      if (exitCode === null) {
        throw new Error("sandbox exec stream ended without exit code");
      }
      return { sandbox, exit_code: exitCode };
    } finally {
      await this.executionWarmPool.release(workspaceId, sandbox);
    }
  }

  /** Purpose: Lists service capabilities declared by a stored node manifest. */
  public listServices(node: StoredNode): NodeServiceDescriptor[] {
    return node.manifest.capabilities
      .filter((capability) => capability.startsWith("service:"))
      .map(parseServiceCapability)
      .filter((service): service is NodeServiceDescriptor => service !== null);
  }

  /** Purpose: Prepares a signed launch target for a node-owned service. */
  public async prepareServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: SandboxRequestContext,
  ): Promise<InternalServiceLaunch> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      throw new Error(`service ${serviceId} is not available on node ${node.manifest.node_id}`);
    }

    const sandbox = await this.ensureNodeSandbox(workspaceId, node.manifest.node_id);
    const { tunnel, reused } = await this.ensureTunnel(sandbox.id, service.target_port, requestContext);
    const signedUrl = await this.sandboxClient.createSignedTunnelUrl(tunnel.id, { path: "/" }, requestContext);
    return {
      target_url: signedUrl.url,
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: reused,
      service_status: "ready",
      expires_at: signedUrl.expires_at,
    };
  }

  /** Purpose: Restarts a node service by replacing its backing sandbox. */
  public async restartService(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: SandboxRequestContext,
  ): Promise<{ service_id: string; status: "ready" }> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      throw new Error(`service ${serviceId} is not available on node ${node.manifest.node_id}`);
    }

    const nodeKey = buildNodeKey(workspaceId, node.manifest.node_id);
    const existing = this.nodeSandboxes.get(nodeKey);
    if (existing !== undefined) {
      this.nodeSandboxes.delete(nodeKey);
      try {
        await this.sandboxClient.delete(existing.id, requestContext);
      } catch {
        // best effort restart cleanup
      }
    }

    const replacement = await this.serviceWarmPool.acquire(workspaceId);
    this.nodeSandboxes.set(nodeKey, replacement);
    return {
      service_id: service.service_id,
      status: "ready",
    };
  }

  /** Purpose: Revokes active launch access for a node-owned service tunnel. */
  public async revokeServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: SandboxRequestContext,
  ): Promise<number> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      return 0;
    }

    const sandbox = this.nodeSandboxes.get(buildNodeKey(workspaceId, node.manifest.node_id));
    if (sandbox === undefined) {
      return 0;
    }

    const tunnel = (await this.sandboxClient.listTunnels(sandbox.id, requestContext)).find((candidate) => candidate.target_port === service.target_port);
    if (tunnel === undefined) {
      return 0;
    }

    await this.sandboxClient.revokeTunnel(tunnel.id, requestContext);
    return 1;
  }

  /** Purpose: Builds a preview descriptor from a prepared launch capability. */
  public createPreviewDescriptor(workspaceId: string, node: StoredNode, launch: PreviewLaunchMetadata): PreviewDescriptor {
    return {
      preview_id: launch.preview_id,
      workspace_id: workspaceId,
      node_id: node.manifest.node_id,
      kind: "dashboard",
      delivery_mode: launch.delivery_mode,
      source_type: "live-service",
      service_id: "openclaw",
      status: "ready",
      launch_url: launch.launch_url,
      expires_at: launch.expires_at,
      supports_iframe: launch.supports_iframe,
      supports_new_tab: launch.supports_new_tab,
    };
  }

  private async ensureTunnel(
    sandboxId: string,
    targetPort: number,
    requestContext?: SandboxRequestContext,
  ): Promise<{ tunnel: SandboxTunnel; reused: boolean }> {
    const existing = (await this.sandboxClient.listTunnels(sandboxId, requestContext)).find((tunnel) => tunnel.target_port === targetPort);
    if (existing !== undefined) {
      return { tunnel: existing, reused: true };
    }
    const tunnel = await this.sandboxClient.createTunnel(
      sandboxId,
      {
        target_port: targetPort,
        protocol: "http",
        auth_mode: "token",
        visibility: "private",
      },
      requestContext,
    );
    return { tunnel, reused: false };
  }

  private async ensureNodeSandbox(workspaceId: string, nodeId: string): Promise<SandboxInfo> {
    const key = buildNodeKey(workspaceId, nodeId);
    const existing = this.nodeSandboxes.get(key);
    if (existing !== undefined) {
      const retained = await this.serviceWarmPool.retainForNode(workspaceId, existing);
      this.nodeSandboxes.set(key, retained);
      return retained;
    }

    const created = await this.serviceWarmPool.acquire(workspaceId);
    this.nodeSandboxes.set(key, created);
    return created;
  }
}

const parseServiceCapability = (capability: string): NodeServiceDescriptor | null => {
  const [, serviceId, portValue, ...labelParts] = capability.split(":");
  if (serviceId === undefined || portValue === undefined) {
    return null;
  }

  const targetPort = Number.parseInt(portValue, 10);
  if (!Number.isFinite(targetPort) || targetPort <= 0) {
    return null;
  }

  return {
    service_id: serviceId,
    label: labelParts.join(":") || serviceId,
    status: "ready",
    launchable: true,
    target_port: targetPort,
  };
};

const buildNodeKey = (workspaceId: string, nodeId: string): string => `${workspaceId}:${nodeId}`;

const getSandboxRequestContext = (taskPackage: TaskPackage): SandboxRequestContext | undefined => {
  const rawAuditContext = taskPackage.metadata["audit_context"];
  if (typeof rawAuditContext !== "object" || rawAuditContext === null) {
    return undefined;
  }

  const auditContext = rawAuditContext as Partial<AuditContext>;
  return {
    ...(typeof auditContext.request_id === "string" ? { requestId: auditContext.request_id } : {}),
    ...(typeof auditContext.workspace_id === "string" ? { workspaceId: auditContext.workspace_id } : {}),
  };
};
