import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import {
  createControlPlaneDatabase,
  JobStreamBroker,
  LeaseScheduler,
  LocalJobService,
  NodeRegistryService,
  NodeTransportRegistry,
  OutboundWssNodeTransport,
  OpenSandboxNodeAdapter,
  RemoteNodeExecutor,
  signNodeManifest,
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
  OpenSandboxClient,
  OpenSandboxClientConfig,
  OpenSandboxCommandOptions,
  OpenSandboxConnection,
  OpenSandboxCreateRequest,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstanceInfo,
} from "../sdk/opensandbox/types.ts";

type StreamFactory = (request: InternTurnRequest) => AsyncIterable<InternJobEvent>;
type UnsignedManifest = Parameters<typeof signNodeManifest>[0];

class ScriptedInternClient implements InternClient {
  public abortCalls: string[] = [];
  public submitTurnStreamCalls = 0;
  public readonly turnRequests: InternTurnRequest[] = [];

  public constructor(private readonly streamFactory: StreamFactory) {}

  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    this.turnRequests.push(request);
    return Promise.resolve({ job_id: "sync_job", status: "completed" });
  }

  public submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    this.submitTurnStreamCalls += 1;
    this.turnRequests.push(request);
    return this.streamFactory(request);
  }

  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    void request;
    return Promise.resolve({ job_id: "subagent_job", child_session_key: "svc:child", status: "queued" });
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "queued", data: { job_id: jobId, status: "queued" } };
  }

  public abortJob(jobId: string): Promise<InternAbortResponse> {
    this.abortCalls.push(jobId);
    return Promise.resolve({ ok: true, job_id: jobId, status: "aborted" });
  }
}

class FakeSandboxClient implements OpenSandboxClient {
  public readonly config: OpenSandboxClientConfig = {
    domain: "sandbox.test",
    apiKey: "sandbox-token",
    defaultImage: "ubuntu",
    defaultTimeoutSeconds: 600,
  };
  public readonly createdSandboxIds: string[] = [];
  public readonly execCalls: { instanceId: string; command: string }[] = [];
  public readonly writes: { instanceId: string; path: string; data: string }[] = [];
  public readonly directories: { instanceId: string; path: string }[] = [];
  private readonly sandboxes = new Map<string, OpenSandboxInstanceInfo>();
  private nextId = 1;

  public create(request: OpenSandboxCreateRequest): Promise<OpenSandboxConnection> {
    const workspaceId = request.workspace_id;
    const sandbox = {
      id: `sbx_${String(this.nextId++)}`,
      status: "running",
      metadata: { workspace_id: workspaceId },
    };
    this.createdSandboxIds.push(sandbox.id);
    this.sandboxes.set(sandbox.id, sandbox);
    return Promise.resolve(new FakeSandboxConnection(this, sandbox.id));
  }

  public get(sandboxId: string): Promise<OpenSandboxInstanceInfo> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    return Promise.resolve(sandbox);
  }

  public list(): Promise<OpenSandboxInstanceInfo[]> {
    return Promise.resolve([...this.sandboxes.values()]);
  }

  public connect(instanceId: string): Promise<OpenSandboxConnection> {
    if (!this.sandboxes.has(instanceId)) {
      return Promise.reject(new Error(`sandbox ${instanceId} not found`));
    }
    return Promise.resolve(new FakeSandboxConnection(this, instanceId));
  }

  public pause(instanceId: string): Promise<void> {
    const sandbox = this.sandboxes.get(instanceId);
    if (sandbox !== undefined) {
      this.sandboxes.set(instanceId, { ...sandbox, status: "paused" });
    }
    return Promise.resolve();
  }

  public resume(instanceId: string): Promise<OpenSandboxConnection> {
    const sandbox = this.sandboxes.get(instanceId);
    if (sandbox !== undefined) {
      this.sandboxes.set(instanceId, { ...sandbox, status: "running" });
    }
    return this.connect(instanceId);
  }

  public renew(instanceId: string, timeoutSeconds: number): Promise<void> {
    void instanceId;
    void timeoutSeconds;
    return Promise.resolve();
  }

  public kill(instanceId: string): Promise<void> {
    this.sandboxes.delete(instanceId);
    return Promise.resolve();
  }
}

class FakeSandboxConnection implements OpenSandboxConnection {
  public constructor(private readonly client: FakeSandboxClient, public readonly instance_id: string) {}

  public async runCommand(
    command: string,
    options: OpenSandboxCommandOptions = {},
    handlers: OpenSandboxExecutionHandlers = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    void options;
    this.client.execCalls.push({ instanceId: this.instance_id, command });
    await handlers.onStdout?.({ text: "ok" });
    await handlers.onResult?.({ status: "completed" });
    return {
      exit_code: 0,
      stdout: "ok",
      stderr: "",
      meta: {},
    };
  }

  public writeFiles(entries: { path: string; data: string }[]): Promise<void> {
    this.client.writes.push(...entries.map((entry) => ({ instanceId: this.instance_id, ...entry })));
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    void path;
    return Promise.resolve("");
  }

  public createDirectories(paths: { path: string }[]): Promise<void> {
    this.client.directories.push(...paths.map((entry) => ({ instanceId: this.instance_id, path: entry.path })));
    return Promise.resolve();
  }

  public getEndpoint(port: number): Promise<{ endpoint: string; url?: string }> {
    void port;
    return Promise.resolve({
      endpoint: `launch.local/${this.instance_id}/3000`,
      url: `https://launch.local/${this.instance_id}/3000`,
    });
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

class AbortableRemoteTransport {
  public abortCalls = 0;
  public executeCalls = 0;
  public releaseSignal: (() => void) | null = null;

  public create(): { kind: "outbound-wss"; startExecution: () => Promise<{ nodeId: string; stream: AsyncIterable<{ readonly event: "text.delta"; readonly data: { readonly text: string } }>; result: Promise<{ output_text: string; artifacts: []; meta: { via: string } }>; abort: () => Promise<void> }> } {
    return {
      kind: "outbound-wss" as const,
      startExecution: () => {
        this.executeCalls += 1;
        let aborted = false;
        const result = new Promise<{ output_text: string; artifacts: []; meta: { via: string } }>((resolve, reject) => {
          this.releaseSignal = () => {
            if (aborted) {
              reject(new Error("remote aborted"));
              return;
            }
            resolve({ output_text: "remote complete", artifacts: [], meta: { via: "remote" } });
          };
        });
        return Promise.resolve({
          nodeId: "node_remote_rpc",
          stream: singleEventAsyncIterable({ event: "text.delta", data: { text: "remote working" } } as const),
          result,
          abort: () => {
            aborted = true;
            this.abortCalls += 1;
            this.releaseSignal?.();
            return Promise.resolve();
          },
        });
      },
    };
  }
}

class FailingRemoteTransport {
  public constructor(
    private readonly mode: "start" | "disconnect" | "stream-disconnect" | "abort",
  ) {}

  public create(): { kind: "outbound-wss"; startExecution: () => Promise<{ nodeId: string; result: Promise<{ output_text: string; artifacts: []; meta: Record<string, never> }>; stream?: AsyncIterable<never>; abort: () => Promise<void> }> } {
    return {
      kind: "outbound-wss" as const,
      startExecution: () => {
        if (this.mode === "start") {
          return Promise.reject(new Error("dial tcp node failed"));
        }

        return Promise.resolve({
          nodeId: "node_remote_fail",
          result:
            this.mode === "disconnect"
              ? Promise.reject(new Error("connection closed"))
              : this.mode === "stream-disconnect"
                ? neverSettlingPromise<{ output_text: string; artifacts: []; meta: Record<string, never> }>()
                : neverSettlingPromise<{ output_text: string; artifacts: []; meta: Record<string, never> }>(),
          ...(this.mode === "stream-disconnect"
            ? {
                stream: throwingAsyncIterable(new Error("stream connection closed")),
              }
            : {}),
          abort: () => {
            if (this.mode === "abort") {
              return Promise.reject(new Error("abort rpc failed"));
            }
            return Promise.resolve();
          },
        });
      },
    };
  }
}

describe("local job execution", () => {
  let database = createControlPlaneDatabase();

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_jobs",
      name: "Jobs Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    database.close();
  });

  test("aborts before the backend job id exists and ignores later terminal events", async () => {
    const broker = new JobStreamBroker();
    const internClient = new ScriptedInternClient(async function* (request) {
      await Bun.sleep(20);
      yield { event: "queued", data: { job_id: `intern_${request.sessionKey}`, status: "queued" } };
      yield { event: "started", data: { job_id: `intern_${request.sessionKey}`, status: "running" } };
      yield { event: "completion", data: { job_id: `intern_${request.sessionKey}`, status: "completed", final_text: "late" } };
    });
    const service = new LocalJobService({ database, internClient, streamBroker: broker });

    const job = service.submitJob("ws_jobs", {
      session_key: "svc:abort-early",
      message: "abort me",
    });
    const aborted = await service.abortJob("ws_jobs", job.job_id);

    expect(aborted).toEqual({ ok: true, job_id: job.job_id });

    await waitFor(() => {
      expect(internClient.abortCalls).toEqual(["intern_svc:abort-early"]);
      expect(service.getJob("ws_jobs", job.job_id).job.status).toBe("aborted");
    });

    expect(broker.history(job.job_id).map((event) => event.event)).toEqual(["job.accepted", "job.aborted"]);
  });

  test("marks jobs failed when the intern stream ends without a terminal event", async () => {
    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      streamBroker: broker,
      internClient: new ScriptedInternClient(async function* (request) {
        await Promise.resolve();
        yield { event: "queued", data: { job_id: `intern_${request.sessionKey}`, status: "queued" } };
        yield { event: "started", data: { job_id: `intern_${request.sessionKey}`, status: "running" } };
        yield { event: "text_delta", data: { job_id: `intern_${request.sessionKey}`, content: "partial" } };
      }),
    });

    const job = service.submitJob("ws_jobs", {
      session_key: "svc:eof",
      message: "return partial",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", job.job_id).job;
      expect(stored.status).toBe("failed");
      expect(stored.error?.code).toBe("intern_stream_ended_without_terminal_event");
    });

    expect(broker.history(job.job_id).map((event) => event.event)).toEqual([
      "job.accepted",
      "job.started",
      "text.delta",
      "job.failed",
    ]);
  });

  test("keeps the first terminal state when later intern events conflict", async () => {
    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      streamBroker: broker,
      internClient: new ScriptedInternClient(async function* (request) {
        await Promise.resolve();
        yield { event: "started", data: { job_id: `intern_${request.sessionKey}`, status: "running" } };
        yield { event: "completion", data: { job_id: `intern_${request.sessionKey}`, status: "completed", final_text: "done" } };
        yield { event: "runtime_error", data: { job_id: `intern_${request.sessionKey}`, message: "too late" } };
      }),
    });

    const job = service.submitJob("ws_jobs", {
      session_key: "svc:terminal",
      message: "finish first",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", job.job_id).job;
      expect(stored.status).toBe("completed");
      expect(stored.result?.output_text).toBe("done");
    });

    expect(broker.history(job.job_id).map((event) => event.event)).toEqual([
      "job.accepted",
      "job.started",
      "job.completed",
    ]);
  });

  test("keeps local intern execution as the default even when an approved node is available", async () => {
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_remote",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", {
      ...unsignedManifest,
      signature: signNodeManifest(unsignedManifest, keyPair.secretKey),
    });
    await nodeRegistry.approveNode("ws_jobs", "node_remote");

    const sandboxClient = new FakeSandboxClient();
    const internClient = new ScriptedInternClient(async function* (request) {
      await Promise.resolve();
      yield { event: "queued", data: { job_id: `intern_${request.sessionKey}`, status: "queued" } };
      yield { event: "started", data: { job_id: `intern_${request.sessionKey}`, status: "running" } };
      yield { event: "completion", data: { job_id: `intern_${request.sessionKey}`, status: "completed", final_text: "local complete" } };
    });
    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      internClient,
      streamBroker: broker,
      leaseScheduler: new LeaseScheduler({ database }),
      nodeExecutionAdapter: new OpenSandboxNodeAdapter(sandboxClient),
    });

    const job = service.submitJob("ws_jobs", {
      session_key: "svc:remote",
      message: "echo remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", job.job_id).job;
      expect(stored.status).toBe("completed");
      expect(stored.node_id).toBeUndefined();
      expect(stored.result?.output_text).toBe("local complete");
    });

    expect(internClient.submitTurnStreamCalls).toBe(1);
    expect(sandboxClient.execCalls).toHaveLength(0);
    expect(database.workspace("ws_jobs").listLeases()).toHaveLength(0);
  });

  test("passes PlatformSessionRef alongside session_key on intern-bound turns", async () => {
    const broker = new JobStreamBroker();
    const internClient = new ScriptedInternClient(async function* (request) {
      await Promise.resolve();
      yield { event: "started", data: { job_id: `intern_${request.sessionKey}`, status: "running" } };
      yield { event: "completion", data: { job_id: `intern_${request.sessionKey}`, status: "completed", final_text: "done" } };
    });
    const service = new LocalJobService({ database, internClient, streamBroker: broker });

    const created = service.submitJob(
      "ws_jobs",
      {
        client_kind: "chat",
        client_session_id: "thread_123",
        message: "hello",
      },
      { initiator_subject: "user_123" },
    );

    await waitFor(() => {
      expect(service.getJob("ws_jobs", created.job_id).job.status).toBe("completed");
    });

    const request = internClient.turnRequests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error("expected intern request");
    }
    const storedJob = service.getJob("ws_jobs", created.job_id);
    expect(storedJob.network_session_id).not.toBeNull();
    const networkSessionId = storedJob.network_session_id;
    const sessionKey = request.sessionKey;
    const requestId = request.requestContext?.requestId;
    const platformSessionRef = request.platformSessionRef;
    if (networkSessionId === null || requestId === undefined) {
      throw new Error("expected persisted session binding details");
    }

    expect(platformSessionRef).toEqual({
      workspace_id: "ws_jobs",
      client_kind: "chat",
      client_session_id: "thread_123",
      network_session_id: networkSessionId,
      session_key: sessionKey,
    });
    expect(request.requestContext?.workspaceId).toBe("ws_jobs");
    expect(request.requestContext?.networkSessionId).toBe(networkSessionId);
    expect(typeof request.requestContext?.requestId).toBe("string");
    expect(storedJob.task_package.metadata["audit_context"]).toEqual({
      request_id: requestId,
      workspace_id: "ws_jobs",
      subject: "user_123",
      network_session_id: networkSessionId,
      session_key: sessionKey,
      job_id: created.job_id,
    });
    const persistedEvents = service.listSessionEvents("ws_jobs", networkSessionId);
    expect(persistedEvents.length).toBeGreaterThan(0);
    const persistedPayloads = persistedEvents.map((event) => parseJsonRecord(event.payload_json));
    expect(persistedPayloads.some((payload) => {
      const auditContext = getRecordValue(payload, "audit_context");
      if (auditContext === undefined) {
        return false;
      }

      return auditContext["request_id"] === requestId && auditContext["workspace_id"] === "ws_jobs";
    })).toBeTrue();
    expect(storedJob.task_package.metadata["platform_session_ref"]).toEqual(platformSessionRef);
  });

  test("routes jobs through the remote sandbox path only when explicitly requested", async () => {
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_remote",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", {
      ...unsignedManifest,
      signature: signNodeManifest(unsignedManifest, keyPair.secretKey),
    });
    await nodeRegistry.approveNode("ws_jobs", "node_remote");

    const sandboxClient = new FakeSandboxClient();
    const internClient = new ScriptedInternClient(() => ({
      [Symbol.asyncIterator](): AsyncIterator<InternJobEvent> {
        throw new Error("local intern path should not run");
      },
    }));
    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      internClient,
      streamBroker: broker,
      leaseScheduler: new LeaseScheduler({ database }),
      nodeExecutionAdapter: new OpenSandboxNodeAdapter(sandboxClient),
    });

    const job = service.submitJob("ws_jobs", {
      session_key: "svc:remote",
      message: "echo remote",
      execution_target: "remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", job.job_id).job;
      expect(stored.status).toBe("completed");
      expect(stored.node_id).toBe("node_remote");
      expect(stored.result?.meta["instance_id"]).toBe("sbx_1");
    });

    expect(internClient.submitTurnStreamCalls).toBe(0);
    expect(sandboxClient.execCalls).toHaveLength(1);
    expect(broker.history(job.job_id).map((event) => event.event)).toEqual([
      "job.accepted",
      "job.started",
      "text.delta",
      "job.completed",
    ]);
    expect(database.workspace("ws_jobs").listLeases()).toHaveLength(1);
    expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("released");
  });

  test("stages relative task artifacts under /workspace for remote sandbox execution", async () => {
    const sandboxClient = new FakeSandboxClient();
    const adapter = new OpenSandboxNodeAdapter(sandboxClient);

    const result = await adapter.executeTask("ws_jobs", {
      workspace_id: "ws_jobs",
      job_id: "job_artifacts",
      kind: "turn",
      instructions: "echo ok",
      artifacts: [
        {
          artifact_id: "art_readme",
          path: "README.md",
          kind: "file",
          content_type: "text/plain",
          size_bytes: 5,
          text: "hello",
        },
        {
          artifact_id: "art_src",
          path: "src/index.ts",
          kind: "file",
          content_type: "text/plain",
          size_bytes: 23,
          text: "export const ok = true;",
        },
      ],
      tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1_000, hard_ms: 2_000 },
      lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: [] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: {},
    });

    expect(result.exit_code).toBe(0);
    expect(sandboxClient.directories).toContainEqual({ instanceId: result.instance_id, path: "/workspace/src" });
    expect(sandboxClient.writes).toEqual([
      { instanceId: result.instance_id, path: "/workspace/README.md", data: "hello" },
      { instanceId: result.instance_id, path: "/workspace/src/index.ts", data: "export const ok = true;" },
    ]);
  });

  test("aborts remote executor jobs via upstream handle and suppresses later completion", async () => {
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_remote_rpc",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_rpc");

    const transportRegistry = new NodeTransportRegistry();
    const transport = new AbortableRemoteTransport();
    transportRegistry.registerNodeTransport("ws_jobs", "node_remote_rpc", transport.create());

    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: broker,
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(transportRegistry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-abort",
      message: "abort remote",
      execution_target: "remote",
    });

    await waitFor(() => {
      expect(service.getJob("ws_jobs", created.job_id).job.status).toBe("running");
    });

    const response = await service.abortJob("ws_jobs", created.job_id);
    expect(response).toEqual({ ok: true, job_id: created.job_id });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("aborted");
      expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("released");
    });

    expect(transport.abortCalls).toBe(1);
    expect(broker.history(created.job_id).map((event) => event.event)).toEqual([
      "job.accepted",
      "job.started",
      "text.delta",
      "job.aborted",
    ]);
  });

  test("marks remote startup failures with a stable error code", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_fail",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_fail");

    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport("ws_jobs", "node_remote_fail", new FailingRemoteTransport("start").create());

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-start-fail",
      message: "start fail",
      execution_target: "remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("failed");
      expect(stored.error?.code).toBe("remote_execution_start_failed");
    });
  });

  test("marks transport disconnects with a stable error code", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_disconnect",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_disconnect");

    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport("ws_jobs", "node_remote_disconnect", new FailingRemoteTransport("disconnect").create());

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-disconnect",
      message: "disconnect",
      execution_target: "remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("failed");
      expect(stored.error?.code).toBe("remote_transport_disconnected");
    });
  });

  test("fails remote jobs with a stable abort error code when upstream abort fails", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_abort_fail",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_abort_fail");

    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport("ws_jobs", "node_remote_abort_fail", new FailingRemoteTransport("abort").create());

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-abort-fail",
      message: "abort fail",
      execution_target: "remote",
    });

    await waitFor(() => {
      expect(service.getJob("ws_jobs", created.job_id).job.status).toBe("running");
    });

    try {
      await service.abortJob("ws_jobs", created.job_id);
      throw new Error("expected remote abort to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("abort rpc failed");
    }

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("failed");
      expect(stored.error?.code).toBe("remote_abort_failed");
      expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("failed");
    });
  });

  test("fails fast and releases capacity when the remote progress stream disconnects", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_stream_disconnect",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_stream_disconnect");

    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport("ws_jobs", "node_remote_stream_disconnect", new FailingRemoteTransport("stream-disconnect").create());

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-stream-disconnect",
      message: "disconnect",
      execution_target: "remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("failed");
      expect(stored.error?.code).toBe("remote_transport_disconnected");
      expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("released");
    });
  });

  test("can schedule a second remote job immediately after the first completes", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_reuse",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_jobs", "node_remote_reuse");

    const registry = new NodeTransportRegistry();
    let executionCount = 0;
    registry.registerNodeTransport("ws_jobs", "node_remote_reuse", {
      kind: "outbound-wss",
      startExecution: () => {
        executionCount += 1;
        return Promise.resolve({
          nodeId: "node_remote_reuse",
          result: Promise.resolve({ output_text: `remote complete ${String(executionCount)}`, artifacts: [], meta: { run: executionCount } }),
          abort: () => Promise.resolve(),
        });
      },
    });

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry, database),
    });

    const first = service.submitJob("ws_jobs", {
      session_key: "svc:remote-reuse-1",
      message: "first",
      execution_target: "remote",
    });

    await waitFor(() => {
      expect(service.getJob("ws_jobs", first.job_id).job.status).toBe("completed");
      expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("released");
    });

    const second = service.submitJob("ws_jobs", {
      session_key: "svc:remote-reuse-2",
      message: "second",
      execution_target: "remote",
    });

    await waitFor(() => {
      expect(service.getJob("ws_jobs", second.job_id).job.status).toBe("completed");
    });

    expect(executionCount).toBe(2);
    expect(database.workspace("ws_jobs").listLeases().every((lease) => lease.lease.state === "released")).toBeTrue();
  });

  test("routes remote jobs through a live outbound-wss connection and preserves streamed job events", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_remote_live",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const nodeRegistry = new NodeRegistryService({ database });
    await nodeRegistry.enrollNode("ws_jobs", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    const approval = await nodeRegistry.approveNode("ws_jobs", "node_remote_live");

    const transportRegistry = new NodeTransportRegistry();
    const transport = new OutboundWssNodeTransport({ database });
    transportRegistry.registerKindTransport("outbound-wss", transport);
    transport.attachLiveConnection({
      workspaceId: "ws_jobs",
      nodeId: "node_remote_live",
      socket: {
        send(data: string): void {
          const parsed = JSON.parse(data) as { type: string; payload: { id: string; method: string } };
          if (parsed.type !== "request") {
            return;
          }
          if (parsed.payload.method === "execute") {
            transport.handleLiveMessage(
              "ws_jobs",
              "node_remote_live",
              JSON.stringify({
                type: "event",
                request_id: parsed.payload.id,
                payload: { event: "progress", data: { percent: 10, message: "live-progress" } },
              }),
            );
          }
          transport.handleLiveMessage(
            "ws_jobs",
            "node_remote_live",
            JSON.stringify({
              type: "response",
              payload: {
                id: parsed.payload.id,
                result: { output_text: "live job ok", artifacts: [], meta: { token: approval.credential.token } },
              },
            }),
          );
        },
      },
    });

    const broker = new JobStreamBroker();
    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      streamBroker: broker,
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(transportRegistry, database),
    });

    const created = service.submitJob("ws_jobs", {
      session_key: "svc:remote-live",
      message: "live remote",
      execution_target: "remote",
    });

    await waitFor(() => {
      const stored = service.getJob("ws_jobs", created.job_id).job;
      expect(stored.status).toBe("completed");
      expect(stored.result?.output_text).toBe("live job ok");
    });

    expect(broker.history(created.job_id).map((event) => event.event)).toEqual([
      "job.accepted",
      "job.started",
      "text.delta",
      "job.completed",
    ]);
  });

  test("repairs startup state by failing orphaned jobs and releasing ghost leases", () => {
    database.workspace("ws_jobs").saveNode({
      manifest: {
        node_id: "node_remote_rpc",
        pubkey: "pub",
        signature: "sig",
        adapter_kind: "remote",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["outbound-wss"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
        lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp_remote_rpc",
      status: "approved",
      health_status: "healthy",
    });

    database.workspace("ws_jobs").saveJob({
      job: {
        job_id: "job_orphaned_remote",
        workspace_id: "ws_jobs",
        status: "running",
        created_at: "2024-01-01T00:00:00.000Z",
        started_at: "2024-01-01T00:00:01.000Z",
      },
      task_package: {
        workspace_id: "ws_jobs",
        job_id: "job_orphaned_remote",
        kind: "turn",
        instructions: "recover me",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1_000 },
        lease_profile: { profile_id: "default", ttl_seconds: 300, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    database.workspace("ws_jobs").saveLease({
      workspace_id: "ws_jobs",
      job_id: "job_orphaned_remote",
      lease: {
        lease_id: "lease_orphaned_remote",
        node_id: "node_remote_rpc",
        profile: { profile_id: "default", ttl_seconds: 300, required_capabilities: ["exec"] },
        ttl: 300,
        reset_required: true,
        state: "active",
      },
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    const service = new LocalJobService({
      database,
      internClient: new ScriptedInternClient(() => emptyAsyncIterable()),
      reconcileOnStartup: true,
      startupReconciliationNowMs: Date.parse("2024-01-01T00:10:00.000Z"),
    });

    expect(service.getStartupReconciliationSummary()).toEqual({
      failed_jobs: 1,
      expired_leases: 0,
      released_leases: 1,
      stale_nodes: 0,
    });
    expect(service.getJob("ws_jobs", "job_orphaned_remote").job.status).toBe("failed");
    expect(service.getJob("ws_jobs", "job_orphaned_remote").job.error?.code).toBe("host_restart");
    expect(database.workspace("ws_jobs").getLease("lease_orphaned_remote").lease.state).toBe("released");
  });
});

const parseJsonRecord = (value: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed as Record<string, unknown>;
};

const getRecordValue = (record: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const value = record[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
};

const neverSettlingPromise = <T>(): Promise<T> => new Promise<T>(() => undefined);

const emptyAsyncIterable = <T>(): AsyncIterable<T> => ({
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next(): Promise<IteratorResult<T>> {
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});

const singleEventAsyncIterable = <T>(value: T): AsyncIterable<T> => ({
  [Symbol.asyncIterator](): AsyncIterator<T> {
    let done = false;
    return {
      next(): Promise<IteratorResult<T>> {
        if (done) {
          return Promise.resolve({ done: true, value: undefined });
        }

        done = true;
        return Promise.resolve({ done: false, value });
      },
    };
  },
});

const throwingAsyncIterable = <T>(error: Error): AsyncIterable<T> => ({
  [Symbol.asyncIterator](): AsyncIterator<T> {
    let done = false;
    return {
      next(): Promise<IteratorResult<T>> {
        if (done) {
          return Promise.resolve({ done: true, value: undefined });
        }

        done = true;
        return Promise.reject(error);
      },
    };
  },
});

const waitFor = async (callback: () => void, timeoutMs = 1_000): Promise<void> => {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      callback();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("waitFor failed");
      await Bun.sleep(20);
    }
  }

  throw lastError ?? new Error("waitFor timed out");
};
