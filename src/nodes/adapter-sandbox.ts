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
  private readonly warmPool: WarmPoolManager;
  private readonly nodeSandboxes = new Map<string, SandboxInfo>();

  public constructor(private readonly sandboxClient: SandboxClient) {
    this.warmPool = new WarmPoolManager(sandboxClient);
  }

  public async executeTask(workspaceId: string, taskPackage: TaskPackage): Promise<{ sandbox: SandboxInfo; exit_code: number }> {
    const sandbox = await this.warmPool.acquire(workspaceId);
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
      await this.warmPool.release(workspaceId, sandbox);
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
    const tunnel = await this.ensureTunnel(sandbox.id, service.target_port);
    return {
      target_url: tunnel.url,
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: tunnel.state === "ready",
      service_status: "ready",
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
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

  private async ensureTunnel(sandboxId: string, targetPort: number): Promise<SandboxTunnel> {
    const existing = (await this.sandboxClient.listTunnels(sandboxId)).find((tunnel) => tunnel.target_port === targetPort);
    if (existing !== undefined) {
      return existing;
    }
    return this.sandboxClient.createTunnel(sandboxId, { target_port: targetPort, label: "service-launch" });
  }

  private async ensureNodeSandbox(workspaceId: string, nodeId: string): Promise<SandboxInfo> {
    const existing = this.nodeSandboxes.get(nodeId);
    if (existing !== undefined) {
      const retained = await this.warmPool.retainForNode(workspaceId, existing);
      this.nodeSandboxes.set(nodeId, retained);
      return retained;
    }

    const created = await this.warmPool.acquire(workspaceId);
    this.nodeSandboxes.set(nodeId, created);
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