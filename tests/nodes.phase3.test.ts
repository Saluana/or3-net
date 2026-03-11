import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { AuthService, createControlPlaneDatabase, handleAppRequest, LeaseScheduler, LocalJobService, NodeRegistryService, Or3NetApp, signNodeManifest } from "../src/index.ts";
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
});

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