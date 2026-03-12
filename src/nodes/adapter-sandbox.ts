import type { PreviewDescriptor, PreviewLaunchMetadata, TaskPackage } from "../contracts/index.ts";
import type { StoredNode } from "../db/index.ts";
import { WarmPoolManager } from "../scheduler/warmpool.ts";
import type { SandboxClient, SandboxInfo, SandboxTunnel } from "../../sdk/sandbox/index.ts";

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

export class SandboxNodeAdapter {
  private readonly executionWarmPool: WarmPoolManager;
  private readonly serviceWarmPool: WarmPoolManager;
  private readonly nodeSandboxes = new Map<string, SandboxInfo>();

  public constructor(private readonly sandboxClient: SandboxClient) {
    this.executionWarmPool = new WarmPoolManager(sandboxClient);
    this.serviceWarmPool = new WarmPoolManager(sandboxClient, { allowTunnels: true });
  }

  public async executeTask(workspaceId: string, taskPackage: TaskPackage): Promise<{ sandbox: SandboxInfo; exit_code: number }> {
    const sandbox = await this.executionWarmPool.acquire(workspaceId);
    try {
      for (const artifact of taskPackage.artifacts) {
        if (artifact.text !== undefined) {
          await this.sandboxClient.writeFile(sandbox.id, { path: artifact.path, content: artifact.text });
        }
      }
      const result = await this.sandboxClient.exec(sandbox.id, {
        command: ["sh", "-lc", taskPackage.instructions],
      });
      return { sandbox, exit_code: result.exit_code };
    } finally {
      await this.executionWarmPool.release(workspaceId, sandbox);
    }
  }

  public listServices(node: StoredNode): NodeServiceDescriptor[] {
    return node.manifest.capabilities
      .filter((capability) => capability.startsWith("service:"))
      .map(parseServiceCapability)
      .filter((service): service is NodeServiceDescriptor => service !== null);
  }

  public async prepareServiceLaunch(workspaceId: string, node: StoredNode, serviceId: string): Promise<InternalServiceLaunch> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      throw new Error(`service ${serviceId} is not available on node ${node.manifest.node_id}`);
    }

    const sandbox = await this.ensureNodeSandbox(workspaceId, node.manifest.node_id);
    const { tunnel, reused } = await this.ensureTunnel(sandbox.id, service.target_port);
    const signedUrl = await this.sandboxClient.createSignedTunnelUrl(tunnel.id, { path: "/" });
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

  public async restartService(workspaceId: string, node: StoredNode, serviceId: string): Promise<{ service_id: string; status: "ready" }> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      throw new Error(`service ${serviceId} is not available on node ${node.manifest.node_id}`);
    }

    const nodeKey = buildNodeKey(workspaceId, node.manifest.node_id);
    const existing = this.nodeSandboxes.get(nodeKey);
    if (existing !== undefined) {
      this.nodeSandboxes.delete(nodeKey);
      try {
        await this.sandboxClient.delete(existing.id);
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

  public async revokeServiceLaunch(workspaceId: string, node: StoredNode, serviceId: string): Promise<number> {
    const service = this.listServices(node).find((candidate) => candidate.service_id === serviceId);
    if (service === undefined) {
      return 0;
    }

    const sandbox = this.nodeSandboxes.get(buildNodeKey(workspaceId, node.manifest.node_id));
    if (sandbox === undefined) {
      return 0;
    }

    const tunnel = (await this.sandboxClient.listTunnels(sandbox.id)).find((candidate) => candidate.target_port === service.target_port);
    if (tunnel === undefined) {
      return 0;
    }

    await this.sandboxClient.revokeTunnel(tunnel.id);
    return 1;
  }

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

  private async ensureTunnel(sandboxId: string, targetPort: number): Promise<{ tunnel: SandboxTunnel; reused: boolean }> {
    const existing = (await this.sandboxClient.listTunnels(sandboxId)).find((tunnel) => tunnel.target_port === targetPort);
    if (existing !== undefined) {
      return { tunnel: existing, reused: true };
    }
    const tunnel = await this.sandboxClient.createTunnel(sandboxId, {
      target_port: targetPort,
      protocol: "http",
      auth_mode: "token",
      visibility: "private",
    });
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
