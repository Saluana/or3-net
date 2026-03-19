/**
 * @module src/runtime/sessions
 *
 * Purpose:
 * Orchestrates runtime-session lifecycle, execution, and host-workspace staging
 * on top of the runtime adapter contract.
 *
 * Responsibilities:
 * - Select a runtime adapter and create sessions
 * - Persist session state and event history
 * - Proxy execution, file transfer, logs, and stop/destroy operations
 * - Coordinate host-workspace staging, commit, and discard flows
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  RuntimeAdapter,
  RuntimeCapability,
  RuntimeCopyInInput,
  RuntimeCopyOutInput,
  RuntimeFileTransferResult,
  RuntimeGetLogsInput,
  RuntimeLogsResult,
  RuntimeSessionCreateInput,
  RuntimeSessionDescriptor,
  RuntimeSessionState,
  RuntimeExecutionHandle,
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
  WorkspaceCommitResult,
} from "../contracts/runtime/index.ts";
import { RuntimeError, runtimeErrorEnvelopeSchema, runtimePtyCapability } from "../contracts/runtime/index.ts";
import type { ControlPlaneDatabase, StoredRuntimeSession } from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import type { RuntimeSelectionService } from "./selection.ts";
import type { RuntimeRegistry } from "./registry.ts";
import { resolveHostWorkspaceRoot } from "../workspace/host-staging.ts";
import {
  applyWorkspaceStageDiff,
  clearWorkspaceStage,
  createWorkspaceArchive,
  diffWorkspaceStage,
  ensureWorkspaceStageDir,
  extractWorkspaceArchive,
  readBaseManifest,
  resolveWithinRoot,
  reconstructExportFromFileApi,
  scanWorkspaceSelection,
  selectWorkspaceStageTransport,
  writeBaseManifest,
} from "./workspace-stage.ts";

/** Purpose: Filter options for listing runtime sessions. */
export interface RuntimeSessionListFilter {
  readonly status?: RuntimeSessionState;
  readonly adapter_id?: string;
  readonly limit?: number;
}

/** Purpose: Summary returned after startup runtime-session reconciliation. */
export interface RuntimeSessionReconciliationSummary {
  readonly recovered: number;
  readonly destroyed: number;
  readonly failed: number;
}

/** Purpose: Optional filesystem roots used by the runtime session service. */
export interface RuntimeSessionServiceOptions {
  readonly stagingBaseDir?: string;
  readonly hostWorkspaceBaseDir?: string;
}

/** Purpose: Workspace staging status summary for a runtime session. */
export interface RuntimeSessionStageStatus {
  readonly session_id: string;
  readonly staging_status: RuntimeSessionDescriptor["staging_status"];
  readonly host_workspace_root?: string;
  readonly workspace_stage_mode?: RuntimeSessionDescriptor["workspace_stage_mode"];
  readonly selected_paths: string[];
  readonly tracked_paths: string[];
  readonly last_commit?: WorkspaceCommitResult;
}

interface ArchiveWorkspaceStageAdapter {
  getWorkspaceStageTransportCapabilities?: () => { archive: boolean; file_api: boolean };
  importWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    archive_bytes: Uint8Array;
  }): Promise<{ bytes_transferred: number }>;
  exportWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    paths: string[];
  }): Promise<{ archive_bytes: Uint8Array; bytes_transferred: number }>;
}

/**
 * Purpose:
 * High-level service for runtime-session lifecycle and staged workspace flows.
 *
 * Constraints:
 * - Requires adapters to advertise capabilities explicitly
 * - Enforces single active read-write writer per host workspace root
 */
export class RuntimeSessionService {
  private readonly stagingBaseDir: string;
  private readonly hostWorkspaceBaseDir: string;
  private readonly activePtyMirrors = new Map<string, Promise<void>>();

  public constructor(
    private readonly registry: RuntimeRegistry,
    private readonly selection: RuntimeSelectionService,
    private readonly database: ControlPlaneDatabase,
    options: RuntimeSessionServiceOptions = {},
  ) {
    this.stagingBaseDir = options.stagingBaseDir ?? process.cwd();
    this.hostWorkspaceBaseDir = options.hostWorkspaceBaseDir ?? process.cwd();
  }

  /** Purpose: Selects an adapter and creates a persisted runtime session. */
  public async createSession(workspaceId: string, input: RuntimeSessionCreateInput): Promise<RuntimeSessionDescriptor> {
    const config = normalizeConfig(input);
    const requiredCapabilities = [...(config.required_capabilities ?? [])];
    const selected = await this.selection.select(workspaceId, {
      ...(config.adapter_id === undefined ? {} : { adapter_id: config.adapter_id }),
      required_capabilities: requiredCapabilities,
      ...(config.preset_id === undefined ? {} : { preset_id: config.preset_id }),
    });

    if (!hasAllCapabilities(selected.adapter.manifest.capabilities, requiredCapabilities)) {
      throw new RuntimeError("unsupported_capability", "selected adapter does not satisfy the requested capabilities", {
        details: {
          adapter_id: selected.adapter.manifest.adapter_id,
          required_capabilities: requiredCapabilities,
        },
      });
    }

    const sessionId = createId("rtsess");
    const store = this.database.workspace(workspaceId);
    const initialCapabilities = selected.node?.capabilities ?? selected.adapter.manifest.capabilities;
    const workspaceStage = config.workspace_stage;
    const hostWorkspaceRoot = workspaceStage === undefined ? undefined : this.resolveConfiguredHostWorkspaceRoot(workspaceId);

    if (workspaceStage?.mode === "read_write" && hostWorkspaceRoot !== undefined) {
      this.ensureNoActiveWriter(store.findActiveRuntimeStageWriter(hostWorkspaceRoot, sessionId), hostWorkspaceRoot);
    }

    store.saveRuntimeSession({
      session_id: sessionId,
      adapter_id: selected.adapter.manifest.adapter_id,
      status: "creating",
      capabilities: initialCapabilities,
      config,
      ...(hostWorkspaceRoot === undefined ? {} : { host_workspace_root: hostWorkspaceRoot }),
      ...(workspaceStage === undefined ? {} : { workspace_stage_mode: workspaceStage.mode, staging_status: "preparing" as const }),
      isolation_class: selected.adapter.manifest.isolation_class,
      trust_tier: selected.adapter.manifest.trust_tier,
      ...(selected.node?.node_id === undefined ? {} : { node_id: selected.node.node_id }),
      ...(config.preset_id === undefined ? {} : { preset_id: config.preset_id }),
    });
    store.appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "session.creating",
      payload: {
        adapter_id: selected.adapter.manifest.adapter_id,
        node_id: selected.node?.node_id ?? null,
      },
    });

    try {
      const handle = await selected.adapter.createSession({
        workspace_id: workspaceId,
        session_id: sessionId,
        config,
      });
      const capabilities = handle.capabilities.length > 0 ? handle.capabilities : initialCapabilities;
      if (workspaceStage !== undefined && hostWorkspaceRoot !== undefined) {
        const transport = await this.prepareWorkspaceStage({
          workspaceId,
          sessionId,
          adapter: selected.adapter,
          sessionRef: handle.ref,
          hostWorkspaceRoot,
          config,
        });
        store.touchRuntimeSession(sessionId, { workspace_stage_transport: transport });
      }
      const stored = store.touchRuntimeSession(sessionId, {
        adapter_session_ref: handle.ref,
        node_id: handle.node_id ?? selected.node?.node_id ?? null,
        status: handle.status,
        capabilities,
        ...(workspaceStage === undefined ? {} : { staging_status: handle.status === "ready" ? "ready" as const : "preparing" as const }),
        error: null,
      });
      store.appendRuntimeSessionEvent({
        session_id: sessionId,
        event_type: handle.status === "ready" ? "session.ready" : "session.creating",
        payload: {
          adapter_session_ref: handle.ref,
          node_id: handle.node_id ?? selected.node?.node_id ?? null,
          status: handle.status,
          capabilities: [...capabilities],
        },
      });
      return stored.session;
    } catch (error: unknown) {
      const runtimeError = normalizeRuntimeError(error, "adapter_internal", {
        adapter_id: selected.adapter.manifest.adapter_id,
        session_id: sessionId,
      });
      const envelope = runtimeErrorEnvelopeSchema.parse(runtimeError.toEnvelope());
      store.touchRuntimeSession(sessionId, {
        status: "failed",
        error: envelope,
      });
      store.appendRuntimeSessionEvent({
        session_id: sessionId,
        event_type: "session.failed",
        payload: {
          code: envelope.code,
          message: envelope.message,
          retriable: envelope.retriable,
        },
      });
      throw runtimeError;
    }
  }

  /** Purpose: Fetches a single runtime session descriptor. */
  public getSession(workspaceId: string, sessionId: string): RuntimeSessionDescriptor {
    return this.requireSession(workspaceId, sessionId).session;
  }

  /** Purpose: Lists runtime session descriptors for a workspace. */
  public listSessions(workspaceId: string, filter: RuntimeSessionListFilter = {}): RuntimeSessionDescriptor[] {
    return this.database
      .workspace(workspaceId)
      .listRuntimeSessions(filter)
      .map((entry) => entry.session);
  }

  /** Purpose: Executes a command inside an existing runtime session. */
  public async exec(workspaceId: string, sessionId: string, request: Parameters<RuntimeAdapter["exec"]>[0]["request"]): Promise<RuntimeExecutionHandle> {
    const stored = this.requireSession(workspaceId, sessionId);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    const sessionRef = requireSessionRef(stored);
    ensureReadySession(stored.session);
    ensureCapability(stored, "exec");

    const handle = await adapter.exec({
      workspace_id: workspaceId,
      session_ref: sessionRef,
      request,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "exec.started",
      payload: {
        execution_id: handle.execution_id,
        command: request.command,
        args: request.args,
      },
    });

    return {
      execution_id: handle.execution_id,
      ...(handle.stream === undefined ? {} : { stream: handle.stream }),
      abort: () => handle.abort(),
      result: handle.result
        .then((result) => {
          const store = this.database.workspace(workspaceId);
          for (const artifact of result.artifacts) {
            store.saveRuntimeArtifact({ artifact });
          }
          appendExecutionLogEvents(store, sessionId, handle.execution_id, result);
          store.appendRuntimeSessionEvent({
            session_id: sessionId,
            event_type: "exec.completed",
            payload: {
              execution_id: handle.execution_id,
              exit_code: result.exit_code,
              artifact_count: result.artifacts.length,
            },
          });
          return result;
        })
        .catch((error: unknown) => {
          const runtimeError = normalizeRuntimeError(error, "exec_failed", {
            execution_id: handle.execution_id,
            session_id: sessionId,
          });
          this.database.workspace(workspaceId).appendRuntimeSessionEvent({
            session_id: sessionId,
            event_type: "exec.failed",
            payload: {
              execution_id: handle.execution_id,
              code: runtimeError.code,
              message: runtimeError.message,
            },
          });
          throw runtimeError;
        }),
    };
  }

  /** Purpose: Requests that a runtime session transition into a stopped state. */
  public async stopSession(workspaceId: string, sessionId: string): Promise<RuntimeSessionDescriptor> {
    const stored = this.requireSession(workspaceId, sessionId);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    const sessionRef = requireSessionRef(stored);
    ensureCapability(stored, "stop");
    if (adapter.stop === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support stop`, {
        details: { adapter_id: stored.session.adapter_id, capability: "stop" },
      });
    }

    const result = await adapter.stop({ workspace_id: workspaceId, session_ref: sessionRef });
    const updated = this.database.workspace(workspaceId).touchRuntimeSession(sessionId, {
      status: result.status,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: result.status === "stopped" ? "session.stopped" : "session.stopping",
      payload: {
        stopped: result.stopped,
        status: result.status,
      },
    });
    return updated.session;
  }

  /** Purpose: Destroys a runtime session and clears any staged workspace state. */
  public async destroySession(workspaceId: string, sessionId: string): Promise<RuntimeSessionDescriptor> {
    const stored = this.requireSession(workspaceId, sessionId);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    const sessionRef = requireSessionRef(stored);
    let cleanupError: RuntimeError | null = null;

    try {
      await adapter.destroySession({ workspace_id: workspaceId, session_ref: sessionRef });
    } catch (error) {
      cleanupError = normalizeRuntimeError(error, "adapter_internal", {
        adapter_id: stored.session.adapter_id,
        session_id: sessionId,
      });
    }

    const destroyedAt = new Date().toISOString();
    const updated = this.database.workspace(workspaceId).touchRuntimeSession(sessionId, {
      status: "destroyed",
      destroyed_at: destroyedAt,
      ...(cleanupError === null ? {} : { error: cleanupError.toEnvelope() }),
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "session.destroyed",
      payload: {
        destroyed_at: destroyedAt,
        cleanup_error:
          cleanupError === null
            ? null
            : {
                code: cleanupError.code,
                message: cleanupError.message,
              },
      },
    });

    await clearWorkspaceStage(sessionId, this.stagingBaseDir);

    return updated.session;
  }

  public async commitWorkspaceStage(workspaceId: string, sessionId: string): Promise<WorkspaceCommitResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    const workspaceStage = stored.config?.workspace_stage;
    if (workspaceStage === undefined || stored.session.host_workspace_root === undefined) {
      throw new RuntimeError("policy_denied", `runtime session ${sessionId} does not have host workspace staging`, {
        details: { session_id: sessionId },
      });
    }
    if (workspaceStage.mode === "read_only") {
      throw new RuntimeError("read_only_commit_denied", `runtime session ${sessionId} is read-only`, {
        details: { session_id: sessionId },
      });
    }
    const hostWorkspaceRoot = stored.session.host_workspace_root;
    const store = this.database.workspace(workspaceId);
    store.touchRuntimeSession(sessionId, { staging_status: "committing" });
    const baseManifest = await readBaseManifest(sessionId, this.stagingBaseDir);
    const currentHostManifest = await scanWorkspaceSelection(hostWorkspaceRoot, baseManifest.selected_paths);
    const exportRoot = path.join(await ensureWorkspaceStageDir(sessionId, this.stagingBaseDir), "export");
    const exportedManifest = await this.exportWorkspaceStageSnapshot({
      workspaceId,
      sessionId,
      stored,
      baseManifest,
      exportRoot,
    });
    const diff = diffWorkspaceStage(baseManifest, currentHostManifest, exportedManifest);
    if (diff.conflict_paths.length > 0) {
      const result = {
        session_id: sessionId,
        status: "conflict",
        written_paths: [],
        deleted_paths: [],
        conflict_paths: diff.conflict_paths,
      } satisfies WorkspaceCommitResult;
      store.touchRuntimeSession(sessionId, { staging_status: "conflict", last_commit: result });
      throw new RuntimeError("stale_host_write_conflict", `host workspace changed for ${diff.conflict_paths.join(", ")}`, {
        details: { session_id: sessionId, conflict_paths: diff.conflict_paths },
      });
    }
    await applyWorkspaceStageDiff(hostWorkspaceRoot, exportRoot, diff, sessionId, this.stagingBaseDir);
    const result = {
      session_id: sessionId,
      status: "committed",
      written_paths: diff.written_paths,
      deleted_paths: diff.deleted_paths,
      conflict_paths: [],
    } satisfies WorkspaceCommitResult;
    store.touchRuntimeSession(sessionId, { staging_status: "committed", last_commit: result });
    store.appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "workspace.committed",
      payload: result,
    });
    return result;
  }

  public async discardWorkspaceStage(workspaceId: string, sessionId: string): Promise<RuntimeSessionDescriptor> {
    const stored = this.requireSession(workspaceId, sessionId);
    if (stored.config?.workspace_stage === undefined) {
      return stored.session;
    }
    await clearWorkspaceStage(sessionId, this.stagingBaseDir);
    const updated = this.database.workspace(workspaceId).touchRuntimeSession(sessionId, { staging_status: "discarded" });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "workspace.discarded",
      payload: { session_id: sessionId },
    });
    return updated.session;
  }

  public async getWorkspaceStageStatus(workspaceId: string, sessionId: string): Promise<RuntimeSessionStageStatus> {
    const stored = this.requireSession(workspaceId, sessionId);
    const manifest = stored.config?.workspace_stage === undefined ? null : await readBaseManifest(sessionId, this.stagingBaseDir);
    return {
      session_id: stored.session.session_id,
      staging_status: stored.session.staging_status,
      ...(stored.session.host_workspace_root === undefined ? {} : { host_workspace_root: stored.session.host_workspace_root }),
      ...(stored.session.workspace_stage_mode === undefined ? {} : { workspace_stage_mode: stored.session.workspace_stage_mode }),
      selected_paths: manifest?.selected_paths ?? [],
      tracked_paths: manifest?.entries.map((entry) => entry.path) ?? [],
      ...(stored.session.last_commit === undefined ? {} : { last_commit: stored.session.last_commit }),
    };
  }

  public async getLogs(workspaceId: string, sessionId: string, input: Omit<RuntimeGetLogsInput, "session_ref">): Promise<RuntimeLogsResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    const logs = await adapter.getLogs({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });

		if (logs.chunks.length > 0 || logs.next_cursor !== undefined) {
			return logs;
		}

		return synthesizeLogsFromEvents(this.database.workspace(workspaceId), sessionId, input);
  }

  public async copyIn(workspaceId: string, sessionId: string, input: Omit<RuntimeCopyInInput, "session_ref">): Promise<RuntimeFileTransferResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureCapability(stored, "copy-in");
    const adapter = this.requireAdapter(stored.session.adapter_id);
    return await adapter.copyIn({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
  }

  public async copyOut(workspaceId: string, sessionId: string, input: Omit<RuntimeCopyOutInput, "session_ref">): Promise<RuntimeFileTransferResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureCapability(stored, "copy-out");
    const adapter = this.requireAdapter(stored.session.adapter_id);
    return await adapter.copyOut({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
  }

  /** Purpose: Opens a PTY inside an existing runtime session. */
  public async openPty(workspaceId: string, sessionId: string, input: Omit<RuntimePtyOpenInput, "session_ref">): Promise<RuntimePtyOpenResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    ensureCapability(stored, runtimePtyCapability);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    if (adapter.openPty === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support PTY`, {
        details: { adapter_id: stored.session.adapter_id, capability: runtimePtyCapability },
      });
    }

    const result = await adapter.openPty({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "pty.opened",
      payload: {
        pty_id: result.pty_id,
        command: input.command ?? null,
      },
    });
    this.startPtyMirror(workspaceId, sessionId, stored, result.pty_id);
    return result;
  }

  /** Purpose: Sends input to a PTY inside an existing runtime session. */
  public async writePty(workspaceId: string, sessionId: string, input: Omit<RuntimePtyWriteInput, "session_ref">): Promise<RuntimePtyWriteResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    ensureCapability(stored, runtimePtyCapability);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    if (adapter.writePty === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support PTY`, {
        details: { adapter_id: stored.session.adapter_id, capability: runtimePtyCapability },
      });
    }

    const result = await adapter.writePty({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "pty.input",
      payload: {
        pty_id: input.pty_id,
        bytes: input.data.length,
      },
    });
    return result;
  }

  /** Purpose: Resizes a PTY inside an existing runtime session. */
  public async resizePty(workspaceId: string, sessionId: string, input: Omit<RuntimePtyResizeInput, "session_ref">): Promise<RuntimePtyResizeResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    ensureCapability(stored, runtimePtyCapability);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    if (adapter.resizePty === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support PTY`, {
        details: { adapter_id: stored.session.adapter_id, capability: runtimePtyCapability },
      });
    }

    const result = await adapter.resizePty({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "pty.resized",
      payload: {
        pty_id: input.pty_id,
        cols: input.cols,
        rows: input.rows,
      },
    });
    return result;
  }

  /** Purpose: Closes a PTY inside an existing runtime session. */
  public async closePty(workspaceId: string, sessionId: string, input: Omit<RuntimePtyCloseInput, "session_ref">): Promise<RuntimePtyCloseResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    ensureCapability(stored, runtimePtyCapability);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    if (adapter.closePty === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support PTY`, {
        details: { adapter_id: stored.session.adapter_id, capability: runtimePtyCapability },
      });
    }

    const result = await adapter.closePty({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
    this.database.workspace(workspaceId).appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "pty.closed",
      payload: {
        pty_id: input.pty_id,
      },
    });
    return result;
  }

  /** Purpose: Streams PTY events for an existing runtime session by tailing persisted session events. */
  public streamPty(workspaceId: string, sessionId: string, input: Omit<RuntimePtyStreamInput, "session_ref">): AsyncIterable<RuntimePtyEvent> {
    const stored = this.requireSession(workspaceId, sessionId);
    ensureReadySession(stored.session);
    ensureCapability(stored, runtimePtyCapability);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    if (adapter.streamPty === undefined) {
      throw new RuntimeError("unsupported_capability", `adapter ${stored.session.adapter_id} does not support PTY streaming`, {
        details: { adapter_id: stored.session.adapter_id, capability: runtimePtyCapability },
      });
    }

    return createRuntimePtyEventStream(this.database.workspace(workspaceId), sessionId, input.pty_id, input.cursor);
  }

  private startPtyMirror(workspaceId: string, sessionId: string, stored: StoredRuntimeSession, ptyId: string): void {
    const key = buildPtyMirrorKey(workspaceId, sessionId, ptyId);
    if (this.activePtyMirrors.has(key)) {
      return;
    }

    const adapter = this.requireAdapter(stored.session.adapter_id);
    const streamPty = adapter.streamPty?.bind(adapter);
    if (streamPty === undefined) {
      return;
    }

    const mirror = (async () => {
      try {
        const stream = await streamPty({
          workspace_id: workspaceId,
          session_ref: requireSessionRef(stored),
          pty_id: ptyId,
        });
        for await (const event of stream) {
          const store = this.database.workspace(workspaceId);
          if (event.event === "pty.output") {
            store.appendRuntimeSessionEvent({
              session_id: sessionId,
              event_type: "pty.output",
              payload: {
                pty_id: event.data.pty_id,
                text: event.data.text,
                created_at: event.data.created_at ?? null,
              },
            });
            continue;
          }

          store.appendRuntimeSessionEvent({
            session_id: sessionId,
            event_type: "pty.exit",
            payload: {
              pty_id: event.data.pty_id,
              exit_code: event.data.exit_code,
              signal: event.data.signal,
              created_at: event.data.created_at ?? null,
            },
          });
        }
      } catch (error: unknown) {
        this.database.workspace(workspaceId).appendRuntimeSessionEvent({
          session_id: sessionId,
          event_type: "pty.stream_failed",
          payload: {
            pty_id: ptyId,
            message: error instanceof Error ? error.message : "PTY stream failed",
          },
        });
      } finally {
        this.activePtyMirrors.delete(key);
      }
    })();

    this.activePtyMirrors.set(key, mirror);
  }

  public async reconcileOnStartup(): Promise<RuntimeSessionReconciliationSummary> {
    const summary = { recovered: 0, destroyed: 0, failed: 0 };

    for (const workspace of this.database.listWorkspaces()) {
      const store = this.database.workspace(workspace.workspace_id);
      const sessions = store
        .listRuntimeSessions({ limit: 500 })
        .filter((entry) => entry.session.status === "creating" || entry.session.status === "ready" || entry.session.status === "stopping");

      for (const entry of sessions) {
        const adapter = this.registry.get(entry.session.adapter_id);
        if (adapter === undefined) {
          markFailed(store, entry, new RuntimeError("adapter_unavailable", `runtime adapter ${entry.session.adapter_id} is not registered`), "session.reconciled.failed");
          summary.failed += 1;
          continue;
        }

        const health = await adapter.health({ workspace_id: workspace.workspace_id }).catch(() => ({
          status: "unavailable" as const,
          checked_at: new Date().toISOString(),
        }));
        if (health.status === "unavailable") {
          markFailed(store, entry, new RuntimeError("adapter_unavailable", `runtime adapter ${entry.session.adapter_id} is unavailable`, {
            retriable: true,
          }), "session.reconciled.failed");
          summary.failed += 1;
          continue;
        }

        if (adapter.getSession === undefined) {
          if (entry.session.status === "creating") {
            markFailed(store, entry, new RuntimeError("adapter_internal", `runtime adapter ${entry.session.adapter_id} cannot reconcile creating sessions`), "session.reconciled.failed");
            summary.failed += 1;
          }
          continue;
        }

        const sessionRef = entry.adapter_session_ref;
        if (sessionRef === null) {
          markFailed(store, entry, new RuntimeError("adapter_internal", "runtime session is missing adapter_session_ref"), "session.reconciled.failed");
          summary.failed += 1;
          continue;
        }

        const adapterSession = await adapter.getSession({
          workspace_id: workspace.workspace_id,
          session_ref: sessionRef,
        });

        if (adapterSession === null) {
          store.touchRuntimeSession(entry.session.session_id, {
            status: "destroyed",
            destroyed_at: new Date().toISOString(),
          });
          store.appendRuntimeSessionEvent({
            session_id: entry.session.session_id,
            event_type: "session.reconciled.destroyed",
            payload: { reason: "adapter_session_missing" },
          });
          summary.destroyed += 1;
          continue;
        }

        if (adapterSession.status !== entry.session.status) {
          store.touchRuntimeSession(entry.session.session_id, {
            status: adapterSession.status,
            node_id: adapterSession.node_id ?? null,
            capabilities: adapterSession.capabilities,
          });
          store.appendRuntimeSessionEvent({
            session_id: entry.session.session_id,
            event_type: "session.reconciled.recovered",
            payload: {
              status: adapterSession.status,
              node_id: adapterSession.node_id ?? null,
            },
          });
          summary.recovered += 1;
        }
      }

      for (const entry of store.listRuntimeSessions({ limit: 500 })) {
        if (entry.session.staging_status === "committing") {
          store.touchRuntimeSession(entry.session.session_id, { staging_status: "failed" });
        }
      }
    }

    return summary;
  }

  private requireSession(workspaceId: string, sessionId: string): StoredRuntimeSession {
    try {
      return this.database.workspace(workspaceId).getRuntimeSession(sessionId);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.toLowerCase().includes("not found")) {
        throw new RuntimeError("session_not_found", `runtime session ${sessionId} was not found`, {
          details: { workspace_id: workspaceId, session_id: sessionId },
          cause: error,
        });
      }
      throw error;
    }
  }

  private requireAdapter(adapterId: string): RuntimeAdapter {
    const adapter = this.registry.get(adapterId);
    if (adapter === undefined) {
      throw new RuntimeError("adapter_unavailable", `runtime adapter ${adapterId} is not registered`, {
        details: { adapter_id: adapterId },
      });
    }
    return adapter;
  }

  private resolveConfiguredHostWorkspaceRoot(workspaceId: string): string {
    const workspace = this.database.getWorkspace(workspaceId);
    const hostWorkspaceRoot = resolveHostWorkspaceRoot(workspace, { baseDir: this.hostWorkspaceBaseDir });
    if (hostWorkspaceRoot === null) {
      throw new RuntimeError("workspace_root_missing", `workspace ${workspaceId} does not have a configured host workspace root`, {
        details: { workspace_id: workspaceId },
      });
    }
    return hostWorkspaceRoot;
  }

  private ensureNoActiveWriter(activeWriter: StoredRuntimeSession | null, hostWorkspaceRoot: string): void {
    if (activeWriter !== null) {
      throw new RuntimeError("stale_host_write_conflict", `workspace ${hostWorkspaceRoot} already has an active read-write staged session`, {
        details: { workspace_session_id: activeWriter.session.session_id, host_workspace_root: hostWorkspaceRoot },
      });
    }
  }

  private collectTrackedFilePaths(manifest: Awaited<ReturnType<typeof readBaseManifest>>): string[] {
    return manifest.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  }

  private async prepareWorkspaceStage(input: {
    workspaceId: string;
    sessionId: string;
    adapter: RuntimeAdapter;
    sessionRef: string;
    hostWorkspaceRoot: string;
    config: RuntimeSessionCreateInput;
  }): Promise<"archive" | "file_api"> {
    const workspaceStage = input.config.workspace_stage;
    if (workspaceStage === undefined) {
      return "file_api";
    }
    const manifest = await scanWorkspaceSelection(input.hostWorkspaceRoot, workspaceStage.paths);
    await writeBaseManifest(input.sessionId, manifest, this.stagingBaseDir);
    const archiveAdapter = asArchiveWorkspaceStageAdapter(input.adapter);
    const transport = selectWorkspaceStageTransport(workspaceStage.transport, workspaceStage.paths, manifest, {
      archive: archiveAdapter?.getWorkspaceStageTransportCapabilities?.().archive ?? archiveAdapter !== null,
      file_api: true,
    });
    if (transport === "archive") {
      if (archiveAdapter === null) {
        throw new RuntimeError("unsupported_staging_transport", `transport ${transport} is not available for adapter ${input.adapter.manifest.adapter_id}`, {
          details: { adapter_id: input.adapter.manifest.adapter_id, transport },
        });
      }
      const stageDir = await ensureWorkspaceStageDir(input.sessionId, this.stagingBaseDir);
      const archivePath = path.join(stageDir, "workspace-import.tar.gz");
      await createWorkspaceArchive(input.hostWorkspaceRoot, manifest, archivePath);
      await archiveAdapter.importWorkspaceArchive({
        workspace_id: input.workspaceId,
        session_ref: input.sessionRef,
        archive_bytes: await fs.readFile(archivePath),
      });
      return transport;
    }
    for (const entry of manifest.entries) {
      if (entry.kind !== "file") {
        continue;
      }
      const content = await fs.readFile(resolveWithinRoot(input.hostWorkspaceRoot, entry.path), "utf8");
      await input.adapter.copyIn({
        workspace_id: input.workspaceId,
        session_ref: input.sessionRef,
        destination_path: `/${entry.path}`,
        content_text: content,
        overwrite: true,
      });
    }
    return transport;
  }

  private async exportWorkspaceStageSnapshot(input: {
    workspaceId: string;
    sessionId: string;
    stored: StoredRuntimeSession;
    baseManifest: Awaited<ReturnType<typeof readBaseManifest>>;
    exportRoot: string;
  }): Promise<Awaited<ReturnType<typeof scanWorkspaceSelection>>> {
    const adapter = this.requireAdapter(input.stored.session.adapter_id);
    const sessionRef = requireSessionRef(input.stored);
    const transport = input.stored.session.workspace_stage_transport ?? input.stored.config?.workspace_stage?.transport ?? "file_api";
    if (transport === "archive") {
      const archiveAdapter = asArchiveWorkspaceStageAdapter(adapter);
      if (archiveAdapter === null) {
        throw new RuntimeError("unsupported_staging_transport", `transport ${transport} is not available for adapter ${input.stored.session.adapter_id}`, {
          details: { adapter_id: input.stored.session.adapter_id, transport },
        });
      }
      const archivePath = path.join(await ensureWorkspaceStageDir(input.sessionId, this.stagingBaseDir), "workspace-export.tar.gz");
      const exportResult = await archiveAdapter.exportWorkspaceArchive({
        workspace_id: input.workspaceId,
        session_ref: sessionRef,
        paths: input.baseManifest.selected_paths,
      });
      await fs.writeFile(archivePath, exportResult.archive_bytes);
      await extractWorkspaceArchive(archivePath, input.exportRoot, { max_bytes: 64 * 1024 * 1024, max_files: 10_000 });
      return await scanWorkspaceSelection(input.exportRoot, input.baseManifest.selected_paths);
    }
    const trackedFiles = this.collectTrackedFilePaths(input.baseManifest);
    return await reconstructExportFromFileApi(input.exportRoot, trackedFiles, async (relativePath) => {
      try {
        const transfer = await this.copyOut(input.workspaceId, input.sessionId, { source_path: `/${relativePath}`, encoding: "text" });
        return transfer.content_text ?? null;
      } catch (error: unknown) {
        if (error instanceof RuntimeError && error.code === "copy_failed") {
          return null;
        }
        throw error;
      }
    });
  }
}

const asArchiveWorkspaceStageAdapter = (adapter: RuntimeAdapter): ArchiveWorkspaceStageAdapter | null =>
  "importWorkspaceArchive" in adapter && typeof adapter.importWorkspaceArchive === "function" &&
  "exportWorkspaceArchive" in adapter && typeof adapter.exportWorkspaceArchive === "function"
    ? (adapter as RuntimeAdapter & ArchiveWorkspaceStageAdapter)
    : null;

const normalizeConfig = (input: RuntimeSessionCreateInput): RuntimeSessionCreateInput => input;

const requireSessionRef = (stored: StoredRuntimeSession): string => {
  if (stored.adapter_session_ref === null) {
    throw new RuntimeError("adapter_internal", `runtime session ${stored.session.session_id} is missing an adapter session reference`, {
      details: { session_id: stored.session.session_id },
    });
  }
  return stored.adapter_session_ref;
};

const ensureReadySession = (session: RuntimeSessionDescriptor): void => {
  if (session.status === "destroyed") {
    throw new RuntimeError("session_destroyed", `runtime session ${session.session_id} is destroyed`, {
      details: { session_id: session.session_id },
    });
  }
  if (session.status !== "ready") {
    throw new RuntimeError("policy_denied", `runtime session ${session.session_id} is not ready`, {
      details: { session_id: session.session_id, status: session.status },
    });
  }
};

const ensureCapability = (stored: StoredRuntimeSession, capability: RuntimeCapability): void => {
  if (!stored.session.capabilities.includes(capability)) {
    throw new RuntimeError("unsupported_capability", `runtime session ${stored.session.session_id} does not support ${capability}`, {
      details: {
        session_id: stored.session.session_id,
        capability,
      },
    });
  }
};

const normalizeRuntimeError = (
  error: unknown,
  fallbackCode: RuntimeError["code"],
  details: Record<string, unknown> = {},
): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error;
  }

  return new RuntimeError(
    fallbackCode,
    error instanceof Error ? error.message : "runtime adapter operation failed",
    {
      details,
      cause: error,
      retriable: fallbackCode === "adapter_unavailable" || fallbackCode === "exec_timeout",
    },
  );
};

const hasAllCapabilities = (
  declaredCapabilities: { includes(capability: RuntimeCapability): boolean },
  requiredCapabilities: readonly RuntimeCapability[],
): boolean => requiredCapabilities.every((capability) => declaredCapabilities.includes(capability));

const appendExecutionLogEvents = (
  store: ReturnType<ControlPlaneDatabase["workspace"]>,
  sessionId: string,
  executionId: string,
  result: Awaited<RuntimeExecutionHandle["result"]>,
): void => {
  if (result.stdout !== "") {
    store.appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "log.stdout",
      payload: {
        execution_id: executionId,
        stream: "stdout",
        message: result.stdout,
      },
    });
  }

  if (result.stderr !== "") {
    store.appendRuntimeSessionEvent({
      session_id: sessionId,
      event_type: "log.stderr",
      payload: {
        execution_id: executionId,
        stream: "stderr",
        message: result.stderr,
      },
    });
  }
};

const synthesizeLogsFromEvents = (
  store: ReturnType<ControlPlaneDatabase["workspace"]>,
  sessionId: string,
  input: Omit<RuntimeGetLogsInput, "session_ref">,
): RuntimeLogsResult => {
  const cursorValue = input.cursor === undefined ? undefined : Number(input.cursor);
  const limit = input.limit ?? 100;
  const filteredEvents = store
    .listRuntimeSessionEvents(sessionId, Math.max(limit * 4, limit))
    .filter((event) => event.event_type === "log.stdout" || event.event_type === "log.stderr")
    .filter((event) => (cursorValue === undefined || Number.isNaN(cursorValue) ? true : event.sequence > cursorValue));

  const chunks = filteredEvents.slice(0, limit).flatMap((event) => {
    const payload = parseRuntimeSessionEventPayload(event.payload_json);
    const message = typeof payload["message"] === "string" ? payload["message"] : undefined;
    const stream = payload["stream"] === "stderr" ? "stderr" : payload["stream"] === "system" ? "system" : "stdout";
    if (message === undefined || message === "") {
      return [];
    }
    return [{
      stream,
      message,
      cursor: String(event.sequence),
      created_at: event.created_at,
    }] satisfies RuntimeLogsResult["chunks"];
  });

  const nextCursor = chunks.at(-1)?.cursor;
  return nextCursor === undefined ? { chunks } : { chunks, next_cursor: nextCursor };
};

const createRuntimePtyEventStream = (
  store: ReturnType<ControlPlaneDatabase["workspace"]>,
  sessionId: string,
  ptyId: string,
  cursor?: string,
): AsyncIterable<RuntimePtyEvent> => ({
  [Symbol.asyncIterator](): AsyncIterator<RuntimePtyEvent> {
    let nextCursor = Number.parseInt(cursor ?? "0", 10);
    if (!Number.isFinite(nextCursor)) {
      nextCursor = 0;
    }
    let finished = false;
    const pending: RuntimePtyEvent[] = [];

    return {
      next: async (): Promise<IteratorResult<RuntimePtyEvent>> => {
        for (;;) {
          const buffered = pending.shift();
          if (buffered !== undefined) {
            return { done: false, value: buffered };
          }

          if (finished) {
            return { done: true, value: undefined };
          }

          const events: RuntimePtyEvent[] = [];
          for (const event of store.listRuntimeSessionEvents(sessionId, 1000)) {
            if (event.sequence <= nextCursor) {
              continue;
            }
            if (event.event_type !== "pty.output" && event.event_type !== "pty.exit" && event.event_type !== "pty.stream_failed") {
              continue;
            }

            const payload = parseRuntimeSessionEventPayload(event.payload_json);
            if (payload["pty_id"] !== ptyId) {
              continue;
            }

            nextCursor = event.sequence;
            if (event.event_type === "pty.stream_failed") {
              finished = true;
              throw new RuntimeError(
                "adapter_unavailable",
                typeof payload["message"] === "string" ? payload["message"] : "PTY stream failed",
                { details: { pty_id: ptyId, session_id: sessionId } },
              );
            }
            if (event.event_type === "pty.output" && typeof payload["text"] === "string") {
              events.push({
                event: "pty.output",
                data: {
                  pty_id: ptyId,
                  text: payload["text"],
                  created_at: event.created_at,
                },
              });
              continue;
            }

            if (typeof payload["exit_code"] === "number") {
              finished = true;
              events.push({
                event: "pty.exit",
                data: {
                  pty_id: ptyId,
                  exit_code: payload["exit_code"],
                  signal: typeof payload["signal"] === "string" ? payload["signal"] : null,
                  created_at: event.created_at,
                },
              });
            }
          }

          if (events.length > 0) {
            pending.push(...events);
            const nextEvent = pending.shift();
            if (nextEvent !== undefined) {
              return { done: false, value: nextEvent };
            }
          }

          await Bun.sleep(50);
        }
      },
    };
  },
});

const buildPtyMirrorKey = (workspaceId: string, sessionId: string, ptyId: string): string =>
  `${workspaceId}:${sessionId}:${ptyId}`;

const parseRuntimeSessionEventPayload = (payloadJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const markFailed = (
  store: ReturnType<ControlPlaneDatabase["workspace"]>,
  entry: StoredRuntimeSession,
  error: RuntimeError,
  eventType: string,
): void => {
  store.touchRuntimeSession(entry.session.session_id, {
    status: "failed",
    error: error.toEnvelope(),
  });
  store.appendRuntimeSessionEvent({
    session_id: entry.session.session_id,
    event_type: eventType,
    payload: {
      code: error.code,
      message: error.message,
    },
  });
};
