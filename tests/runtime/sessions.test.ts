import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  RuntimeCapabilitySet,
  RuntimeError,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
  createControlPlaneDatabase,
} from "../../src/index.ts";
import { createWorkspaceArchive, ensureWorkspaceStageDir } from "../../src/runtime/workspace-stage.ts";
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
  public execResult = { exit_code: 0, stdout: "ok", stderr: "", artifacts: [], meta: {} };
  public logsResult: RuntimeLogsResult = { chunks: [{ stream: "stdout", message: "hello" }] };
  public readonly sessionFiles = new Map<string, Map<string, string>>();
  public readonly importedArchives = new Map<string, Uint8Array>();
  public readonly exportedArchives = new Map<string, Uint8Array>();
  public archiveEnabled = true;

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
    const ref = `fake-session-ref:${input.session_id}`;
    if (this.createError !== null) {
      return Promise.reject(this.createError);
    }
    this.sessionFiles.set(ref, new Map());
    return Promise.resolve({ ...this.createResult, ref });
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
      result: Promise.resolve(this.execResult),
      abort: () => Promise.resolve({ acknowledged: true }),
    });
  }

  public copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<{ path: string; bytes_transferred: number }> {
    const files = this.sessionFiles.get(input.session_ref) ?? new Map<string, string>();
    files.set(input.destination_path, input.content_text ?? "");
    this.sessionFiles.set(input.session_ref, files);
    return Promise.resolve({ path: input.destination_path, bytes_transferred: (input.content_text ?? "").length });
  }

  public copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<{ path: string; bytes_transferred: number; encoding: "text"; content_text: string }> {
    const files = this.sessionFiles.get(input.session_ref) ?? new Map<string, string>();
    const content = files.get(input.source_path) ?? "";
    return Promise.resolve({ path: input.source_path, bytes_transferred: content.length, encoding: "text", content_text: content });
  }

  public getWorkspaceStageTransportCapabilities(): { archive: boolean; file_api: boolean } {
    return { archive: this.archiveEnabled, file_api: true };
  }

  public importWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    archive_bytes: Uint8Array;
  }): Promise<{ bytes_transferred: number }> {
    void input.workspace_id;
    this.importedArchives.set(input.session_ref, input.archive_bytes);
    return Promise.resolve({ bytes_transferred: input.archive_bytes.byteLength });
  }

  public exportWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    paths: string[];
  }): Promise<{ archive_bytes: Uint8Array; bytes_transferred: number }> {
    void input.workspace_id;
    void input.paths;
    const archiveBytes = this.exportedArchives.get(input.session_ref) ?? new Uint8Array();
    return Promise.resolve({ archive_bytes: archiveBytes, bytes_transferred: archiveBytes.byteLength });
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input;
    return Promise.resolve(this.logsResult);
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
  let hostWorkspaceRoot: string;
  let stagingRoot: string;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    hostWorkspaceRoot = mkdtempSync(path.join(tmpdir(), "or3-net-stage-"));
    stagingRoot = mkdtempSync(path.join(tmpdir(), "or3-net-stage-data-"));
    writeFileSync(path.join(hostWorkspaceRoot, "notes.txt"), "hello", "utf8");
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test",
      created_at: "2024-01-01T00:00:00.000Z",
      config: {
        host_workspace: {
          root: hostWorkspaceRoot,
          enabled: true,
        },
      },
    });
    registry = new RuntimeRegistry();
    adapter = new FakeRuntimeAdapter();
    registry.register(adapter);
    selection = new RuntimeSelectionService(registry);
    service = new RuntimeSessionService(registry, selection, database, { stagingBaseDir: stagingRoot });
  });

  afterEach(() => {
    rmSync(hostWorkspaceRoot, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
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

  test("getLogs falls back to persisted exec output when adapter returns no logs", async () => {
    adapter.logsResult = { chunks: [] };
    adapter.execResult = { exit_code: 0, stdout: "stdout line", stderr: "stderr line", artifacts: [], meta: {} };

    const session = await service.createSession("ws_test", {
      workspace_mode: "none",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    await service.exec("ws_test", session.session_id, { command: "echo", args: [], env: {}, background: false }).then((handle) => handle.result);
    const logs = await service.getLogs("ws_test", session.session_id, { limit: 10 });

    expect(logs.chunks).toHaveLength(2);
    expect(logs.chunks[0]).toMatchObject({ stream: "stdout", message: "stdout line" });
    expect(logs.chunks[1]).toMatchObject({ stream: "stderr", message: "stderr line" });
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

  test("creates host-staged session and captures manifest metadata", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    expect(session.host_workspace_root).toBe(hostWorkspaceRoot);
    expect(session.workspace_stage_mode).toBe("read_write");
    expect(session.staging_status).toBe("ready");
    const staging = await service.getWorkspaceStageStatus("ws_test", session.session_id);
    expect(staging.selected_paths).toEqual(["notes.txt"]);
    expect(staging.tracked_paths).toEqual(["notes.txt"]);
  });

  test("uses archive transport for staged directories when adapter supports it", async () => {
    mkdirSync(path.join(hostWorkspaceRoot, "src"), { recursive: true });
    writeFileSync(path.join(hostWorkspaceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");

    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["src"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    expect(session.workspace_stage_transport).toBe("archive");
    expect(adapter.importedArchives.get(`fake-session-ref:${session.session_id}`)?.byteLength).toBeGreaterThan(0);

    const exportRoot = mkdtempSync(path.join(tmpdir(), "or3-net-export-"));
    try {
      const exportSourceRoot = path.join(exportRoot, "src");
      mkdirSync(exportSourceRoot, { recursive: true });
      writeFileSync(path.join(exportSourceRoot, "index.ts"), "export const ok = false;\n", "utf8");
      const archivePath = path.join(exportRoot, "workspace.tar.gz");
      await createWorkspaceArchive(exportRoot, {
        selected_paths: ["src"],
        entries: [
          {
            path: "src",
            kind: "directory",
            size_bytes: 0,
            modified_at: new Date().toISOString(),
          },
          {
            path: "src/index.ts",
            kind: "file",
            size_bytes: "export const ok = false;\n".length,
            modified_at: new Date().toISOString(),
          },
        ],
      }, archivePath);
      adapter.exportedArchives.set(`fake-session-ref:${session.session_id}`, await Bun.file(archivePath).bytes());
    } finally {
      rmSync(exportRoot, { recursive: true, force: true });
    }

    const result = await service.commitWorkspaceStage("ws_test", session.session_id);

    expect(result.status).toBe("committed");
    expect(result.written_paths).toEqual(["src/index.ts"]);
    expect(Bun.file(path.join(hostWorkspaceRoot, "src", "index.ts")).text()).resolves.toBe("export const ok = false;\n");
  });

  test("falls back to file_api when archive transport is unavailable", async () => {
    adapter.archiveEnabled = false;
    mkdirSync(path.join(hostWorkspaceRoot, "src"), { recursive: true });
    writeFileSync(path.join(hostWorkspaceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");

    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["src"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    expect(session.workspace_stage_transport).toBe("file_api");
    expect(adapter.importedArchives.has(`fake-session-ref:${session.session_id}`)).toBeFalse();
    const files = adapter.sessionFiles.get(`fake-session-ref:${session.session_id}`);
    expect(files?.get("/src/index.ts")).toBe("export const ok = true;\n");
  });

  test("rejects concurrent read-write staged session for same host root", async () => {
    await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    const error = await captureRuntimeError(
      service.createSession("ws_test", {
        workspace_stage: {
          source_kind: "host",
          paths: ["notes.txt"],
          mode: "read_write",
          transport: "auto",
        },
        workspace_mode: "read_write",
        network_policy: { internet_access: false, ingress: "none" },
        resource_hints: { metadata: {} },
        persistence_mode: "ephemeral",
        env_refs: [],
        secret_refs: [],
        timeout_rules: {},
        artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
      }),
    );

    expect(error.code).toBe("stale_host_write_conflict");
  });

  test("commit applies sandbox edits back to host workspace", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    const files = adapter.sessionFiles.get(`fake-session-ref:${session.session_id}`);
    files?.set("/notes.txt", "updated");
    const result = await service.commitWorkspaceStage("ws_test", session.session_id);

    expect(result.status).toBe("committed");
    expect(result.written_paths).toEqual(["notes.txt"]);
    expect(Bun.file(path.join(hostWorkspaceRoot, "notes.txt")).text()).resolves.toBe("updated");
  });

  test("commit rejects read-only staged sessions", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_only",
        transport: "auto",
      },
      workspace_mode: "read_only",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    const error = await captureRuntimeError(service.commitWorkspaceStage("ws_test", session.session_id));
    expect(error.code).toBe("read_only_commit_denied");
  });

  test("commit detects stale host conflicts", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    writeFileSync(path.join(hostWorkspaceRoot, "notes.txt"), "host-change", "utf8");
    const files = adapter.sessionFiles.get(`fake-session-ref:${session.session_id}`);
    files?.set("/notes.txt", "sandbox-change");

    const error = await captureRuntimeError(service.commitWorkspaceStage("ws_test", session.session_id));
    expect(error.code).toBe("stale_host_write_conflict");
  });

  test("commit rejects destroyed staged sessions", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    await service.destroySession("ws_test", session.session_id);

    const error = await captureRuntimeError(service.commitWorkspaceStage("ws_test", session.session_id));
    expect(error.code).toBe("session_destroyed");
  });

  test("status rejects corrupted persisted base manifest", async () => {
    const session = await service.createSession("ws_test", {
      workspace_stage: {
        source_kind: "host",
        paths: ["notes.txt"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    const stageDir = await ensureWorkspaceStageDir(session.session_id, stagingRoot);
    writeFileSync(path.join(stageDir, "base-manifest.json"), JSON.stringify({ selected_paths: "broken", entries: [] }), "utf8");

    let threw = false;
    try {
      await service.getWorkspaceStageStatus("ws_test", session.session_id);
    } catch (error: unknown) {
      threw = true;
      expect(error).toBeInstanceOf(Error);
    }

    expect(threw).toBeTrue();
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
