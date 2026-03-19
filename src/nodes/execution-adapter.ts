import type { PreviewLaunchMetadata, TaskPackage } from "../contracts/index.ts";
import type { StoredNode } from "../db/index.ts";

export interface ProviderRequestContext {
  readonly requestId: string;
  readonly workspaceId: string;
}

export interface ProviderExecEvent {
  readonly event: "stdout" | "stderr" | "result" | "error";
  readonly data: Record<string, unknown>;
}

export interface NodeExecutionResult {
  readonly instance_id: string;
  readonly exit_code: number;
}

export interface NodeServiceDescriptor {
  readonly service_id: string;
  readonly label: string;
  readonly status: "ready" | "unknown";
  readonly launchable: boolean;
  readonly target_port: number;
}

export interface InternalServiceLaunch {
  readonly target_url: string;
  readonly delivery_mode: PreviewLaunchMetadata["delivery_mode"];
  readonly supports_iframe: boolean;
  readonly supports_new_tab: boolean;
  readonly reused_tunnel: boolean;
  readonly service_status: PreviewLaunchMetadata["service_status"];
  readonly expires_at: string;
}

export interface NodeExecutionAdapter {
  executeTask(workspaceId: string, taskPackage: TaskPackage): Promise<NodeExecutionResult>;
  executeTaskWithProgress(
    workspaceId: string,
    taskPackage: TaskPackage,
    onEvent?: (event: ProviderExecEvent) => Promise<void> | void,
  ): Promise<NodeExecutionResult>;
  listServices(node: StoredNode): NodeServiceDescriptor[];
  prepareServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<InternalServiceLaunch>;
  restartService(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<{ service_id: string; status: "ready" }>;
  revokeServiceLaunch(
    workspaceId: string,
    node: StoredNode,
    serviceId: string,
    requestContext?: ProviderRequestContext,
  ): Promise<number>;
}
