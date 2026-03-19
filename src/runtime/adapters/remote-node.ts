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
  RuntimeCapability,
  RuntimeCopyInInput,
  RuntimeCopyOutInput,
  RuntimeExecutionEvent,
  RuntimeExecutionHandle,
  RuntimeExecutionRequest,
  RuntimeFileTransferResult,
  RuntimeGetLogsInput,
  RuntimeLogsResult,
  RuntimePtyCloseInput,
  RuntimePtyCloseResult,
  RuntimePtyEvent,
  RuntimePtyOpenInput,
  RuntimePtyOpenResult,
  RuntimePtyResizeInput,
  RuntimePtyResizeResult,
  RuntimePtyStreamInput,
  RuntimePtyWriteInput,
  RuntimePtyWriteResult,
  RuntimeNodeDescriptor,
  RuntimeSessionCreateInput,
} from "../../contracts/runtime/index.ts";
import {
  RuntimeCapabilitySet,
  RuntimeError,
  runtimePtyCapability,
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
    sendRequest?(node: StoredNode, request: { id: string; method: string; params?: Record<string, unknown> }): Promise<{ id: string; result?: Record<string, unknown>; error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> } }>;
    sendStreamingRequest?(node: StoredNode, request: { id: string; method: string; params?: Record<string, unknown> }): Promise<{ response: Promise<{ id: string; result?: Record<string, unknown>; error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> } }>; stream: AsyncIterable<{ event: string; data: Record<string, unknown> }> }>;
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
  capabilities: RuntimeCapabilitySet.fromValues(["exec", runtimePtyCapability]),
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
  private readonly ptyStreams = new Map<string, AsyncIterable<RuntimePtyEvent>>();

  public constructor(private readonly dependencies: RemoteNodeRuntimeAdapterDependencies) {}

  /** Purpose: Derives the full capability set for a given node based on its manifest. */
  private nodeCapabilities(node: StoredNode): RuntimeCapabilitySet {
    const caps: RuntimeCapability[] = ["exec"];
    if (hasNodePtyCapability(node)) {
      caps.push(runtimePtyCapability);
    }
    if (node.manifest.capabilities.includes("file-read")) {
      caps.push("copy-out", "file-browse");
    }
    if (node.manifest.capabilities.includes("file-write")) {
      caps.push("copy-in");
    }
    if (node.manifest.capabilities.includes("file-read") && node.manifest.capabilities.includes("file-write")) {
      caps.push("file-rw");
    }
    return RuntimeCapabilitySet.fromValues(caps);
  }

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
      capabilities: this.nodeCapabilities(node),
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
      const node = this.requireRemoteNode(input.workspace_id, lease.lease.node_id);

      return this.sendRequestToNode(node, {
        id: createId("rpc"),
        method: "create_session",
        params: { session_id: input.session_id, workspace_id: input.workspace_id },
      }).then((response) => {
        if (response.error !== undefined) {
          throw new RuntimeError("adapter_internal", response.error.message, {
            retriable: response.error.retriable,
            details: { node_id: node.manifest.node_id, ...response.error.details },
          });
        }

        return {
          ref: lease.lease.lease_id,
          adapter_id: this.manifest.adapter_id,
          node_id: lease.lease.node_id,
          status: lease.lease.state === "active" ? "ready" : "creating",
          capabilities: this.nodeCapabilities(node),
        };
      });
    } catch (error: unknown) {
      return Promise.reject(mapRemoteError(error, "adapter_unavailable", { workspace_id: input.workspace_id }));
    }
  }

  public getSession(input: { workspace_id: string; session_ref: string }): Promise<RuntimeAdapterSessionHandle | null> {
    try {
      const lease = this.dependencies.database.workspace(input.workspace_id).getLease(input.session_ref);
      const node = this.requireRemoteNode(input.workspace_id, lease.lease.node_id);
      return Promise.resolve({
        ref: lease.lease.lease_id,
        adapter_id: this.manifest.adapter_id,
        node_id: lease.lease.node_id,
        status: lease.lease.state === "active" ? "ready" : "destroyed",
        capabilities: this.nodeCapabilities(node),
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
      const lease = this.dependencies.database.workspace(input.workspace_id).getLease(input.session_ref);
      const node = this.findRemoteNode(input.workspace_id, lease.lease.node_id);
      const agentSessionId = this.findAgentSessionId(input.workspace_id, input.session_ref) ?? input.session_ref;
      if (node !== undefined) {
        void this.trySendRequest(node, {
          id: createId("rpc"),
          method: "destroy_session",
          params: { session_id: agentSessionId },
        });
      }
      this.dependencies.leaseScheduler.releaseLease(input.workspace_id, input.session_ref, "released");
      return Promise.resolve({ destroyed: true });
    } catch (error: unknown) {
      return Promise.reject(mapRemoteError(error, "adapter_internal", { session_ref: input.session_ref }));
    }
  }

  public async exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    const lease = this.dependencies.database.workspace(input.workspace_id).getLease(input.session_ref);
    const node = this.requireRemoteNode(input.workspace_id, lease.lease.node_id);
    const taskPackage = buildExecTaskPackage(
      input.workspace_id,
      createId("rtjobexec"),
      node,
      input.request,
      this.findAgentSessionId(input.workspace_id, input.session_ref),
    );
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

  public async openPty(input: { workspace_id: string } & RuntimePtyOpenInput): Promise<RuntimePtyOpenResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (node === undefined) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    if (!hasNodePtyCapability(node)) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    const request = {
      id: createId("rpc"),
      method: "pty_open",
      params: {
        session_id: this.findAgentSessionId(input.workspace_id, input.session_ref) ?? input.session_ref,
        cols: input.cols,
        rows: input.rows,
        command: input.command,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
      },
    } satisfies { id: string; method: string; params: Record<string, unknown> };
    if (this.dependencies.remoteNodeExecutor.sendStreamingRequest === undefined) {
      throw new RuntimeError("adapter_unavailable", "PTY requires a streaming node transport", {
        details: { node_id: node.manifest.node_id },
      });
    }
    let streaming: Awaited<ReturnType<NonNullable<RemoteNodeRuntimeAdapterDependencies["remoteNodeExecutor"]["sendStreamingRequest"]>>>;
    try {
      streaming = await this.dependencies.remoteNodeExecutor.sendStreamingRequest(node, request);
    } catch (error: unknown) {
      throw mapRemoteError(error, "adapter_unavailable", { node_id: node.manifest.node_id });
    }
    const response = await streaming.response;
    if (response.error !== undefined) {
      throw new RuntimeError("adapter_internal", response.error.message, {
        retriable: response.error.retriable,
        details: { node_id: node.manifest.node_id, ...response.error.details },
      });
    }
    const meta = response.result?.["meta"];
    let ptyId: string | null = null;
    if (typeof meta === "object" && meta !== null) {
      const metaPtyId = (meta as Record<string, unknown>)["pty_id"];
      if (typeof metaPtyId === "string") {
        ptyId = metaPtyId;
      }
    }
    if (ptyId === null) {
      const resultPtyId = response.result?.["pty_id"];
      if (typeof resultPtyId === "string") {
        ptyId = resultPtyId;
      }
    }
    if (ptyId === null) {
      throw new RuntimeError("adapter_internal", "PTY open response missing pty_id", {
        details: { node_id: node.manifest.node_id },
      });
    }
    this.ptyStreams.set(
      buildPtyStreamKey(input.workspace_id, input.session_ref, ptyId),
      mapNodePtyStream(streaming.stream, ptyId),
    );
    return { pty_id: ptyId, session_ref: input.session_ref };
  }

  public streamPty(input: { workspace_id: string } & RuntimePtyStreamInput): Promise<AsyncIterable<RuntimePtyEvent>> {
    const key = buildPtyStreamKey(input.workspace_id, input.session_ref, input.pty_id);
    const stream = this.ptyStreams.get(key);
    if (stream === undefined) {
      throw new RuntimeError("adapter_internal", `PTY stream ${input.pty_id} is not available`, {
        details: { workspace_id: input.workspace_id, session_ref: input.session_ref, pty_id: input.pty_id },
      });
    }
    this.ptyStreams.delete(key);
    return Promise.resolve(stream);
  }

  public async writePty(input: { workspace_id: string } & RuntimePtyWriteInput): Promise<RuntimePtyWriteResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (node === undefined) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    if (!hasNodePtyCapability(node)) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    const response = await this.sendRequestToNode(node, {
      id: createId("rpc"),
      method: "pty_input",
      params: {
        pty_id: input.pty_id,
        data: input.data,
      },
    });
    if (response.error !== undefined) {
      throw new RuntimeError("adapter_internal", response.error.message, {
        retriable: response.error.retriable,
        details: { node_id: node.manifest.node_id, ...response.error.details },
      });
    }
    return { accepted: true };
  }

  public async resizePty(input: { workspace_id: string } & RuntimePtyResizeInput): Promise<RuntimePtyResizeResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (node === undefined) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    if (!hasNodePtyCapability(node)) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    const response = await this.sendRequestToNode(node, {
      id: createId("rpc"),
      method: "pty_resize",
      params: {
        session_id: this.findAgentSessionId(input.workspace_id, input.session_ref) ?? input.session_ref,
        pty_id: input.pty_id,
        cols: input.cols,
        rows: input.rows,
      },
    });
    if (response.error !== undefined) {
      throw new RuntimeError("adapter_internal", response.error.message, {
        retriable: response.error.retriable,
        details: { node_id: node.manifest.node_id, ...response.error.details },
      });
    }
    return { resized: true };
  }

  public async closePty(input: { workspace_id: string } & RuntimePtyCloseInput): Promise<RuntimePtyCloseResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (node === undefined) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    if (!hasNodePtyCapability(node)) {
      throw new RuntimeError("unsupported_capability", "remote runtime does not support PTY for this session");
    }
    const response = await this.sendRequestToNode(node, {
      id: createId("rpc"),
      method: "pty_close",
      params: {
        session_id: this.findAgentSessionId(input.workspace_id, input.session_ref) ?? input.session_ref,
        pty_id: input.pty_id,
      },
    });
    if (response.error !== undefined) {
      throw new RuntimeError("adapter_internal", response.error.message, {
        retriable: response.error.retriable,
        details: { node_id: node.manifest.node_id, ...response.error.details },
      });
    }
    return { closed: true };
  }

  public async copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (!node?.manifest.capabilities.includes("file-write")) {
      return Promise.reject(new RuntimeError("unsupported_capability", "remote runtime does not support copy-in for this node"));
    }
    try {
      const response = await this.sendRequestToNode(node, {
        id: createId("rpc"),
        method: "file_write",
        params: {
          path: input.destination_path,
          content_text: input.content_text,
          content_base64: input.content_base64,
          overwrite: input.overwrite,
        },
      });
      if (response.error !== undefined) {
        throw new RuntimeError("adapter_internal", response.error.message);
      }
      const meta = (response.result?.["meta"] ?? {}) as Record<string, unknown>;
      return {
        path: input.destination_path,
        bytes_transferred: typeof meta["bytes_transferred"] === "number" ? meta["bytes_transferred"] : 0,
      };
    } catch (error: unknown) {
      throw mapRemoteError(error, "adapter_internal", { session_ref: input.session_ref });
    }
  }

  public async copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (!node?.manifest.capabilities.includes("file-read")) {
      return Promise.reject(new RuntimeError("unsupported_capability", "remote runtime does not support copy-out for this node"));
    }
    try {
      const response = await this.sendRequestToNode(node, {
        id: createId("rpc"),
        method: "file_read",
        params: {
          path: input.source_path,
          encoding: input.encoding,
        },
      });
      if (response.error !== undefined) {
        throw new RuntimeError("adapter_internal", response.error.message);
      }
      const meta = (response.result?.["meta"] ?? {}) as Record<string, unknown>;
      return {
        path: input.source_path,
        bytes_transferred: typeof meta["size_bytes"] === "number" ? meta["size_bytes"] : 0,
        encoding: input.encoding,
        content_text: typeof response.result?.["output_text"] === "string" ? response.result["output_text"] : undefined,
        content_base64: typeof meta["content_base64"] === "string" ? meta["content_base64"] : undefined,
      };
    } catch (error: unknown) {
      throw mapRemoteError(error, "adapter_internal", { session_ref: input.session_ref });
    }
  }

  public async getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    const node = this.findNodeForSession(input.workspace_id, input.session_ref);
    if (node === undefined) {
      return { chunks: [] };
    }
    const agentSessionId = this.findAgentSessionId(input.workspace_id, input.session_ref);
    if (agentSessionId === undefined) {
      return { chunks: [] };
    }
    try {
      const response = await this.sendRequestToNode(node, {
        id: createId("rpc"),
        method: "get_logs",
        params: {
          session_id: agentSessionId,
          cursor: input.cursor,
          limit: input.limit,
        },
      });
      if (response.error !== undefined) {
        return { chunks: [] };
      }
      const meta = (response.result?.["meta"] ?? {}) as Record<string, unknown>;
      const chunks = Array.isArray(meta["chunks"]) ? meta["chunks"] as { stream: string; message: string; cursor?: string; created_at?: string }[] : [];
      const nextCursor = typeof meta["next_cursor"] === "string" ? meta["next_cursor"] : undefined;
      return {
        chunks: chunks.map((c) => ({
          stream:
            c.stream === "stderr"
              ? ("stderr" as const)
              : c.stream === "system"
                ? ("system" as const)
                : ("stdout" as const),
          message: c.message,
          cursor: c.cursor,
          created_at: c.created_at,
        })),
        next_cursor: nextCursor,
      };
    } catch {
      return { chunks: [] };
    }
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

  /** Purpose: Find a node by ID without throwing (returns undefined if missing). */
  private findRemoteNode(workspaceId: string, nodeId: string): StoredNode | undefined {
    return this.listApprovedRemoteNodes(workspaceId).find((candidate) => candidate.manifest.node_id === nodeId);
  }

  /** Purpose: Look up the node associated with a session/lease ref. Returns undefined if not found. */
  private findNodeForSession(workspaceId: string, sessionRef: string): StoredNode | undefined {
    try {
      const lease = this.dependencies.database.workspace(workspaceId).getLease(sessionRef);
      return this.findRemoteNode(workspaceId, lease.lease.node_id);
    } catch {
      return undefined;
    }
  }

  /** Purpose: Resolve the agent-facing session id from the lease-backed runtime session metadata. */
  private findAgentSessionId(workspaceId: string, sessionRef: string): string | undefined {
    try {
      const store = this.dependencies.database.workspace(workspaceId);
      const lease = store.getLease(sessionRef);
      const job = store.getJob(lease.job_id);
      const sessionId = job.task_package.metadata["session_id"];
      if (typeof sessionId === "string" && sessionId.length > 0) {
        return sessionId;
      }
      return sessionRef;
    } catch {
      return undefined;
    }
  }

  /** Purpose: Fire-and-forget RPC to a remote node. Swallows errors silently. */
  private async trySendRequest(node: StoredNode, request: { id: string; method: string; params?: Record<string, unknown> }): Promise<void> {
    try {
      await this.sendRequestToNode(node, request);
    } catch {
      // fire-and-forget: best-effort
    }
  }

  /** Purpose: Send an RPC request to a remote node, throws if transport is unavailable or returns error. */
  private async sendRequestToNode(
    node: StoredNode,
    request: { id: string; method: string; params?: Record<string, unknown> },
  ): Promise<{ id: string; result?: Record<string, unknown>; error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> } }> {
    const executor = this.dependencies.remoteNodeExecutor;
    if (executor.sendRequest === undefined) {
      throw new RuntimeError("adapter_internal", "transport does not support sendRequest");
    }
    return executor.sendRequest(node, request);
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
  sessionId?: string,
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
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    command: request.command,
    args: request.args,
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

const mapNodePtyStream = async function* (
  stream: AsyncIterable<{ event: string; data: Record<string, unknown> }>,
  expectedPtyId: string,
): AsyncIterable<RuntimePtyEvent> {
  for await (const event of stream) {
    if (event.event === "pty_output" && typeof event.data["pty_id"] === "string" && event.data["pty_id"] === expectedPtyId && typeof event.data["text"] === "string") {
      yield {
        event: "pty.output",
        data: {
          pty_id: expectedPtyId,
          text: event.data["text"],
        },
      };
      continue;
    }

    if (event.event === "pty_exit" && typeof event.data["pty_id"] === "string" && event.data["pty_id"] === expectedPtyId && typeof event.data["exit_code"] === "number") {
      yield {
        event: "pty.exit",
        data: {
          pty_id: expectedPtyId,
          exit_code: event.data["exit_code"],
          signal: typeof event.data["signal"] === "string" ? event.data["signal"] : null,
        },
      };
      return;
    }
  }
};

const buildPtyStreamKey = (workspaceId: string, sessionRef: string, ptyId: string): string =>
  `${workspaceId}:${sessionRef}:${ptyId}`;

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

const hasNodePtyCapability = (node: StoredNode): boolean =>
  node.manifest.capabilities.includes(runtimePtyCapability) || node.manifest.capabilities.includes("pty");
