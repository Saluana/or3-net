import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import {
  createControlPlaneDatabase,
  JobStreamBroker,
  LeaseScheduler,
  LocalJobService,
  NodeRegistryService,
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
    const sandbox = {
      id: `sbx_${String(this.nextId++)}`,
      status: "ready",
      workspace_id: request.workspace_id,
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

  public createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    return Promise.resolve({
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      url: `https://launch.local/${sandboxId}/${String(request.target_port)}`,
      state: "ready",
    });
  }

  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    void sandboxId;
    return Promise.resolve([]);
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

  test("routes jobs through the remote sandbox path when an approved node is available", async () => {
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
