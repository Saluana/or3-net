import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import {
  createControlPlaneDatabase,
  JobStreamBroker,
  LeaseScheduler,
  LocalJobService,
  NodeRegistryService,
  NodeTransportRegistry,
  RemoteNodeExecutor,
  SandboxNodeAdapter,
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
  CreateSandboxRequest,
  CreateTunnelRequest,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInfo,
  SandboxTunnel,
  SandboxWriteFileRequest,
} from "../sdk/sandbox/index.ts";

type StreamFactory = (request: InternTurnRequest) => AsyncIterable<InternJobEvent>;
type UnsignedManifest = Parameters<typeof signNodeManifest>[0];

class ScriptedInternClient implements InternClient {
  public abortCalls: string[] = [];
  public submitTurnStreamCalls = 0;

  public constructor(private readonly streamFactory: StreamFactory) {}

  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    void request;
    return Promise.resolve({ job_id: "sync_job", status: "completed" });
  }

  public submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    this.submitTurnStreamCalls += 1;
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

class FakeSandboxClient implements SandboxClient {
  public readonly createdSandboxIds: string[] = [];
  public readonly execCalls: { sandboxId: string; request: SandboxExecRequest }[] = [];
  private readonly sandboxes = new Map<string, SandboxInfo>();
  private nextId = 1;

  public create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    const workspaceId = request.workspace_id ?? "ws_jobs";
    const sandbox = {
      id: `sbx_${String(this.nextId++)}`,
      status: "running",
      workspace_id: workspaceId,
    };
    this.createdSandboxIds.push(sandbox.id);
    this.sandboxes.set(sandbox.id, sandbox);
    return Promise.resolve(sandbox);
  }

  public get(sandboxId: string): Promise<SandboxInfo> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    return Promise.resolve(sandbox);
  }

  public delete(sandboxId: string): Promise<void> {
    this.sandboxes.delete(sandboxId);
    return Promise.resolve();
  }

  public list(): Promise<SandboxInfo[]> {
    return Promise.resolve([...this.sandboxes.values()]);
  }

  public start(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public stop(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public suspend(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public resume(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    this.execCalls.push({ sandboxId, request });
    return Promise.resolve({ exit_code: 0, stdout: "ok" });
  }

  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    void sandboxId;
    void request;
    await Promise.resolve();
    yield { event: "result", data: { exit_code: 0 } };
  }

  public writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void> {
    void sandboxId;
    void request;
    return Promise.resolve();
  }

  public readFile(sandboxId: string, path: string): Promise<{ path: string; content: string; encoding?: string }> {
    void sandboxId;
    return Promise.resolve({ path, content: "" });
  }

  public deleteFile(sandboxId: string, path: string): Promise<void> {
    void sandboxId;
    void path;
    return Promise.resolve();
  }

  public mkdir(sandboxId: string, path: string): Promise<void> {
    void sandboxId;
    void path;
    return Promise.resolve();
  }

  public createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    return Promise.resolve({
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      endpoint: `https://launch.local/${sandboxId}/${String(request.target_port)}`,
    });
  }

  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    void sandboxId;
    return Promise.resolve([]);
  }

  public revokeTunnel(tunnelId: string): Promise<void> {
    void tunnelId;
    return Promise.resolve();
  }

  public createSignedTunnelUrl(tunnelId: string): Promise<{ url: string; expires_at: string }> {
    return Promise.resolve({
      url: `https://launch.local/signed/${tunnelId}`,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  }

  public runtimeInfo(): Promise<{ runtime: string }> {
    return Promise.resolve({ runtime: "docker" });
  }

  public runtimeHealth(): Promise<{ status: string }> {
    return Promise.resolve({ status: "ok" });
  }

  public runtimeCapacity(): Promise<{ total: number; available: number }> {
    return Promise.resolve({ total: 1, available: 1 });
  }

  public getQuota(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  public getMetrics(): Promise<string> {
    return Promise.resolve("");
  }
}

class AbortableRemoteTransport {
  public abortCalls = 0;
  public executeCalls = 0;
  public releaseSignal: (() => void) | null = null;

  public create() {
    return {
      kind: "outbound-wss" as const,
      startExecution: async () => {
        this.executeCalls += 1;
        let aborted = false;
        const result = new Promise((resolve: (value: { output_text: string; artifacts: []; meta: { via: string } }) => void, reject) => {
          this.releaseSignal = () => {
            if (aborted) {
              reject(new Error("remote aborted"));
              return;
            }
            resolve({ output_text: "remote complete", artifacts: [], meta: { via: "remote" } });
          };
        });
        return {
          nodeId: "node_remote_rpc",
          stream: (async function* () {
            yield { event: "text.delta", data: { text: "remote working" } } as const;
          })(),
          result,
          abort: async () => {
            aborted = true;
            this.abortCalls += 1;
            this.releaseSignal?.();
          },
        };
      },
    };
  }
}

class FailingRemoteTransport {
  public constructor(
    private readonly mode: "start" | "disconnect" | "stream-disconnect" | "abort",
  ) {}

  public create() {
    return {
      kind: "outbound-wss" as const,
      startExecution: async () => {
        if (this.mode === "start") {
          throw new Error("dial tcp node failed");
        }

        return {
          nodeId: "node_remote_fail",
          result:
            this.mode === "disconnect"
              ? Promise.reject(new Error("connection closed"))
              : this.mode === "stream-disconnect"
                ? new Promise<{ output_text: string; artifacts: []; meta: {} }>(() => undefined)
                : new Promise<{ output_text: string; artifacts: []; meta: {} }>(() => undefined),
          ...(this.mode === "stream-disconnect"
            ? {
                stream: (async function* () {
                  throw new Error("stream connection closed");
                })(),
              }
            : {}),
          abort: async () => {
            if (this.mode === "abort") {
              throw new Error("abort rpc failed");
            }
          },
        };
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
    const service = new LocalJobService({
      database,
      internClient,
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      sandboxNodeAdapter: new SandboxNodeAdapter(sandboxClient),
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
    const service = new LocalJobService({
      database,
      internClient,
      streamBroker: new JobStreamBroker(),
      leaseScheduler: new LeaseScheduler({ database }),
      sandboxNodeAdapter: new SandboxNodeAdapter(sandboxClient),
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
      expect(stored.result?.meta["sandbox_id"]).toBe("sbx_1");
    });

    expect(internClient.submitTurnStreamCalls).toBe(0);
    expect(sandboxClient.execCalls).toHaveLength(1);
    expect(database.workspace("ws_jobs").listLeases()).toHaveLength(1);
    expect(database.workspace("ws_jobs").listLeases()[0]?.lease.state).toBe("released");
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
      internClient: new ScriptedInternClient(async function* () {}),
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
      internClient: new ScriptedInternClient(async function* () {}),
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
      internClient: new ScriptedInternClient(async function* () {}),
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
      internClient: new ScriptedInternClient(async function* () {}),
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

    await expect(service.abortJob("ws_jobs", created.job_id)).rejects.toThrow("abort rpc failed");

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
      internClient: new ScriptedInternClient(async function* () {}),
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
