import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionProofValidator } from "../src/auth/service.ts";
import { issueWorkspaceToken } from "../src/auth/tokens.ts";
import {
  AuthService,
  createControlPlaneDatabase,
  createServerApp,
  handleAppRequest,
  LeaseScheduler,
  LocalContainerRuntimeAdapter,
  LocalJobService,
  NodeRegistryService,
  RemoteNodeRuntimeAdapter,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
  SandboxRuntimeAdapter,
} from "../src/index.ts";
import { runtimeSessionCreateInputSchema, type RuntimeExecutionRequest } from "../src/contracts/runtime/index.ts";
import type {
  LocalContainerCommandResult,
  LocalContainerCommandRunner,
} from "../src/runtime/adapters/local-container.ts";
import type {
  NodeExecutionHandle,
  StoredNode,
  TaskPackage,
} from "../src/index.ts";
import type {
  InternAbortResponse,
  InternClient,
  InternJobEvent,
  InternSubagentRequest,
  InternSubagentResponse,
  InternTurnRequest,
  InternTurnResponse,
} from "../sdk/intern/index.ts";
import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  CreateTunnelSignedUrlRequest,
  RuntimeCapacity,
  RuntimeHealth,
  RuntimeInfo,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileContent,
  SandboxInfo,
  SandboxQuota,
  SandboxRequestContext,
  SandboxTunnel,
  SandboxTunnelSignedUrl,
  SandboxWriteFileRequest,
} from "../sdk/sandbox/types.ts";
import { SandboxRequestError } from "../sdk/sandbox/types.ts";

const TEST_SECRET = "phase7-secret";

describe("phase 7 runtime integration", () => {
  let database = createControlPlaneDatabase();
  let stagingDirs: string[] = [];

  beforeEach(() => {
    database = createControlPlaneDatabase();
    stagingDirs = [];
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    database.close();
    for (const stagingDir of stagingDirs) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  const createRuntimeSessionService = (registry: RuntimeRegistry): RuntimeSessionService => {
    const stagingDir = mkdtempSync(path.join(tmpdir(), "or3-net-phase7-stage-"));
    stagingDirs.push(stagingDir);
    return new RuntimeSessionService(registry, new RuntimeSelectionService(registry), database, { stagingBaseDir: stagingDir });
  };

  test("createServerApp auto-registers runtime adapters when dependencies are available", async () => {
    const authService = createAuthService(database);
    seedApprovedRemoteNode(database);
    const sandboxClient = new FakeSandboxClient();
    const nodeRegistryService = new NodeRegistryService({ database });
    const leaseScheduler = new LeaseScheduler({ database });
    const remoteNodeExecutor = new FakeRemoteExecutor();
    const app = createServerApp({
      database,
      authService,
      localJobService: createLocalJobService(database),
      sandboxClient,
      nodeRegistryService,
      leaseScheduler,
      remoteNodeExecutor: remoteNodeExecutor as never,
    });
    const token = await createToken(["runtimes:read"]);

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/runtimes", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const payload = (await response.json()) as { items: { adapter_id: string }[] };

    expect(response.status).toBe(200);
    expect(payload.items.map((item) => item.adapter_id).sort()).toEqual([
      "local-container",
      "or3-sandbox",
      "remote-node-agent",
    ]);
  });

  test("sandbox adapter supports full create exec destroy lifecycle through session service", async () => {
    const registry = new RuntimeRegistry();
    registry.register(new SandboxRuntimeAdapter({ sandboxClient: new FakeSandboxClient() }));
    const service = createRuntimeSessionService(registry);

    const session = await service.createSession("ws_test", createSessionConfig(["log-stream"]));
    const handle = await service.exec("ws_test", session.session_id, createExecRequest("echo", ["hello"]));
    const result = await handle.result;
    const destroyed = await service.destroySession("ws_test", session.session_id);

    expect(session.adapter_id).toBe("or3-sandbox");
    expect(result.stdout).toBe("echo hello");
    expect(destroyed.status).toBe("destroyed");
  });

  test("remote-node adapter supports full create exec destroy lifecycle through session service", async () => {
    seedApprovedRemoteNode(database);
    const registry = new RuntimeRegistry();
    registry.register(
      new RemoteNodeRuntimeAdapter({
        database,
        nodeRegistryService: { listNodes: (workspaceId: string) => database.workspace(workspaceId).listNodes() },
        leaseScheduler: new LeaseScheduler({ database }),
        remoteNodeExecutor: new FakeRemoteExecutor(),
      }),
    );
    const service = createRuntimeSessionService(registry);

    const session = await service.createSession("ws_test", createSessionConfig(["exec"]));
    const handle = await service.exec("ws_test", session.session_id, createExecRequest("echo", ["remote"]));
    const result = await handle.result;
    const destroyed = await service.destroySession("ws_test", session.session_id);

    expect(session.adapter_id).toBe("remote-node-agent");
    expect(result.stdout).toBe("echo remote");
    expect(destroyed.status).toBe("destroyed");
  });

  test("local-container adapter supports full create exec destroy lifecycle through session service", async () => {
    const runner = new FakeRunner();
    runner.results.set("create alpine:3.19 sh -lc while true; do sleep 3600; done", { stdout: "ctr_1\n", stderr: "", exitCode: 0 });
    runner.results.set("start ctr_1", { stdout: "ctr_1", stderr: "", exitCode: 0 });
    runner.results.set("exec ctr_1 echo local", { stdout: "echo local", stderr: "", exitCode: 0 });
    runner.results.set("rm -f ctr_1", { stdout: "", stderr: "", exitCode: 0 });

    const registry = new RuntimeRegistry();
    registry.register(new LocalContainerRuntimeAdapter({ runner }));
    const service = createRuntimeSessionService(registry);

    const session = await service.createSession("ws_test", createSessionConfig(["copy-in"]));
    const handle = await service.exec("ws_test", session.session_id, createExecRequest("echo", ["local"]));
    const result = await handle.result;
    const destroyed = await service.destroySession("ws_test", session.session_id);

    expect(session.adapter_id).toBe("local-container");
    expect(result.stdout).toBe("echo local");
    expect(destroyed.status).toBe("destroyed");
  });

  test("startup reconciliation runs when the server app is created", async () => {
    const sandboxClient = new FakeSandboxClient();
    const registry = new RuntimeRegistry();
    registry.register(new SandboxRuntimeAdapter({ sandboxClient }));
    const service = createRuntimeSessionService(registry);

    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_reconcile",
      adapter_id: "or3-sandbox",
      adapter_session_ref: "sbx_missing",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "sandbox",
      trust_tier: "development",
    });

    createServerApp({
      database,
      authService: createAuthService(database),
      localJobService: createLocalJobService(database),
      runtimeRegistry: registry,
      runtimeSessionService: service,
    });

    await Bun.sleep(10);

    const stored = database.workspace("ws_test").getRuntimeSession("sess_reconcile");
    expect(stored.session.status).toBe("destroyed");
  });

  test("selection picks the remote adapter for production trust criteria", async () => {
    seedApprovedRemoteNode(database);
    const registry = new RuntimeRegistry();
    registry.register(new SandboxRuntimeAdapter({ sandboxClient: new FakeSandboxClient() }));
    registry.register(new LocalContainerRuntimeAdapter({ runner: new FakeRunner() }));
    registry.register(
      new RemoteNodeRuntimeAdapter({
        database,
        nodeRegistryService: { listNodes: (workspaceId: string) => database.workspace(workspaceId).listNodes() },
        leaseScheduler: new LeaseScheduler({ database }),
        remoteNodeExecutor: new FakeRemoteExecutor(),
      }),
    );

    const selection = await new RuntimeSelectionService(registry).select("ws_test", {
      required_capabilities: ["exec"],
      trust_tier: "production",
    });

    expect(selection.adapter.manifest.adapter_id).toBe("remote-node-agent");
  });
});

class StaticSessionProofValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "user_1",
      workspace_id: "ws_test",
      scopes: ["runtimes:read", "runtime-sessions:read", "runtime-sessions:write"],
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

class FakeSandboxClient implements SandboxClient {
  private readonly sandboxes = new Map<string, SandboxInfo>();
  private readonly files = new Map<string, Map<string, string>>();

  public create(request: CreateSandboxRequest, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    void requestContext;
    const sandbox: SandboxInfo = {
      id: `sbx_${String(this.sandboxes.size + 1)}`,
      status: request.start === true ? "running" : "created",
      ...(request.workspace_id === undefined ? {} : { workspace_id: request.workspace_id }),
    };
    this.sandboxes.set(sandbox.id, sandbox);
    this.files.set(sandbox.id, new Map());
    return Promise.resolve(sandbox);
  }

  public list(requestContext?: SandboxRequestContext): Promise<SandboxInfo[]> {
    void requestContext;
    return Promise.resolve([...this.sandboxes.values()]);
  }

  public get(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    void requestContext;
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new SandboxRequestError("sandbox missing", 404, { error: "missing", status: 404 }));
    }
    return Promise.resolve(sandbox);
  }

  public delete(sandboxId: string, requestContext?: SandboxRequestContext): Promise<void> {
    void requestContext;
    this.sandboxes.delete(sandboxId);
    this.files.delete(sandboxId);
    return Promise.resolve();
  }

  public start(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    void requestContext;
    const sandbox = { ...(this.sandboxes.get(sandboxId) ?? { id: sandboxId }), status: "running" };
    this.sandboxes.set(sandboxId, sandbox);
    return Promise.resolve(sandbox);
  }

  public stop(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    void requestContext;
    const sandbox = { ...(this.sandboxes.get(sandboxId) ?? { id: sandboxId }), status: "stopped" };
    this.sandboxes.set(sandboxId, sandbox);
    return Promise.resolve(sandbox);
  }

  public suspend(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.stop(sandboxId, requestContext);
  }

  public resume(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.start(sandboxId, requestContext);
  }

  public async *execStream(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): AsyncIterable<SandboxExecEvent> {
    void sandboxId;
    void requestContext;
    await Promise.resolve();
    const output = request.command.join(" ");
    yield { event: "stdout", data: { chunk: output } };
    yield { event: "result", data: { exit_code: 0, stdout: output, stderr: "" } };
  }

  public exec(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): Promise<SandboxExecResult> {
    void sandboxId;
    void requestContext;
    return Promise.resolve({ exit_code: 0, stdout: request.command.join(" "), stderr: "" });
  }

  public readFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<SandboxFileContent> {
    void requestContext;
    const content = this.files.get(sandboxId)?.get(path) ?? "";
    return Promise.resolve({ path, content });
  }

  public writeFile(sandboxId: string, request: SandboxWriteFileRequest, requestContext?: SandboxRequestContext): Promise<void> {
    void requestContext;
    const files = this.files.get(sandboxId) ?? new Map<string, string>();
    files.set(request.path, request.content);
    this.files.set(sandboxId, files);
    return Promise.resolve();
  }

  public deleteFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    void requestContext;
    this.files.get(sandboxId)?.delete(path);
    return Promise.resolve();
  }

  public mkdir(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    void sandboxId;
    void path;
    void requestContext;
    return Promise.resolve();
  }

  public importWorkspaceArchive(sandboxId: string, archive: Uint8Array, requestContext?: SandboxRequestContext): Promise<void> {
    void requestContext;
    const files = this.files.get(sandboxId) ?? new Map<string, string>();
    files.set("/__archive__", String(archive.byteLength));
    this.files.set(sandboxId, files);
    return Promise.resolve();
  }

  public exportWorkspaceArchive(sandboxId: string, request?: { paths?: string[] }, requestContext?: SandboxRequestContext): Promise<Uint8Array> {
    void sandboxId;
    void request;
    void requestContext;
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  }

  public createTunnel(sandboxId: string, request: CreateTunnelRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnel> {
    void requestContext;
    return Promise.resolve({
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      endpoint: `https://sandbox.local/${sandboxId}/${String(request.target_port)}`,
    });
  }

  public listTunnels(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxTunnel[]> {
    void sandboxId;
    void requestContext;
    return Promise.resolve([]);
  }

  public revokeTunnel(tunnelId: string, requestContext?: SandboxRequestContext): Promise<void> {
    void tunnelId;
    void requestContext;
    return Promise.resolve();
  }

  public createSignedTunnelUrl(tunnelId: string, request?: CreateTunnelSignedUrlRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnelSignedUrl> {
    void request;
    void requestContext;
    return Promise.resolve({
      url: `https://sandbox.local/signed/${tunnelId}`,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  }

  public runtimeInfo(requestContext?: SandboxRequestContext): Promise<RuntimeInfo> {
    void requestContext;
    return Promise.resolve({ cpu_cores: 2, memory_mb: 1024, max_concurrent_execs: 4 });
  }

  public runtimeHealth(requestContext?: SandboxRequestContext): Promise<RuntimeHealth> {
    void requestContext;
    return Promise.resolve({ status: "healthy" });
  }

  public runtimeCapacity(requestContext?: SandboxRequestContext): Promise<RuntimeCapacity> {
    void requestContext;
    return Promise.resolve({});
  }

  public getQuota(requestContext?: SandboxRequestContext): Promise<SandboxQuota> {
    void requestContext;
    return Promise.resolve({});
  }

  public getMetrics(requestContext?: SandboxRequestContext): Promise<string> {
    void requestContext;
    return Promise.resolve("");
  }
}

class FakeRemoteExecutor {
  public startExecution(node: StoredNode, taskPackage: TaskPackage): Promise<NodeExecutionHandle> {
    void node;
    return Promise.resolve({
      nodeId: node.manifest.node_id,
      result: Promise.resolve({ output_text: taskPackage.instructions, artifacts: [], meta: {} }),
      abort: () => Promise.resolve(),
    });
  }

  public heartbeat(node: StoredNode): Promise<void> {
    void node;
    return Promise.resolve();
  }

  public canExecute(node: StoredNode): boolean {
    void node;
    return true;
  }
}

class FakeRunner implements LocalContainerCommandRunner {
  public readonly calls: { args: string[]; stdin?: string; timeoutMs?: number }[] = [];
  public readonly results = new Map<string, LocalContainerCommandResult>();

  public run(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<LocalContainerCommandResult> {
    this.calls.push({
      args,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return Promise.resolve(this.results.get(args.join(" ")) ?? { stdout: "", stderr: "", exitCode: 0 });
  }
}

const createAuthService = (database: ReturnType<typeof createControlPlaneDatabase>): AuthService =>
  new AuthService({
    secret: TEST_SECRET,
    database,
    sessionProofValidator: new StaticSessionProofValidator(),
  });

const createLocalJobService = (database: ReturnType<typeof createControlPlaneDatabase>): LocalJobService =>
  new LocalJobService({
    database,
    internClient: new FakeInternClient(),
    reconcileOnStartup: false,
  });

const createToken = async (scopes: string[]): Promise<string> => {
  const token = await issueWorkspaceToken({
    secret: TEST_SECRET,
    subject: "user_1",
    workspace_id: "ws_test",
    scopes,
  });
  return token.token;
};

const createSessionConfig = (requiredCapabilities: string[] = []): ReturnType<typeof runtimeSessionCreateInputSchema.parse> =>
  runtimeSessionCreateInputSchema.parse(
    requiredCapabilities.length === 0 ? {} : { required_capabilities: requiredCapabilities },
  );

const createExecRequest = (command: string, args: string[] = []): RuntimeExecutionRequest => ({
  command,
  args,
  env: {},
  background: false,
});

const seedApprovedRemoteNode = (database: ReturnType<typeof createControlPlaneDatabase>): void => {
  database.workspace("ws_test").saveNode({
    manifest: {
      node_id: "node_remote_1",
      pubkey: "pub",
      signature: "sig",
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "remote-node",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 2, cpu_cores: 2, memory_mb: 1024, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    },
    pubkey_fingerprint: "fp_remote",
    status: "approved",
    health_status: "healthy",
    approved_at: "2024-01-01T00:00:00.000Z",
    last_seen_at: "2024-01-01T00:00:00.000Z",
  });
};
