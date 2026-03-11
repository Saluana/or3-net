import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { AuthService, createControlPlaneDatabase, handleAppRequest, LeaseScheduler, LocalJobService, NodeRegistryService, NodeTransportRegistry, Or3NetApp, OutboundWssNodeTransport, RemoteNodeExecutor, signNodeManifest } from "../src/index.ts";
import type { SessionProofValidator } from "../src/auth/service.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";

type UnsignedManifest = Parameters<typeof signNodeManifest>[0];

class NodePhaseValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "user_node_admin",
      workspace_id: "ws_nodes",
      scopes: ["jobs:read", "jobs:write", "nodes:read", "nodes:write"],
    });
  }
}

class NoopInternClient implements InternClient {
  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    void request;
    return Promise.resolve({ job_id: "noop", status: "completed" });
  }
  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    void request;
    await Promise.resolve();
    yield { event: "queued", data: { job_id: "noop", status: "queued" } };
  }
  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    void request;
    return Promise.resolve({ job_id: "sub", child_session_key: "svc:sub", status: "queued" });
  }
  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "queued", data: { job_id: jobId, status: "queued" } };
  }
  public abortJob(jobId: string): Promise<InternAbortResponse> {
    return Promise.resolve({ ok: true, job_id: jobId });
  }
}

describe("phase 3 node control plane", () => {
  let database = createControlPlaneDatabase();
  let authService: AuthService;
  let nodeRegistry: NodeRegistryService;
  let app: Or3NetApp;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_nodes",
      name: "Nodes Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    database.saveWorkspace({
      workspace_id: "ws_other",
      name: "Other Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    authService = new AuthService({
      secret: "phase3-secret",
      database,
      sessionProofValidator: new NodePhaseValidator(),
    });
    nodeRegistry = new NodeRegistryService({ database });
    app = new Or3NetApp({
      authService,
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
      nodeRegistryService: nodeRegistry,
    });
  });

  afterEach(() => {
    database.close();
  });

  test("enrolls and approves a signed node manifest through the host API", async () => {
    const token = await exchangeAdminToken(app);
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_alpha",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox" as const,
      capabilities: ["exec", "network"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: {
        max_concurrent_jobs: 2,
        cpu_cores: 4,
        memory_mb: 4096,
        disk_mb: 8192,
      },
      lease_policy: {
        max_ttl_seconds: 300,
        supports_warm_pool: true,
        reset_methods: ["process_kill", "fs_scrub"],
      },
      version: "1.0.0",
    };
    const manifest = {
      ...unsignedManifest,
      signature: signNodeManifest(unsignedManifest, keyPair.secretKey),
    };

    const enrollResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_nodes/nodes/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(manifest),
      }),
    );

    expect(enrollResponse.status).toBe(202);
    const enrolledNode = (await enrollResponse.json()) as { node: { status: string } };
    expect(enrolledNode.node.status).toBe("pending");

    const approveResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_nodes/nodes/node_alpha/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const approval = (await approveResponse.json()) as {
      node: { status: string };
      credential: { token: string; expires_at: string };
    };

    expect(approval.node.status).toBe("approved");
    expect(approval.credential.token.startsWith("or3n_")).toBeTrue();
    expect(database.workspace("ws_nodes").listNodeCredentials("node_alpha")).toHaveLength(1);
  });

  test("matches the least-busy approved node and issues a lease", async () => {
    const keyPair = nacl.sign.keyPair();
    const makeManifest = (nodeId: string, maxConcurrentJobs: number): UnsignedManifest & { signature: string } => {
      const unsignedManifest: UnsignedManifest = {
        node_id: nodeId,
        pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
        adapter_kind: "sandbox" as const,
        capabilities: ["exec", "network"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: {
          max_concurrent_jobs: maxConcurrentJobs,
          cpu_cores: 4,
          memory_mb: 4096,
          disk_mb: 8192,
        },
        lease_policy: {
          max_ttl_seconds: 300,
          supports_warm_pool: true,
          reset_methods: ["process_kill"],
        },
        version: "1.0.0",
      };
      return {
        ...unsignedManifest,
        signature: signNodeManifest(unsignedManifest, keyPair.secretKey),
      };
    };

    await nodeRegistry.enrollNode("ws_nodes", makeManifest("node_a", 2));
    await nodeRegistry.enrollNode("ws_nodes", makeManifest("node_b", 2));
    await nodeRegistry.approveNode("ws_nodes", "node_a");
    await nodeRegistry.approveNode("ws_nodes", "node_b");

    const workspaceStore = database.workspace("ws_nodes");
    workspaceStore.saveJob({
      job: {
        job_id: "job_existing",
        workspace_id: "ws_nodes",
        status: "scheduled",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_nodes",
        job_id: "job_existing",
        kind: "turn",
        instructions: "existing",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1_000 },
        lease_profile: { profile_id: "default", ttl_seconds: 120, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    workspaceStore.saveLease({
      workspace_id: "ws_nodes",
      job_id: "job_existing",
      lease: {
        lease_id: "lease_existing",
        node_id: "node_a",
        profile: { profile_id: "default", ttl_seconds: 120, required_capabilities: ["exec"] },
        ttl: 120,
        reset_required: true,
        state: "active",
      },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    workspaceStore.saveJob({
      job: {
        job_id: "job_new",
        workspace_id: "ws_nodes",
        status: "pending",
        created_at: "2024-01-01T00:00:01.000Z",
      },
      task_package: {
        workspace_id: "ws_nodes",
        job_id: "job_new",
        kind: "turn",
        instructions: "schedule me",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1_000 },
        lease_profile: { profile_id: "default", ttl_seconds: 120, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    const scheduler = new LeaseScheduler({ database });
    const lease = scheduler.issueLease({
      workspace_id: "ws_nodes",
      job_id: "job_new",
      task_package: workspaceStore.getJob("job_new").task_package,
    });

    expect(lease.lease.node_id).toBe("node_b");
  });

  test("rejects reenrollment when a node id is reused with a different public key", async () => {
    const firstKeyPair = nacl.sign.keyPair();
    const secondKeyPair = nacl.sign.keyPair();
    const firstManifest: UnsignedManifest = {
      node_id: "node_reused",
      pubkey: Buffer.from(firstKeyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    const secondManifest: UnsignedManifest = {
      ...firstManifest,
      pubkey: Buffer.from(secondKeyPair.publicKey).toString("base64"),
    };

    await nodeRegistry.enrollNode("ws_nodes", {
      ...firstManifest,
      signature: signNodeManifest(firstManifest, firstKeyPair.secretKey),
    });

    expect(
      nodeRegistry.enrollNode("ws_nodes", {
        ...secondManifest,
        signature: signNodeManifest(secondManifest, secondKeyPair.secretKey),
      }),
    ).rejects.toThrow("node id already exists with a different public key");
  });

  test("re-enrollment resets changed node manifests back to pending while preserving health", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifestV1: UnsignedManifest = {
      node_id: "node_refresh",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };

    await nodeRegistry.enrollNode("ws_nodes", {
      ...manifestV1,
      signature: signNodeManifest(manifestV1, keyPair.secretKey),
    });
    await nodeRegistry.approveNode("ws_nodes", "node_refresh");
    database.workspace("ws_nodes").saveNode({
      manifest: {
        ...manifestV1,
        signature: signNodeManifest(manifestV1, keyPair.secretKey),
      },
      pubkey_fingerprint: database.workspace("ws_nodes").getNode("node_refresh").pubkey_fingerprint,
      status: "approved",
      health_status: "healthy",
      approved_at: "2024-01-01T00:00:00.000Z",
      last_seen_at: "2024-01-01T00:00:00.000Z",
    });

    const manifestV2: UnsignedManifest = {
      ...manifestV1,
      capabilities: ["exec", "network"],
      version: "1.1.0",
    };
    const reenrolled = await nodeRegistry.enrollNode("ws_nodes", {
      ...manifestV2,
      signature: signNodeManifest(manifestV2, keyPair.secretKey),
    });

    expect(reenrolled.status).toBe("pending");
    expect(reenrolled.health_status).toBe("healthy");
    expect(reenrolled.manifest.capabilities).toEqual(["exec", "network"]);
  });

  test("rotates older node credentials and applies the configured credential ttl", async () => {
    const keyPair = nacl.sign.keyPair();
    const registry = new NodeRegistryService({ database, credentialTtlMs: 5_000 });
    const manifest: UnsignedManifest = {
      node_id: "node_rotating",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };

    await registry.enrollNode("ws_nodes", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    const first = await registry.approveNode("ws_nodes", "node_rotating");
    const second = await registry.approveNode("ws_nodes", "node_rotating");

    const credentials = database.workspace("ws_nodes").listNodeCredentials("node_rotating");
    expect(credentials).toHaveLength(2);
    expect(credentials.some((credential) => credential.rotated_at === null)).toBeTrue();
    expect(credentials.some((credential) => credential.rotated_at !== null)).toBeTrue();

    const ttlMs = Date.parse(second.credential.expires_at) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5_000);
    expect(first.credential.token).not.toBe(second.credential.token);
  });

  test("uses the same scheduler path for outbound-wss nodes", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_wss",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "remote",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["outbound-wss"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };

    await nodeRegistry.enrollNode("ws_nodes", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_nodes", "node_wss");

    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport(
      "node_wss",
      new OutboundWssNodeTransport((request) =>
        Promise.resolve({
          id: request.id,
          result: { output_text: "remote wss", artifacts: [], meta: { transport: "outbound-wss" } },
        }),
      ),
    );
    const jobService = new LocalJobService({
      database,
      internClient: new NoopInternClient(),
      leaseScheduler: new LeaseScheduler({ database }),
      remoteNodeExecutor: new RemoteNodeExecutor(registry),
    });

    const created = jobService.submitJob("ws_nodes", {
      session_key: "svc:wss",
      message: "run remote",
    });

    await waitFor(() => {
      const stored = jobService.getJob("ws_nodes", created.job_id);
      expect(stored.job.status).toBe("completed");
      expect(stored.job.result?.output_text).toBe("remote wss");
      expect(stored.job.node_id).toBe("node_wss");
    });
  });

  test("skips expired leases and blocks cross-workspace node access", async () => {
    const keyPair = nacl.sign.keyPair();
    const manifest: UnsignedManifest = {
      node_id: "node_isolated",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    await nodeRegistry.enrollNode("ws_nodes", { ...manifest, signature: signNodeManifest(manifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_nodes", "node_isolated");

    const store = database.workspace("ws_nodes");
    store.saveJob({
      job: { job_id: "job_expired", workspace_id: "ws_nodes", status: "scheduled", created_at: "2024-01-01T00:00:00.000Z" },
      task_package: {
        workspace_id: "ws_nodes",
        job_id: "job_expired",
        kind: "turn",
        instructions: "old",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    store.saveLease({
      workspace_id: "ws_nodes",
      job_id: "job_expired",
      lease: {
        lease_id: "lease_expired",
        node_id: "node_isolated",
        profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    store.saveJob({
      job: { job_id: "job_new_capacity", workspace_id: "ws_nodes", status: "pending", created_at: "2024-01-01T00:01:00.000Z" },
      task_package: {
        workspace_id: "ws_nodes",
        job_id: "job_new_capacity",
        kind: "turn",
        instructions: "new",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    const lease = new LeaseScheduler({ database }).issueLease({
      workspace_id: "ws_nodes",
      job_id: "job_new_capacity",
      task_package: store.getJob("job_new_capacity").task_package,
    });
    expect(lease.lease.node_id).toBe("node_isolated");
    expect(store.getLease("lease_expired").lease.state).toBe("expired");

    const { api_key: otherKey } = await authService.createApiKey({
      workspace_id: "ws_other",
      name: "other-nodes-key",
      scopes: ["nodes:read", "nodes:write"],
    });
    const listResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_nodes/nodes", {
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
    );
    expect(listResponse.status).toBe(403);
  });
});

const waitFor = async (callback: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> => {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await callback();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("waitFor failed");
      await Bun.sleep(20);
    }
  }

  throw lastError ?? new Error("waitFor timed out");
};

const exchangeAdminToken = async (app: Or3NetApp): Promise<string> => {
  const response = await handleAppRequest(
    app,
    new Request("http://or3.test/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "test", session_proof: { ok: true }, workspace_id: "ws_nodes" }),
    }),
  );
  const payload = (await response.json()) as { token: string };
  return payload.token;
};
