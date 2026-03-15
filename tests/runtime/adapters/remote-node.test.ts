import { describe, expect, test } from "bun:test";

import { RemoteExecutionError } from "../../../src/nodes/transport.ts";
import {
  RemoteNodeRuntimeAdapter,
  RuntimeError,
  RuntimeCapabilitySet,
  createControlPlaneDatabase,
} from "../../../src/index.ts";
import type { NodeExecutionHandle, StoredNode, TaskPackage } from "../../../src/index.ts";

const makeRemoteNode = (overrides: Partial<StoredNode> = {}): StoredNode => ({
  workspace_id: "ws_test",
  manifest: {
    node_id: "node_remote_1",
    pubkey: "pub",
    signature: "sig",
    adapter_kind: "remote",
    capabilities: ["exec", "copy-in"],
    isolation_class: "remote-node",
    supports_transports: ["https"],
    resource_limits: { max_concurrent_jobs: 2, cpu_cores: 2, memory_mb: 1024, disk_mb: 2048 },
    lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
    version: "1.0.0",
  },
  pubkey_fingerprint: "fp",
  status: "approved",
  health_status: "healthy",
  approved_at: "2024-01-01T00:00:00.000Z",
  revoked_at: null,
  last_seen_at: "2024-01-01T00:00:00.000Z",
  last_error: null,
  created_at: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

class FakeRemoteExecutor {
  public heartbeatError: Error | null = null;
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
    if (this.heartbeatError !== null) {
      return Promise.reject(this.heartbeatError);
    }
    return Promise.resolve();
  }
  public canExecute(): boolean {
    return true;
  }
}

describe("remote node runtime adapter", () => {
  test("exec produces equivalent results to direct RemoteNodeExecutor.executeTask", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    database.workspace("ws_test").saveNode({ manifest: makeRemoteNode().manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });
    database.workspace("ws_test").saveJob({
      job: { job_id: "job_1", workspace_id: "ws_test", status: "pending", created_at: "2024-01-01T00:00:00.000Z" },
      task_package: {
        workspace_id: "ws_test",
        job_id: "job_1",
        kind: "runtime-session",
        instructions: "noop",
        artifacts: [],
        tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    database.workspace("ws_test").saveLease({
      workspace_id: "ws_test",
      job_id: "job_1",
      lease: {
        lease_id: "lease_1",
        node_id: "node_remote_1",
        profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      expires_at: "2024-01-01T00:01:00.000Z",
    });

    const executor = new FakeRemoteExecutor();
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [makeRemoteNode()] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: "lease_1",
      request: { command: "echo", args: ["hello"], env: {}, background: false },
    });
    const result = await handle.result;

    expect(result.stdout).toBe("echo hello");
  });

  test("health delegates to heartbeat correctly", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [makeRemoteNode()] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });

    const health = await adapter.health({ workspace_id: "ws_test" });
    expect(health.status).toBe("healthy");
  });

  test("error mapping from RemoteExecutionError to RuntimeError", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    const executor = new FakeRemoteExecutor();
    executor.heartbeatError = new RemoteExecutionError("remote_execution_start_failed", "boom");
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [makeRemoteNode()] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    await expectRuntimeError(adapter.health({ workspace_id: "ws_test" }), "adapter_unavailable");
  });

  test("node listing filters correctly", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: {
        listNodes: () => [
          makeRemoteNode(),
          makeRemoteNode({ manifest: { ...makeRemoteNode().manifest, node_id: "node_pending" }, status: "pending" }),
          makeRemoteNode({ manifest: { ...makeRemoteNode().manifest, node_id: "node_local", adapter_kind: "local" } }),
        ],
      },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });

    const nodes = await adapter.listNodes({ workspace_id: "ws_test" });
    expect(nodes.map((node) => node.node_id)).toEqual(["node_remote_1"]);
    expect(nodes[0]?.capabilities).toEqual(RuntimeCapabilitySet.fromValues(["exec"]));
  });

  test("createSession and getSession only expose implemented adapter capabilities", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [makeRemoteNode()] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });
    database.workspace("ws_test").saveNode({ manifest: makeRemoteNode().manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const created = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_1",
      config: {
        workspace_mode: "none",
        network_policy: { internet_access: false, ingress: "none" },
        resource_hints: { metadata: {} },
        persistence_mode: "ephemeral",
        env_refs: [],
        secret_refs: [],
        timeout_rules: {},
        artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
      },
    });
    database.workspace("ws_test").saveJob({
      job: { job_id: "job_lease", workspace_id: "ws_test", status: "pending", created_at: "2024-01-01T00:00:00.000Z" },
      task_package: {
        workspace_id: "ws_test",
        job_id: "job_lease",
        kind: "runtime-session",
        instructions: "noop",
        artifacts: [],
        tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    database.workspace("ws_test").saveLease({
      workspace_id: "ws_test",
      job_id: "job_lease",
      lease: {
        lease_id: "lease_new",
        node_id: "node_remote_1",
        profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      expires_at: "2024-01-01T00:01:00.000Z",
    });

    const stored = await adapter.getSession({ workspace_id: "ws_test", session_ref: "lease_new" });

    expect(created.capabilities).toEqual(RuntimeCapabilitySet.fromValues(["exec"]));
    expect(stored?.capabilities).toEqual(RuntimeCapabilitySet.fromValues(["exec"]));
  });
});

const expectRuntimeError = async (promise: Promise<unknown>, code: RuntimeError["code"]): Promise<void> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  throw new Error("expected RuntimeError");
};
