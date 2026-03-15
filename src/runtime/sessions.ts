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
} from "../contracts/runtime/index.ts";
import { RuntimeError, runtimeErrorEnvelopeSchema } from "../contracts/runtime/index.ts";
import type { ControlPlaneDatabase, StoredRuntimeSession } from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import type { RuntimeSelectionService } from "./selection.ts";
import type { RuntimeRegistry } from "./registry.ts";

export interface RuntimeSessionListFilter {
  readonly status?: RuntimeSessionState;
  readonly adapter_id?: string;
  readonly limit?: number;
}

export interface RuntimeSessionReconciliationSummary {
  readonly recovered: number;
  readonly destroyed: number;
  readonly failed: number;
}

export class RuntimeSessionService {
  public constructor(
    private readonly registry: RuntimeRegistry,
    private readonly selection: RuntimeSelectionService,
    private readonly database: ControlPlaneDatabase,
  ) {}

  public async createSession(workspaceId: string, input: RuntimeSessionCreateInput): Promise<RuntimeSessionDescriptor> {
    const config = normalizeConfig(input);
    const requiredCapabilities = [...(config.required_capabilities ?? [])];
    const selected = await this.selection.select(workspaceId, {
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

    store.saveRuntimeSession({
      session_id: sessionId,
      adapter_id: selected.adapter.manifest.adapter_id,
      status: "creating",
      capabilities: initialCapabilities,
      config,
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
      const stored = store.touchRuntimeSession(sessionId, {
        adapter_session_ref: handle.ref,
        node_id: handle.node_id ?? selected.node?.node_id ?? null,
        status: handle.status,
        capabilities,
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

  public getSession(workspaceId: string, sessionId: string): RuntimeSessionDescriptor {
    return this.requireSession(workspaceId, sessionId).session;
  }

  public listSessions(workspaceId: string, filter: RuntimeSessionListFilter = {}): RuntimeSessionDescriptor[] {
    return this.database
      .workspace(workspaceId)
      .listRuntimeSessions(filter)
      .map((entry) => entry.session);
  }

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

    return updated.session;
  }

  public async getLogs(workspaceId: string, sessionId: string, input: Omit<RuntimeGetLogsInput, "session_ref">): Promise<RuntimeLogsResult> {
    const stored = this.requireSession(workspaceId, sessionId);
    const adapter = this.requireAdapter(stored.session.adapter_id);
    return await adapter.getLogs({
      workspace_id: workspaceId,
      session_ref: requireSessionRef(stored),
      ...input,
    });
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
}

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
