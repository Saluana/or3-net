/**
 * @module src/runtime/adapters/remote-node
 *
 * Purpose:
 * Runtime adapter that projects remote approved nodes into the generic runtime
 * adapter contract.
 */
import type {
  JobResult,
  NodeExecutionHandle,
  RemoteExecutionError,
  StoredNode,
  TaskPackage,
} from "../../index.ts";
import type {
  RuntimeAdapter,
  RuntimeAdapterManifest,
  RuntimeAdapterHealth,
  RuntimeAdapterSessionHandle,
  RuntimeCopyInInput,
  RuntimeCopyOutInput,
  RuntimeExecutionEvent,
  RuntimeExecutionHandle,
  RuntimeExecutionRequest,
  RuntimeFileTransferResult,
  RuntimeGetLogsInput,
  RuntimeLogsResult,
  RuntimeNodeDescriptor,
  RuntimeSessionCreateInput,
} from "../../contracts/runtime/index.ts";
import {
  RuntimeCapabilitySet,
  RuntimeError,
} from "../../contracts/runtime/index.ts";
import type { ControlPlaneDatabase } from "../../db/index.ts";
import { createId } from "../../lib/ids.ts";

/** Purpose: Required collaborating services for the remote-node runtime adapter. */
export interface RemoteNodeRuntimeAdapterDependencies {
  readonly database: ControlPlaneDatabase;
  readonly nodeRegistryService: { listNodes(workspaceId: string): StoredNode[] };
  readonly leaseScheduler: {
    issueLease(input: { workspace_id: string; job_id: string; task_package: TaskPackage }): { lease: { lease_id: string; node_id: string; state: string } };
    releaseLease(workspaceId: string, leaseId: string, state?: "released" | "expired" | "failed"): unknown;
  };
  readonly remoteNodeExecutor: {
    startExecution(node: StoredNode, taskPackage: TaskPackage): Promise<NodeExecutionHandle>;
    heartbeat(node: StoredNode): Promise<void>;
    canExecute?(node: StoredNode): boolean;
  };
}

const manifest: RuntimeAdapterManifest = {
  adapter_id: "remote-node-agent",
  display_name: "Remote Node Agent",
  version: "1.0.0",
  adapter_kind: "remote",
  isolation_class: "remote-node",
  trust_tier: "production",
  locality: "remote",
  capabilities: RuntimeCapabilitySet.fromValues(["exec"]),
  supported_presets: [],
  session_modes: ["ephemeral"],
};

/**
 * Purpose:
 * Adapter that delegates runtime execution to approved remote nodes via the
 * lease scheduler and remote node executor.
 */
export class RemoteNodeRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest = manifest;
  private readonly implementedCapabilities = this.manifest.capabilities;

  public constructor(private readonly dependencies: RemoteNodeRuntimeAdapterDependencies) {}

  public async health(input: { workspace_id?: string } = {}): Promise<RuntimeAdapterHealth> {
    const node = this.listApprovedRemoteNodes(input.workspace_id).find((candidate) => this.canExecute(candidate));
    if (node === undefined) {
      return { status: "unknown", checked_at: new Date().toISOString() };
    }
    try {
      await this.dependencies.remoteNodeExecutor.heartbeat(node);
      return { status: "healthy", checked_at: new Date().toISOString() };
    } catch (error: unknown) {
      throw mapRemoteError(error, "adapter_unavailable", { node_id: node.manifest.node_id });
    }
  }

  public listNodes(input: { workspace_id: string }): Promise<RuntimeNodeDescriptor[]> {
    return Promise.resolve(this.listApprovedRemoteNodes(input.workspace_id).map((node) => ({
      node_id: node.manifest.node_id,
      runtime_id: this.manifest.adapter_id,
      health: { status: mapNodeHealth(node.health_status), checked_at: node.last_seen_at ?? new Date().toISOString() },
      capabilities: this.implementedCapabilities,
      resource_limits: {
        max_concurrent_execs: node.manifest.resource_limits.max_concurrent_jobs,
        cpu_cores: node.manifest.resource_limits.cpu_cores,
        memory_mb: node.manifest.resource_limits.memory_mb,
        disk_mb: node.manifest.resource_limits.disk_mb,
      },
      locality: "remote",
    })));
  }

  public createSession(input: { workspace_id: string; session_id: string; config: RuntimeSessionCreateInput }): Promise<RuntimeAdapterSessionHandle> {
    const jobId = createId("rtjob");
    const taskPackage = buildTaskPackage(input.workspace_id, jobId, input.session_id, input.config, "pending");
    this.dependencies.database.workspace(input.workspace_id).saveJob({
      job: {
        job_id: jobId,
        workspace_id: input.workspace_id,
        status: "pending",
        created_at: new Date().toISOString(),
      },
      task_package: taskPackage,
    });

    try {
      const lease = this.dependencies.leaseScheduler.issueLease({
        workspace_id: input.workspace_id,
        job_id: jobId,
        task_package: taskPackage,
      });
      this.requireRemoteNode(input.workspace_id, lease.lease.node_id);
      return Promise.resolve({
        ref: lease.lease.lease_id,
        adapter_id: this.manifest.adapter_id,
        node_id: lease.lease.node_id,
        status: lease.lease.state === "active" ? "ready" : "creating",
        capabilities: this.implementedCapabilities,
      });
    } catch (error: unknown) {
      return Promise.reject(mapRemoteError(error, "adapter_unavailable", { workspace_id: input.workspace_id }));
    }
  }

  public getSession(input: { workspace_id: string; session_ref: string }): Promise<RuntimeAdapterSessionHandle | null> {
    try {
      const lease = this.dependencies.database.workspace(input.workspace_id).getLease(input.session_ref);
      this.requireRemoteNode(input.workspace_id, lease.lease.node_id);
      return Promise.resolve({
        ref: lease.lease.lease_id,
        adapter_id: this.manifest.adapter_id,
        node_id: lease.lease.node_id,
        status: lease.lease.state === "active" ? "ready" : "destroyed",
        capabilities: this.implementedCapabilities,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        return Promise.resolve(null);
      }
      return Promise.reject(mapRemoteError(error, "adapter_internal", { session_ref: input.session_ref }));
    }
  }

  public destroySession(input: { workspace_id: string; session_ref: string }): Promise<{ destroyed: boolean; message?: string }> {
    try {
      this.dependencies.leaseScheduler.releaseLease(input.workspace_id, input.session_ref, "released");
      return Promise.resolve({ destroyed: true });
    } catch (error: unknown) {
      return Promise.reject(mapRemoteError(error, "adapter_internal", { session_ref: input.session_ref }));
    }
  }

  public async exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    const lease = this.dependencies.database.workspace(input.workspace_id).getLease(input.session_ref);
    const node = this.requireRemoteNode(input.workspace_id, lease.lease.node_id);
    const taskPackage = buildExecTaskPackage(input.workspace_id, createId("rtjobexec"), node, input.request);
    try {
      const handle = await this.dependencies.remoteNodeExecutor.startExecution(node, taskPackage);
      return {
        execution_id: createId("rtexec"),
        ...(handle.stream === undefined ? {} : { stream: mapNodeStream(handle.stream) }),
        result: handle.result.then((result) => toRuntimeResult(result, input.session_ref)),
        abort: async () => {
          try {
            await handle.abort();
            return { acknowledged: true };
          } catch (error: unknown) {
            throw mapRemoteError(error, "adapter_internal", { node_id: node.manifest.node_id });
          }
        },
      };
    } catch (error: unknown) {
      throw mapRemoteError(error, "exec_failed", { node_id: node.manifest.node_id });
    }
  }

  public copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input;
    return Promise.reject(new RuntimeError("unsupported_capability", "remote runtime does not support copy-in"));
  }

  public copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input;
    return Promise.reject(new RuntimeError("unsupported_capability", "remote runtime does not support copy-out"));
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input;
    return Promise.reject(new RuntimeError("log_unavailable", "remote runtime logs are unavailable"));
  }

  private listApprovedRemoteNodes(workspaceId?: string): StoredNode[] {
    if (workspaceId === undefined) {
      return [];
    }
    return this.dependencies.nodeRegistryService
      .listNodes(workspaceId)
      .filter((node) => node.manifest.adapter_kind === "remote" && node.status === "approved");
  }

  private requireRemoteNode(workspaceId: string, nodeId: string): StoredNode {
    const node = this.listApprovedRemoteNodes(workspaceId).find((candidate) => candidate.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new RuntimeError("adapter_unavailable", `remote node ${nodeId} is not available`, {
        details: { workspace_id: workspaceId, node_id: nodeId },
      });
    }
    return node;
  }

  private canExecute(node: StoredNode): boolean {
    return this.dependencies.remoteNodeExecutor.canExecute?.(node) ?? true;
  }
}

const buildTaskPackage = (
  workspaceId: string,
  jobId: string,
  sessionId: string,
  config: RuntimeSessionCreateInput,
  kind: string,
): TaskPackage => ({
  workspace_id: workspaceId,
  job_id: jobId,
  kind,
  instructions: `runtime session ${sessionId}`,
  artifacts: [],
  tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
  timeout: {
    soft_ms: config.timeout_rules.soft_ms ?? 60_000,
    ...(config.timeout_rules.hard_ms === undefined ? {} : { hard_ms: config.timeout_rules.hard_ms }),
  },
  lease_profile: {
    profile_id: config.preset_id ?? "runtime-session",
    ttl_seconds: 300,
    required_capabilities: config.required_capabilities === undefined ? [] : [...config.required_capabilities],
  },
  subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
  metadata: { runtime_session: true, session_id: sessionId },
});

const buildExecTaskPackage = (
  workspaceId: string,
  jobId: string,
  node: StoredNode,
  request: RuntimeExecutionRequest,
): TaskPackage => ({
  workspace_id: workspaceId,
  job_id: jobId,
  kind: "runtime-exec",
  instructions: [request.command, ...request.args].join(" "),
  artifacts: [],
  tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
  timeout: {
    soft_ms: request.timeout_ms ?? 60_000,
  },
  lease_profile: {
    profile_id: "runtime-exec",
    ttl_seconds: 300,
    isolation_class: node.manifest.isolation_class,
    required_capabilities: ["exec"],
  },
  subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
  metadata: {
    runtime_exec: true,
    cwd: request.cwd ?? "",
    env: request.env,
    stdin: request.stdin ?? "",
  },
});

const mapNodeStream = async function* (
  stream: AsyncIterable<{ event: string; data: Record<string, unknown> }>,
): AsyncIterable<RuntimeExecutionEvent> {
  for await (const event of stream) {
    if (event.event === "text.delta" && typeof event.data["text"] === "string") {
      yield { type: "stdout", chunk: event.data["text"] };
    }
  }
};

const toRuntimeResult = (result: JobResult, sessionRef: string): {
  exit_code: number;
  stdout: string;
  stderr: string;
  artifacts: {
    artifact_id: string;
    session_id: string;
    path: string;
    kind: string;
    content_type: string;
    size_bytes: number;
    source: JobResult["meta"];
  }[];
  meta: JobResult["meta"];
} => ({
  exit_code: 0,
  stdout: result.output_text ?? "",
  stderr: "",
  artifacts: result.artifacts.map((artifact) => ({
    artifact_id: artifact.artifact_id,
    session_id: sessionRef,
    path: artifact.path,
    kind: artifact.kind,
    content_type: artifact.content_type,
    size_bytes: artifact.size_bytes,
    source: {},
  })),
  meta: result.meta,
});

const mapNodeHealth = (status: StoredNode["health_status"]): RuntimeAdapterHealth["status"] => {
  switch (status) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "stale":
      return "unavailable";
    default:
      return "unknown";
  }
};

const isRemoteExecutionError = (error: unknown): error is RemoteExecutionError =>
  error instanceof Error && error.name === "RemoteExecutionError";

const mapRemoteError = (error: unknown, fallbackCode: RuntimeError["code"], details: Record<string, unknown> = {}): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (isRemoteExecutionError(error)) {
    return new RuntimeError(
      fallbackCode === "adapter_unavailable" ? "adapter_unavailable" : fallbackCode,
      error.message,
      {
        retriable: true,
        details: { ...details, remote_code: error.code },
        cause: error,
      },
    );
  }
  return new RuntimeError(fallbackCode, error instanceof Error ? error.message : "remote runtime failed", {
    details,
    cause: error,
  });
};
