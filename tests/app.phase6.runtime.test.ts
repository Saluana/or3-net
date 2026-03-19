import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SessionProofValidator } from "../src/auth/service.ts";
import { issueWorkspaceToken } from "../src/auth/tokens.ts";
import {
  AuthService,
  createControlPlaneDatabase,
  handleAppRequest,
  LocalJobService,
  Or3NetApp,
  RuntimeCapabilitySet,
  RuntimeError,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
  runtimePtyCapability,
} from "../src/index.ts";
import type {
  RuntimeAdapter,
  RuntimeAdapterHealth,
  RuntimeAdapterManifest,
  RuntimeAdapterSessionHandle,
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
} from "../src/contracts/runtime/index.ts";
import type {
  InternAbortResponse,
  InternClient,
  InternJobEvent,
  InternSubagentRequest,
  InternSubagentResponse,
  InternTurnRequest,
  InternTurnResponse,
} from "../sdk/intern/index.ts";

class StaticSessionProofValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read", "jobs:write", "sessions:read"],
    });
  }
}

class FakeInternClient implements InternClient {
  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    void request;
    return Promise.resolve({ job_id: "job_sync", status: "completed", final_text: "ok" });
  }

  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    void request;
    await Promise.resolve();
    yield { event: "completion", data: { job_id: "job_stream", status: "completed", final_text: "ok" } };
  }

  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    void request;
    return Promise.resolve({ job_id: "subagent_1", child_session_key: "svc:child", status: "queued" });
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "queued", data: { job_id: jobId, status: "queued" } };
  }

  public abortJob(jobId: string): Promise<InternAbortResponse> {
    return Promise.resolve({ ok: true, job_id: jobId, status: "aborted" });
  }
}

class FakeRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest: RuntimeAdapterManifest;
  public readonly files = new Map<string, Map<string, string>>();
  public lastLogsInput: ({ workspace_id: string } & RuntimeGetLogsInput) | null = null;
  public lastPtyOpenInput: ({ workspace_id: string } & RuntimePtyOpenInput) | null = null;
  public lastPtyWriteInput: ({ workspace_id: string } & RuntimePtyWriteInput) | null = null;
  public lastPtyResizeInput: ({ workspace_id: string } & RuntimePtyResizeInput) | null = null;
  public lastPtyCloseInput: ({ workspace_id: string } & RuntimePtyCloseInput) | null = null;
  public ptyStreamEvents: RuntimePtyEvent[] = [
    { event: "pty.output", data: { pty_id: "pty_placeholder", text: "hello from pty" } },
    { event: "pty.exit", data: { pty_id: "pty_placeholder", exit_code: 0, signal: null } },
  ];
  private readonly states = new Map<string, RuntimeAdapterSessionHandle["status"]>();
  private readonly ptySessions = new Map<string, string>();

  public constructor(capabilities: string[]) {
    this.manifest = {
      adapter_id: capabilities.includes("copy-in") ? "fake-runtime" : "limited-runtime",
      display_name: capabilities.includes("copy-in") ? "Fake Runtime" : "Limited Runtime",
      version: "1.0.0",
      adapter_kind: "local",
      isolation_class: "container",
      trust_tier: "development",
      locality: "local",
      capabilities: RuntimeCapabilitySet.fromValues(capabilities),
      supported_presets: [],
      session_modes: ["ephemeral"],
    };
  }

  public health(): Promise<RuntimeAdapterHealth> {
    return Promise.resolve({ status: "healthy", checked_at: new Date().toISOString() });
  }

  public listNodes(input: { workspace_id: string }): Promise<RuntimeNodeDescriptor[]> {
    void input;
    return Promise.resolve([
      {
        node_id: `${this.manifest.adapter_id}-node`,
        runtime_id: this.manifest.adapter_id,
        health: { status: "healthy", checked_at: new Date().toISOString() },
        capabilities: this.manifest.capabilities,
        resource_limits: { max_concurrent_execs: 4, cpu_cores: 2, memory_mb: 1024 },
        locality: "local",
      },
    ]);
  }

  public createSession(input: {
    workspace_id: string;
    session_id: string;
    config: RuntimeSessionCreateInput;
  }): Promise<RuntimeAdapterSessionHandle> {
    void input.workspace_id;
    void input.config;
    const ref = `${this.manifest.adapter_id}:${input.session_id}`;
    this.files.set(ref, new Map());
    this.states.set(ref, "ready");
    return Promise.resolve({
      ref,
      adapter_id: this.manifest.adapter_id,
      node_id: `${this.manifest.adapter_id}-node`,
      status: "ready",
      capabilities: this.manifest.capabilities,
    });
  }

  public getSession(input: { workspace_id: string; session_ref: string }): Promise<RuntimeAdapterSessionHandle | null> {
    void input.workspace_id;
    const status = this.states.get(input.session_ref);
    if (status === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ref: input.session_ref,
      adapter_id: this.manifest.adapter_id,
      node_id: `${this.manifest.adapter_id}-node`,
      status,
      capabilities: this.manifest.capabilities,
    });
  }

  public destroySession(input: { workspace_id: string; session_ref: string }): Promise<{ destroyed: boolean; message?: string }> {
    void input.workspace_id;
    this.states.set(input.session_ref, "destroyed");
    return Promise.resolve({ destroyed: true });
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    void input.workspace_id;
    const text = [input.request.command, ...input.request.args].join(" ");
    const stream: AsyncIterable<RuntimeExecutionEvent> = {
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimeExecutionEvent> {
        await Promise.resolve();
        yield { type: "stdout", chunk: text };
        yield { type: "exit", exit_code: 0 };
      },
    };
    return Promise.resolve({
      execution_id: `exec_${input.session_ref}`,
      stream,
      result: Promise.resolve({
        exit_code: 0,
        stdout: text,
        stderr: "",
        artifacts: [],
        meta: {},
      }),
      abort: () => Promise.resolve({ acknowledged: false, message: "not supported" }),
    });
  }

  public openPty(input: { workspace_id: string } & RuntimePtyOpenInput): Promise<RuntimePtyOpenResult> {
    void input.workspace_id;
    this.lastPtyOpenInput = input;
    const ptyId = `pty_${input.session_ref}`;
    this.ptySessions.set(input.session_ref, ptyId);
    return Promise.resolve({ pty_id: ptyId, session_ref: input.session_ref });
  }

  public writePty(input: { workspace_id: string } & RuntimePtyWriteInput): Promise<RuntimePtyWriteResult> {
    void input.workspace_id;
    this.lastPtyWriteInput = input;
    return Promise.resolve({ accepted: true });
  }

  public resizePty(input: { workspace_id: string } & RuntimePtyResizeInput): Promise<RuntimePtyResizeResult> {
    void input.workspace_id;
    this.lastPtyResizeInput = input;
    return Promise.resolve({ resized: true });
  }

  public closePty(input: { workspace_id: string } & RuntimePtyCloseInput): Promise<RuntimePtyCloseResult> {
    void input.workspace_id;
    this.lastPtyCloseInput = input;
    this.ptySessions.delete(input.session_ref);
    return Promise.resolve({ closed: true });
  }

  public streamPty(input: { workspace_id: string } & RuntimePtyStreamInput): Promise<AsyncIterable<RuntimePtyEvent>> {
    void input.workspace_id;
    const events = this.ptyStreamEvents.map((event) => ({
      event: event.event,
      data: {
        ...event.data,
        pty_id: input.pty_id,
      },
    })) as RuntimePtyEvent[];
    return Promise.resolve({
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimePtyEvent> {
        for (const event of events) {
          await Promise.resolve();
          yield event;
        }
      },
    });
  }

  public copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    const sessionFiles = this.files.get(input.session_ref);
    if (sessionFiles === undefined) {
      return Promise.reject(new RuntimeError("session_not_found", "missing session"));
    }
    const content = input.content_text ?? "";
    sessionFiles.set(input.destination_path, content);
    return Promise.resolve({ path: input.destination_path, bytes_transferred: content.length });
  }

  public copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    const sessionFiles = this.files.get(input.session_ref);
    const content = sessionFiles?.get(input.source_path) ?? "";
    return Promise.resolve({
      path: input.source_path,
      bytes_transferred: content.length,
      encoding: "text",
      content_text: content,
    });
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    this.lastLogsInput = input;
    return Promise.resolve({
      chunks: [{ stream: "stdout", message: `logs:${input.session_ref}` }],
    });
  }

  public stop(input: { workspace_id: string; session_ref: string }): Promise<{ stopped: boolean; status: "stopped" }> {
    void input.workspace_id;
    this.states.set(input.session_ref, "stopped");
    return Promise.resolve({ stopped: true, status: "stopped" });
  }
}

describe("phase 6 runtime api", () => {
  let database = createControlPlaneDatabase();
  let authService: AuthService;
  let app: Or3NetApp;
  let hostWorkspaceRoot: string;
  let stagingRoot: string;
  let runtimeAdapter: FakeRuntimeAdapter;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    hostWorkspaceRoot = mkdtempSync(path.join(tmpdir(), "or3-net-app-stage-"));
    stagingRoot = mkdtempSync(path.join(tmpdir(), "or3-net-phase6-stage-"));
    writeFileSync(path.join(hostWorkspaceRoot, "notes.txt"), "hello", "utf8");
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
      config: {
        host_workspace: {
          root: hostWorkspaceRoot,
          enabled: true,
        },
      },
    });

    authService = new AuthService({
      secret: "phase6-secret",
      database,
      sessionProofValidator: new StaticSessionProofValidator(),
    });

    runtimeAdapter = new FakeRuntimeAdapter(["exec", "stop", "copy-in", "copy-out", "log-stream"]);
    app = createRuntimeApp({ adapter: runtimeAdapter });
  });

  afterEach(() => {
    database.close();
    rmSync(hostWorkspaceRoot, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  test("all runtime routes require authentication", async () => {
    const requests = [
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes/fake-runtime"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes/fake-runtime/nodes"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/exec", { method: "POST", body: JSON.stringify({ command: "echo", args: [], env: {}, background: false }), headers: { "Content-Type": "application/json" } }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/stop", { method: "POST" }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/destroy", { method: "POST" }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/commit", { method: "POST" }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/discard", { method: "POST" }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/staging"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/logs"),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/files:copy-in", { method: "POST", body: JSON.stringify({ destination_path: "/tmp/x", content_text: "hi" }), headers: { "Content-Type": "application/json" } }),
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/sess_1/files:copy-out", { method: "POST", body: JSON.stringify({ source_path: "/tmp/x", encoding: "text" }), headers: { "Content-Type": "application/json" } }),
    ];

    for (const request of requests) {
      const response = await handleAppRequest(app, request);
      expect(response.status).toBe(401);
    }
  });

  test("enforces runtimes and runtime-session scopes", async () => {
    const runtimesReadToken = await createToken(["runtimes:read"]);
    const runtimeSessionsReadToken = await createToken(["runtime-sessions:read"]);

    const catalogResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes", {
        headers: { Authorization: `Bearer ${runtimesReadToken}` },
      }),
    );
    expect(catalogResponse.status).toBe(200);

    const createDenied = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtimeSessionsReadToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(createDenied.status).toBe(403);

    const runtimeDenied = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes", {
        headers: { Authorization: `Bearer ${runtimeSessionsReadToken}` },
      }),
    );
    expect(runtimeDenied.status).toBe(403);
  });

  test("supports runtime session lifecycle routes", async () => {
    const token = await createToken(["runtimes:read", "runtime-sessions:read", "runtime-sessions:write"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as { session: { session_id: string; status: string } };
    const sessionId = createPayload.session.session_id;
    expect(createPayload.session.status).toBe("ready");

    const listRuntimesResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes", { headers: authHeaders }),
    );
    const runtimesPayload = (await listRuntimesResponse.json()) as { items: { adapter_id: string }[] };
    expect(runtimesPayload.items.map((item) => item.adapter_id)).toContain("fake-runtime");

    const getRuntimeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes/fake-runtime", { headers: authHeaders }),
    );
    expect(getRuntimeResponse.status).toBe(200);

    const listNodesResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes/fake-runtime/nodes", { headers: authHeaders }),
    );
    const nodesPayload = (await listNodesResponse.json()) as { items: { node_id: string }[] };
    expect(nodesPayload.items[0]?.node_id).toBe("fake-runtime-node");

    const listSessionsResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", { headers: authHeaders }),
    );
    const listSessionsPayload = (await listSessionsResponse.json()) as { items: { session_id: string }[] };
    expect(listSessionsPayload.items.map((item) => item.session_id)).toContain(sessionId);

    const getSessionResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}`, { headers: authHeaders }),
    );
    expect(getSessionResponse.status).toBe(200);

    const execResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/exec`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo", args: ["hello"], env: {}, background: false }),
      }),
    );
    const execPayload = (await execResponse.json()) as { result: { stdout: string } };
    expect(execPayload.result.stdout).toBe("echo hello");

    const logsResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/logs?limit=999999`, { headers: authHeaders }),
    );
    const logsPayload = (await logsResponse.json()) as { chunks: { message: string }[] };
    expect(logsPayload.chunks[0]?.message).toContain(sessionId);
    expect(runtimeAdapter.lastLogsInput?.limit).toBe(500);

    const copyInResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/files:copy-in`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ destination_path: "/tmp/test.txt", content_text: "hello" }),
      }),
    );
    const copyInPayload = (await copyInResponse.json()) as { transfer: { bytes_transferred: number } };
    expect(copyInPayload.transfer.bytes_transferred).toBe(5);

    const copyOutResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/files:copy-out`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ source_path: "/tmp/test.txt", encoding: "text" }),
      }),
    );
    const copyOutPayload = (await copyOutResponse.json()) as { transfer: { content_text: string } };
    expect(copyOutPayload.transfer.content_text).toBe("hello");

    const stopResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/stop`, {
        method: "POST",
        headers: authHeaders,
      }),
    );
    const stopPayload = (await stopResponse.json()) as { session: { status: string } };
    expect(stopPayload.session.status).toBe("stopped");

    const destroyResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/destroy`, {
        method: "POST",
        headers: authHeaders,
      }),
    );
    const destroyPayload = (await destroyResponse.json()) as { session: { status: string } };
    expect(destroyPayload.session.status).toBe("destroyed");
  });

  test("supports runtime session PTY routes", async () => {
    runtimeAdapter = new FakeRuntimeAdapter(["exec", runtimePtyCapability]);
    app = createRuntimeApp({ adapter: runtimeAdapter });
    const token = await createToken(["runtimes:read", "runtime-sessions:read", "runtime-sessions:write"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ required_capabilities: [runtimePtyCapability] }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as { session: { session_id: string } };
    const sessionId = createPayload.session.session_id;

    const openResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/pty`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24, command: "bash", args: ["-l"], env: {}, cwd: "/workspace" }),
      }),
    );
    expect(openResponse.status).toBe(201);
    const openPayload = (await openResponse.json()) as { pty: { pty_id: string; session_ref: string } };
    expect(openPayload.pty.session_ref).toContain(sessionId);

    const writeResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/pty/${openPayload.pty.pty_id}/write`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "echo hello\n" }),
      }),
    );
    expect(writeResponse.status).toBe(200);

    const resizeResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/pty/${openPayload.pty.pty_id}/resize`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 100, rows: 40 }),
      }),
    );
    expect(resizeResponse.status).toBe(200);

    const closeResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/pty/${openPayload.pty.pty_id}/close`, {
        method: "POST",
        headers: authHeaders,
      }),
    );
    expect(closeResponse.status).toBe(200);

    expect(runtimeAdapter.lastPtyOpenInput?.command).toBe("bash");
    expect(runtimeAdapter.lastPtyWriteInput?.data).toBe("echo hello\n");
    expect(runtimeAdapter.lastPtyResizeInput?.cols).toBe(100);
    expect(runtimeAdapter.lastPtyCloseInput?.pty_id).toBe(openPayload.pty.pty_id);

    await Bun.sleep(10);
    const streamResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/pty/${openPayload.pty.pty_id}/stream`, {
        headers: { ...authHeaders, Accept: "text/event-stream" },
      }),
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("Content-Type")).toContain("text/event-stream");
    const streamText = await streamResponse.text();
    expect(streamText).toContain("event: pty.output");
    expect(streamText).toContain("hello from pty");
    expect(streamText).toContain("event: pty.exit");
  });

  test("supports staged runtime session commit, discard, and status routes", async () => {
    const token = await createToken(["runtime-sessions:read", "runtime-sessions:write"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_stage: {
            source_kind: "host",
            paths: ["notes.txt"],
            mode: "read_write",
            transport: "auto",
          },
          workspace_mode: "read_write",
        }),
      }),
    );
    const createPayload = (await createResponse.json()) as { session: { session_id: string } };
    const sessionId = createPayload.session.session_id;

    const stagingResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/staging`, { headers: authHeaders }),
    );
    const stagingPayload = (await stagingResponse.json()) as { staging: { selected_paths: string[]; staging_status: string } };
    expect(stagingPayload.staging.selected_paths).toEqual(["notes.txt"]);
    expect(stagingPayload.staging.staging_status).toBe("ready");

    runtimeAdapter.files.get(`fake-runtime:${sessionId}`)?.set("/notes.txt", "from-api");

    const commitResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/commit`, {
        method: "POST",
        headers: authHeaders,
      }),
    );
    const commitPayload = (await commitResponse.json()) as { commit: { status: string; written_paths: string[] } };
    expect(commitPayload.commit.status).toBe("committed");
    expect(commitPayload.commit.written_paths).toEqual(["notes.txt"]);

    const discardResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${sessionId}/discard`, {
        method: "POST",
        headers: authHeaders,
      }),
    );
    const discardPayload = (await discardResponse.json()) as { session: { staging_status: string } };
    expect(discardPayload.session.staging_status).toBe("discarded");
  });

  test("returns 404 for missing runtime and runtime session", async () => {
    const token = await createToken(["runtimes:read", "runtime-sessions:read"]);

    const runtimeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes/missing", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(runtimeResponse.status).toBe(404);

    const sessionResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions/missing", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(sessionResponse.status).toBe(404);
  });

  test("returns runtime error envelopes for unsupported capability", async () => {
    app = createRuntimeApp({ adapter: new FakeRuntimeAdapter(["exec"]) });
    const token = await createToken(["runtime-sessions:read", "runtime-sessions:write"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const createPayload = (await createResponse.json()) as { session: { session_id: string } };

    const copyInResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${createPayload.session.session_id}/files:copy-in`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json", "X-Request-Id": "req_rt_unsupported" },
        body: JSON.stringify({ destination_path: "/tmp/nope", content_text: "hello" }),
      }),
    );
    const payload = (await copyInResponse.json()) as { code: string; request_id: string; error: string };
    expect(copyInResponse.status).toBe(400);
    expect(payload.code).toBe("runtime.unsupported_capability");
    expect(payload.request_id).toBe("req_rt_unsupported");
    expect(payload.error).toContain("copy-in");
  });

  test("rejects oversized runtime copy-in bodies", async () => {
    const token = await createToken(["runtime-sessions:read", "runtime-sessions:write"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtime-sessions", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const createPayload = (await createResponse.json()) as { session: { session_id: string } };

    const response = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/runtime-sessions/${createPayload.session.session_id}/files:copy-in`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          destination_path: "/tmp/huge.txt",
          content_text: "x".repeat(5 * 1024 * 1024),
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: "request body too large",
      code: "input.malformed_body",
      status: 413,
    }));
  });

  test("keeps existing sessions, nodes, and jobs routes working", async () => {
    app = createRuntimeApp({
      adapter: new FakeRuntimeAdapter(["exec", "stop", "copy-in", "copy-out", "log-stream"]),
      nodeRegistryService: { listNodes: () => [] },
    });
    const token = await createToken(["sessions:read", "nodes:read", "jobs:read"]);
    const authHeaders = { Authorization: `Bearer ${token}` };

    const sessionsResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/sessions", { headers: authHeaders }),
    );
    expect(sessionsResponse.status).toBe(200);

    const nodesResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/nodes", { headers: authHeaders }),
    );
    expect(nodesResponse.status).toBe(200);

    const jobsResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", { headers: authHeaders }),
    );
    expect(jobsResponse.status).toBe(200);
  });

  const createRuntimeApp = (options: {
    adapter: RuntimeAdapter;
    nodeRegistryService?: { listNodes(workspaceId: string): unknown[] };
  }): Or3NetApp => {
    const runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.register(options.adapter);
    const runtimeSelection = new RuntimeSelectionService(runtimeRegistry);
    const runtimeSessionService = new RuntimeSessionService(runtimeRegistry, runtimeSelection, database);

    return new Or3NetApp({
      database,
      authService,
      localJobService: new LocalJobService({ database, internClient: new FakeInternClient(), reconcileOnStartup: false }),
      runtimeRegistry,
      runtimeSessionService,
      ...(options.nodeRegistryService === undefined
        ? {}
        : {
            nodeRegistryService: options.nodeRegistryService as never,
          }),
    });
  };

  const createToken = async (scopes: string[]): Promise<string> => {
    const token = await issueWorkspaceToken({
      secret: "phase6-secret",
      subject: "user_1",
      workspace_id: "ws_test",
      scopes,
    });
    return token.token;
  };
});
