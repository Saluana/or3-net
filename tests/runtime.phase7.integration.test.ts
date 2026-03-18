/* eslint-disable @typescript-eslint/array-type, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-dynamic-delete */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SandboxManager } from "@alibaba-group/opensandbox";

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
  OpenSandboxRuntimeAdapter,
  RemoteNodeRuntimeAdapter,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
} from "../src/index.ts";
import { runtimeSessionCreateInputSchema, type RuntimeExecutionRequest } from "../src/contracts/runtime/index.ts";
import type { LocalContainerCommandResult, LocalContainerCommandRunner } from "../src/runtime/adapters/local-container.ts";
import type { NodeExecutionHandle, StoredNode, TaskPackage } from "../src/index.ts";
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
  OpenSandboxClient,
  OpenSandboxClientConfig,
  OpenSandboxCommandOptions,
  OpenSandboxConnection,
  OpenSandboxCreateRequest,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstanceInfo,
  OpenSandboxListRequest,
} from "../sdk/opensandbox/types.ts";
import { OpenSandboxRequestError } from "../sdk/opensandbox/types.ts";

const TEST_SECRET = "phase7-secret";

describe("phase 7 runtime integration", () => {
  let database = createControlPlaneDatabase();
  let stagingDirs: string[] = [];
  const restoreCallbacks: Array<() => void> = [];

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
    while (restoreCallbacks.length > 0) {
      restoreCallbacks.pop()?.();
    }
    for (const stagingDir of stagingDirs) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  const createRuntimeSessionService = (registry: RuntimeRegistry): RuntimeSessionService => {
    const stagingDir = mkdtempSync(path.join(tmpdir(), "or3-net-phase7-stage-"));
    stagingDirs.push(stagingDir);
    return new RuntimeSessionService(registry, new RuntimeSelectionService(registry), database, { stagingBaseDir: stagingDir });
  };

  test("createServerApp auto-registers OpenSandbox when config is present", async () => {
    setEnv("OR3_NET_OPENSANDBOX_API_KEY", "api-key", restoreCallbacks);
    setEnv("OR3_NET_OPENSANDBOX_DOMAIN", "sandbox.test", restoreCallbacks);
    patchStatic(SandboxManager, "create", (() => ({
      listSandboxInfos: async () => ({ items: [] }),
      getSandboxInfo: async () => createSdkSandboxInfo("osbx_1", "running"),
      pauseSandbox: async () => undefined,
      killSandbox: async () => undefined,
      close: async () => undefined,
    })) as any, restoreCallbacks);

    const authService = createAuthService(database);
    seedApprovedRemoteNode(database);
    const nodeRegistryService = new NodeRegistryService({ database });
    const leaseScheduler = new LeaseScheduler({ database });
    const remoteNodeExecutor = new FakeRemoteExecutor();
    const app = createServerApp({
      database,
      authService,
      localJobService: createLocalJobService(database),
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
      "opensandbox",
      "remote-node-agent",
    ]);
  });

  test("opensandbox adapter supports full create exec destroy lifecycle through session service", async () => {
    const registry = new RuntimeRegistry();
    registry.register(new OpenSandboxRuntimeAdapter({ client: new FakeOpenSandboxClient() }));
    const service = createRuntimeSessionService(registry);

    const session = await service.createSession("ws_test", createSessionConfig(["exec"]));
    const handle = await service.exec("ws_test", session.session_id, createExecRequest("echo", ["hello"]));
    const result = await handle.result;
    const destroyed = await service.destroySession("ws_test", session.session_id);

    expect(session.adapter_id).toBe("opensandbox");
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

  test("startup reconciliation marks missing OpenSandbox sessions as destroyed", async () => {
    const client = new FakeOpenSandboxClient();
    client.missingIds.add("osbx_missing");
    const registry = new RuntimeRegistry();
    registry.register(new OpenSandboxRuntimeAdapter({ client }));
    const service = createRuntimeSessionService(registry);

    database.workspace("ws_test").saveRuntimeSession({
      session_id: "sess_reconcile",
      adapter_id: "opensandbox",
      adapter_session_ref: "osbx_missing",
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
    registry.register(new OpenSandboxRuntimeAdapter({ client: new FakeOpenSandboxClient() }));
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

class FakeOpenSandboxConnection implements OpenSandboxConnection {
  public constructor(
    public readonly instance_id: string,
    private readonly client: FakeOpenSandboxClient,
  ) {}

  public async runCommand(
    command: string,
    options: OpenSandboxCommandOptions = {},
    handlers: OpenSandboxExecutionHandlers = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    void options;
    await handlers.onStdout?.({ text: command });
    await handlers.onResult?.({ status: "completed" });
    return { exit_code: 0, stdout: command, stderr: "", meta: {} };
  }

  public writeFiles(entries: Array<{ path: string; data: string }>): Promise<void> {
    const files = this.client.files.get(this.instance_id) ?? new Map<string, string>();
    for (const entry of entries) {
      files.set(entry.path, entry.data);
    }
    this.client.files.set(this.instance_id, files);
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    return Promise.resolve(this.client.files.get(this.instance_id)?.get(path) ?? "");
  }

  public createDirectories(paths: Array<{ path: string }>): Promise<void> {
    void paths;
    return Promise.resolve();
  }

  public getEndpoint(port: number): Promise<{ endpoint: string; url?: string }> {
    return Promise.resolve({ endpoint: `launch.local/${this.instance_id}/${String(port)}`, url: `https://launch.local/${this.instance_id}/${String(port)}` });
  }

  public pause(): Promise<void> {
    return this.client.pause(this.instance_id);
  }

  public resume(): Promise<OpenSandboxConnection> {
    return this.client.resume(this.instance_id);
  }

  public renew(timeoutSeconds: number): Promise<void> {
    return this.client.renew(this.instance_id, timeoutSeconds);
  }

  public kill(): Promise<void> {
    return this.client.kill(this.instance_id);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeOpenSandboxClient implements OpenSandboxClient {
  public readonly config: OpenSandboxClientConfig = {
    apiKey: "api-key",
    domain: "sandbox.test",
    defaultTimeoutSeconds: 120,
  };

  public readonly instances = new Map<string, OpenSandboxInstanceInfo>();
  public readonly files = new Map<string, Map<string, string>>();
  public readonly missingIds = new Set<string>();

  public async create(input: OpenSandboxCreateRequest): Promise<OpenSandboxConnection> {
    const instanceId = `osbx_${String(this.instances.size + 1)}`;
    this.instances.set(instanceId, {
      id: instanceId,
      status: "running",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    this.files.set(instanceId, new Map());
    return new FakeOpenSandboxConnection(instanceId, this);
  }

  public connect(instanceId: string): Promise<OpenSandboxConnection> {
    if (this.missingIds.has(instanceId) || !this.instances.has(instanceId)) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(new FakeOpenSandboxConnection(instanceId, this));
  }

  public list(input?: OpenSandboxListRequest): Promise<OpenSandboxInstanceInfo[]> {
    void input;
    return Promise.resolve([...this.instances.values()]);
  }

  public get(instanceId: string): Promise<OpenSandboxInstanceInfo> {
    if (this.missingIds.has(instanceId)) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(instance);
  }

  public pause(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance !== undefined) {
      this.instances.set(instanceId, { ...instance, status: "paused" });
    }
    return Promise.resolve();
  }

  public resume(instanceId: string): Promise<OpenSandboxConnection> {
    const instance = this.instances.get(instanceId);
    if (instance !== undefined) {
      this.instances.set(instanceId, { ...instance, status: "running" });
    }
    return this.connect(instanceId);
  }

  public renew(instanceId: string, timeoutSeconds: number): Promise<void> {
    void instanceId;
    void timeoutSeconds;
    return Promise.resolve();
  }

  public kill(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    this.files.delete(instanceId);
    return Promise.resolve();
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

const createSessionConfig = (requiredCapabilities: string[] = []) =>
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

const patchStatic = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
  restoreCallbacks: Array<() => void>,
): void => {
  const original = target[key];
  target[key] = replacement;
  restoreCallbacks.push(() => {
    target[key] = original;
  });
};

const setEnv = (key: string, value: string, restoreCallbacks: Array<() => void>): void => {
  const previous = Bun.env[key];
  Bun.env[key] = value;
  restoreCallbacks.push(() => {
    if (previous === undefined) {
      delete Bun.env[key];
      return;
    }
    Bun.env[key] = previous;
  });
};

const createSdkSandboxInfo = (id: string, state: string): any => ({
  id,
  image: "ubuntu",
  entrypoint: ["tail", "-f", "/dev/null"],
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  expiresAt: null,
  status: { state },
});
