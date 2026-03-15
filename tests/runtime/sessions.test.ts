import { beforeEach, describe, expect, test } from "bun:test";

import {
  RuntimeCapabilitySet,
  RuntimeError,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
  createControlPlaneDatabase,
} from "../../src/index.ts";
import type {
  RuntimeAdapter,
  RuntimeAdapterHealth,
  RuntimeAdapterManifest,
  RuntimeAdapterSessionHandle,
  RuntimeCopyInInput,
  RuntimeCopyOutInput,
  RuntimeExecutionHandle,
  RuntimeExecutionRequest,
  RuntimeGetLogsInput,
  RuntimeLogsResult,
  RuntimeNodeDescriptor,
  RuntimeSessionCreateInput,
  RuntimeSessionState,
} from "../../src/index.ts";

class FakeRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest: RuntimeAdapterManifest = {
    adapter_id: "fake",
    display_name: "Fake",
    version: "1.0.0",
    adapter_kind: "sandbox",
    isolation_class: "container",
    trust_tier: "development",
    locality: "local",
    capabilities: RuntimeCapabilitySet.fromValues(["exec", "copy-in", "copy-out", "stop"]),
    supported_presets: ["python"],
    session_modes: ["ephemeral"],
  };

  public createResult: RuntimeAdapterSessionHandle = {
    ref: "fake-session-ref",
    adapter_id: "fake",
    status: "ready",
    capabilities: RuntimeCapabilitySet.fromValues(["exec", "copy-in", "copy-out", "stop"]),
  };
  public createError: Error | null = null;
  public destroyError: Error | null = null;
  public getSessionResult: RuntimeAdapterSessionHandle | null = {
    ref: "fake-session-ref",
    adapter_id: "fake",
    status: "ready",
    capabilities: RuntimeCapabilitySet.fromValues(["exec", "copy-in", "copy-out", "stop"]),
  };
  public stopResult: { stopped: boolean; status: RuntimeSessionState } = { stopped: true, status: "stopped" };

  public health(): Promise<RuntimeAdapterHealth> {
    return Promise.resolve({ status: "healthy", checked_at: new Date().toISOString() });
  }

  public listNodes(): Promise<RuntimeNodeDescriptor[]> {
    return Promise.resolve([
      {
        node_id: "node_1",
        runtime_id: "fake",
        health: { status: "healthy", checked_at: new Date().toISOString() },
        capabilities: RuntimeCapabilitySet.fromValues(["exec", "copy-in", "copy-out", "stop"]),
        resource_limits: { max_concurrent_execs: 1 },
        locality: "local",
      },
    ]);
  }

  public createSession(input: { workspace_id: string; session_id: string; config: RuntimeSessionCreateInput }): Promise<RuntimeAdapterSessionHandle> {
    void input;
    if (this.createError !== null) {
      return Promise.reject(this.createError);
    }
    return Promise.resolve(this.createResult);
  }

  public getSession(): Promise<RuntimeAdapterSessionHandle | null> {
    return Promise.resolve(this.getSessionResult);
  }

  public destroySession(): Promise<{ destroyed: boolean; message?: string }> {
    if (this.destroyError !== null) {
      return Promise.reject(this.destroyError);
    }
    return Promise.resolve({ destroyed: true });
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    void input;
    return Promise.resolve({
      execution_id: "exec_1",
      result: Promise.resolve({ exit_code: 0, stdout: "ok", stderr: "", artifacts: [], meta: {} }),
      abort: () => Promise.resolve({ acknowledged: true }),
    });
  }

  public copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<{ path: string; bytes_transferred: number }> {
    void input;
    return Promise.resolve({ path: "/tmp/out.txt", bytes_transferred: 2 });
  }

  public copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<{ path: string; bytes_transferred: number; encoding: "text"; content_text: string }> {
    void input;
    return Promise.resolve({ path: "/tmp/out.txt", bytes_transferred: 2, encoding: "text", content_text: "ok" });
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input;
    return Promise.resolve({ chunks: [{ stream: "stdout", message: "hello" }] });
  }

  public stop(): Promise<{ stopped: boolean; status: RuntimeSessionState }> {
    return Promise.resolve(this.stopResult);
  }
}

describe("runtime session service", () => {
  let database = createControlPlaneDatabase();
  let registry: RuntimeRegistry;
  let selection: RuntimeSelectionService;
  let adapter: FakeRuntimeAdapter;
  let service: RuntimeSessionService;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    registry = new RuntimeRegistry();
    adapter = new FakeRuntimeAdapter();
    registry.register(adapter);
    selection = new RuntimeSelectionService(registry);
    service = new RuntimeSessionService(registry, selection, database);
  });

  test("create session happy path through mock adapter", async () => {
    const session = await service.createSession("ws_test", {
      preset_id: "python",
      required_capabilities: RuntimeCapabilitySet.fromValues(["exec"]),
      workspace_mode: "none",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    expect(session.status).toBe("ready");
    expect(session.adapter_id).toBe("fake");
    expect(database.workspace("ws_test").listRuntimeSessions()).toHaveLength(1);
    expect(database.workspace("ws_test").listRuntimeSessionEvents(session.session_id)).toHaveLength(2);
  });

  test("create session preserves creating status when adapter returns creating", async () => {
    adapter.createResult = {
      ...adapter.createResult,
      status: "creating",
    };

    const session = await service.createSession("ws_test", {
      preset_id: "python",
      required_capabilities: RuntimeCapabilitySet.fromValues(["exec"]),
      workspace_mode: "none",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    const events = database.workspace("ws_test").listRuntimeSessionEvents(session.session_id);
    expect(session.status).toBe("creating");
    expect(events.map((event) => event.event_type)).toEqual(["session.creating", "session.creating"]);
    expect(events.at(-1)?.payload_json).toContain("\"status\":\"creating\"");
  });

  test("create session failure marks DB as failed", async () => {
    adapter.createError = new RuntimeError("adapter_unavailable", "sandbox down");

    const error = await captureRuntimeError(
      service.createSession("ws_test", {
        workspace_mode: "none",
        network_policy: { internet_access: false, ingress: "none" },
        resource_hints: { metadata: {} },
        persistence_mode: "ephemeral",
        env_refs: [],
        secret_refs: [],
        timeout_rules: {},
        artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
      }),
    );
    expect(error.code).toBe("adapter_unavailable");

    const [stored] = database.workspace("ws_test").listRuntimeSessions({ status: "failed" });
    expect(stored?.session.error?.code).toBe("adapter_unavailable");
  });

  test("exec on non-ready session is rejected", async () => {
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_1",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "creating",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
    });

    const error = await captureRuntimeError(
      service.exec("ws_test", "sess_1", { command: "echo", args: [], env: {}, background: false }),
    );
    expect(error.code).toBe("policy_denied");
  });

  test("exec on session without exec capability is rejected", async () => {
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_2",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: [],
      isolation_class: "container",
      trust_tier: "development",
    });

    const error = await captureRuntimeError(
      service.exec("ws_test", "sess_2", { command: "echo", args: [], env: {}, background: false }),
    );
    expect(error.code).toBe("unsupported_capability");
  });

  test("unsupported capability returns unsupported_capability error", async () => {
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_3",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
    });

    const error = await captureRuntimeError(
      service.copyIn("ws_test", "sess_3", { destination_path: "/tmp/test.txt", content_text: "hi", overwrite: true }),
    );
    expect(error.code).toBe("unsupported_capability");
  });

  test("destroy always persists even when adapter throws", async () => {
    adapter.destroyError = new Error("cleanup failed");
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_4",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
    });

    const destroyed = await service.destroySession("ws_test", "sess_4");
    const events = database.workspace("ws_test").listRuntimeSessionEvents("sess_4");

    expect(destroyed.status).toBe("destroyed");
    expect(events.at(-1)?.payload_json).toContain("cleanup_error");
  });

  test("stop session preserves stopping status when adapter returns stopping", async () => {
    adapter.stopResult = { stopped: false, status: "stopping" };
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_stop",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: ["exec", "stop"],
      isolation_class: "container",
      trust_tier: "development",
    });

    const stopped = await service.stopSession("ws_test", "sess_stop");
    const events = database.workspace("ws_test").listRuntimeSessionEvents("sess_stop");

    expect(stopped.status).toBe("stopping");
    expect(events.at(-1)?.event_type).toBe("session.stopping");
    expect(events.at(-1)?.payload_json).toContain("\"status\":\"stopping\"");
  });

  test("restart reconciliation marks orphaned sessions", async () => {
    adapter.getSessionResult = null;
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_5",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
    });

    const summary = await service.reconcileOnStartup();
    const stored = database.workspace("ws_test").getRuntimeSession("sess_5");

    expect(summary.destroyed).toBe(1);
    expect(stored.session.status).toBe("destroyed");
  });

  test("session listing with status filter", () => {
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_ready",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
    });
    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_failed",
      adapter_id: "fake",
      adapter_session_ref: "fake-session-ref",
      status: "failed",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
      error: { code: "adapter_internal", message: "failed", retriable: false, details: {} },
    });

    const ready = service.listSessions("ws_test", { status: "ready" });
    expect(ready.map((session) => session.session_id)).toEqual(["sess_ready"]);
  });
});

const captureRuntimeError = async (promise: Promise<unknown>): Promise<RuntimeError> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) {
      return error;
    }
    throw error;
  }

  throw new Error("expected promise to reject with RuntimeError");
};
