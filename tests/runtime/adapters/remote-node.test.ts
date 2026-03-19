import { describe, expect, test } from "bun:test";

import { RemoteExecutionError } from "../../../src/nodes/transport.ts";
import {
  createId,
  hashApiKey,
  LeaseScheduler,
  NodeTransportRegistry,
  OutboundWssNodeTransport,
  RemoteNodeRuntimeAdapter,
  RuntimeError,
  RuntimeCapabilitySet,
  runtimePtyCapability,
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
      remoteNodeExecutor: new FakeRemoteExecutorWithSendRequest(),
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
        metadata: { session_id: "sess_1" },
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

  test("createSession accepts ext PTY requirement when the node manifest advertises plain pty", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const ptyNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", "pty"],
        supports_transports: ["outbound-wss"],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: ptyNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });
    database.workspace("ws_test").saveNodeCredential({
      credential_id: createId("cred"),
      node_id: ptyNode.manifest.node_id,
      token_hash: await hashApiKey("cred_token"),
      token_ciphertext: "cred_token",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    const transportRegistry = new NodeTransportRegistry();
    transportRegistry.registerNodeTransport("ws_test", ptyNode.manifest.node_id, new OutboundWssNodeTransport());

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [ptyNode] },
      leaseScheduler: new LeaseScheduler({ database, transportRegistry }),
      remoteNodeExecutor: new FakeRemoteExecutorWithSendRequest(),
    });

    const created = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_pty_req",
      config: {
        required_capabilities: RuntimeCapabilitySet.fromValues([runtimePtyCapability]),
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

    expect(created.capabilities).toEqual(RuntimeCapabilitySet.fromValues(["exec", runtimePtyCapability]));
  });

  test("node capabilities derive from manifest capabilities", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const fileNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        node_id: "node_files",
        capabilities: ["exec", "file-read", "file-write"],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: fileNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [fileNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_files", node_id: "node_files", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });

    const nodes = await adapter.listNodes({ workspace_id: "ws_test" });
    expect(nodes[0]?.capabilities).toEqual(
      RuntimeCapabilitySet.fromValues(["exec", "copy-out", "file-browse", "copy-in", "file-rw"]),
    );
  });

  test("node capabilities include PTY when the manifest advertises it", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const ptyNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", runtimePtyCapability],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: ptyNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [ptyNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_pty", node_id: "node_pty", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });

    const nodes = await adapter.listNodes({ workspace_id: "ws_test" });
    expect(nodes[0]?.capabilities).toEqual(RuntimeCapabilitySet.fromValues(["exec", runtimePtyCapability]));
  });

  test("copyIn sends file_write RPC and returns transfer result", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const fileNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", "file-write"],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: fileNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    executor.sendRequestResult = {
      id: "rpc_1",
      result: { output_text: "ok", artifacts: [], meta: { bytes_transferred: 42 } },
    };

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [fileNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_copy", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_copy", "node_remote_1");

    const result = await adapter.copyIn({
      workspace_id: "ws_test",
      session_ref: "lease_copy",
      destination_path: "/app/test.txt",
      content_text: "hello",
      overwrite: true,
    });

    expect(result.path).toBe("/app/test.txt");
    expect(result.bytes_transferred).toBe(42);
    expect(executor.lastSentRequest?.method).toBe("file_write");
  });

  test("PTY lifecycle sends PTY RPCs and returns the opened PTY id", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const ptyNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", runtimePtyCapability],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: ptyNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    executor.sendRequestResult = {
      id: "rpc_pty_open",
      result: { output_text: "pty opened", artifacts: [], meta: { pty_id: "pty_remote_1" } },
    };

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [ptyNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_pty", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_pty", "node_remote_1", "sess_pty");

    const opened = await adapter.openPty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      cols: 80,
      rows: 24,
      command: "bash",
      args: ["-l"],
      env: {},
      cwd: "/workspace",
    });
    const written = await adapter.writePty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      pty_id: opened.pty_id,
      data: "echo hello\n",
    });
    expect(executor.lastSentRequest?.method).toBe("pty_input");
    expect(executor.lastSentRequest?.params?.["data"]).toBe("echo hello\n");
    const resized = await adapter.resizePty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      pty_id: opened.pty_id,
      cols: 100,
      rows: 40,
    });
    const closed = await adapter.closePty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      pty_id: opened.pty_id,
    });
    const streamedEvents: { event: string; data: Record<string, unknown> }[] = [];
    for await (const event of await adapter.streamPty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      pty_id: opened.pty_id,
    })) {
      streamedEvents.push(event as unknown as { event: string; data: Record<string, unknown> });
    }

    expect(opened.pty_id).toBe("pty_remote_1");
    expect(written.accepted).toBe(true);
    expect(resized.resized).toBe(true);
    expect(closed.closed).toBe(true);
    expect(executor.lastSentRequest?.method).toBe("pty_close");
    expect(executor.lastSentRequest?.params?.["pty_id"]).toBe(opened.pty_id);
    expect(streamedEvents).toEqual([
      { event: "pty.output", data: { pty_id: "pty_remote_1", text: "hello from remote pty" } },
      { event: "pty.exit", data: { pty_id: "pty_remote_1", exit_code: 0, signal: null } },
    ]);
  });

  test("openPty fails clearly when the transport cannot stream PTY events", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const ptyNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", runtimePtyCapability],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: ptyNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [ptyNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_pty", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutorWithSendRequest(false),
    });

    setupLeaseForSession(database, "lease_pty", "node_remote_1", "sess_pty");

    await expectRuntimeError(adapter.openPty({
      workspace_id: "ws_test",
      session_ref: "lease_pty",
      cols: 80,
      rows: 24,
      command: "bash",
      args: [],
      env: {},
      cwd: "/workspace",
    }), "adapter_unavailable");
  });

  test("copyIn rejects for nodes without file-write capability", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    // exec-only node, no file-write
    const node = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec"],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: node.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [node] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_nocopy", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_nocopy", "node_remote_1");

    await expectRuntimeError(
      adapter.copyIn({
        workspace_id: "ws_test",
        session_ref: "lease_nocopy",
        destination_path: "/app/test.txt",
        content_text: "hello",
        overwrite: true,
      }),
      "unsupported_capability",
    );
  });

  test("getLogs preserves system chunks from the remote node", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });
    const node = makeRemoteNode();
    database.workspace("ws_test").saveNode({
      manifest: node.manifest,
      pubkey_fingerprint: "fp",
      status: "approved",
      health_status: "healthy",
    });
    const executor = new FakeRemoteExecutorWithSendRequest();
    executor.sendRequestResult = {
      id: "rpc_logs",
      result: {
        output_text: "",
        artifacts: [],
        meta: {
          chunks: [
            { stream: "stdout", message: "hello", cursor: "1", created_at: "2024-01-01T00:00:00.000Z" },
            { stream: "system", message: "output truncated", cursor: "2", created_at: "2024-01-01T00:00:01.000Z" },
          ],
          next_cursor: "2",
        },
      },
    };

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [node] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_logs", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_logs", "node_remote_1");

    const result = await adapter.getLogs({ workspace_id: "ws_test", session_ref: "lease_logs" });

    expect(result.chunks.map((chunk) => chunk.stream)).toEqual(["stdout", "system"]);
    expect(result.next_cursor).toBe("2");
  });

  test("copyOut sends file_read RPC and returns content", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const fileNode = makeRemoteNode({
      manifest: {
        ...makeRemoteNode().manifest,
        capabilities: ["exec", "file-read"],
      },
    });
    database.workspace("ws_test").saveNode({ manifest: fileNode.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    executor.sendRequestResult = {
      id: "rpc_1",
      result: { output_text: "file content here", artifacts: [], meta: { size_bytes: 17 } },
    };

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [fileNode] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_out", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_out", "node_remote_1");

    const result = await adapter.copyOut({
      workspace_id: "ws_test",
      session_ref: "lease_out",
      source_path: "/app/test.txt",
      encoding: "text",
    });

    expect(result.path).toBe("/app/test.txt");
    expect(result.bytes_transferred).toBe(17);
    expect(result.content_text).toBe("file content here");
    expect(executor.lastSentRequest?.method).toBe("file_read");
  });

  test("getLogs sends get_logs RPC and returns log chunks", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const node = makeRemoteNode();
    database.workspace("ws_test").saveNode({ manifest: node.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    executor.sendRequestResult = {
      id: "rpc_1",
      result: {
        output_text: "logs",
        artifacts: [],
        meta: {
          chunks: [
            { stream: "stdout", message: "hello", cursor: "1" },
            { stream: "stderr", message: "warn", cursor: "2" },
          ],
          next_cursor: "3",
        },
      },
    };

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [node] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_logs", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_logs", "node_remote_1", "sess_logs");

    const logs = await adapter.getLogs({
      workspace_id: "ws_test",
      session_ref: "lease_logs",
    });

    expect(logs.chunks.length).toBe(2);
    expect(logs.chunks[0]?.stream).toBe("stdout");
    expect(logs.chunks[0]?.message).toBe("hello");
    expect(logs.chunks[1]?.stream).toBe("stderr");
    expect(logs.next_cursor).toBe("3");
    expect(executor.lastSentRequest?.params?.["session_id"]).toBe("sess_logs");
  });

  test("getLogs returns empty when node not found for session", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_new", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => undefined,
      },
      remoteNodeExecutor: new FakeRemoteExecutor(),
    });

    const logs = await adapter.getLogs({
      workspace_id: "ws_test",
      session_ref: "nonexistent_lease",
    });

    expect(logs.chunks).toEqual([]);
  });

  test("destroySession sends destroy_session RPC to agent", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_test", name: "Test", created_at: "2024-01-01T00:00:00.000Z" });

    const node = makeRemoteNode();
    database.workspace("ws_test").saveNode({ manifest: node.manifest, pubkey_fingerprint: "fp", status: "approved", health_status: "healthy" });

    const executor = new FakeRemoteExecutorWithSendRequest();
    let released = false;

    const adapter = new RemoteNodeRuntimeAdapter({
      database,
      nodeRegistryService: { listNodes: () => [node] },
      leaseScheduler: {
        issueLease: () => ({ lease: { lease_id: "lease_destroy", node_id: "node_remote_1", state: "active" } }),
        releaseLease: () => { released = true; },
      },
      remoteNodeExecutor: executor,
    });

    setupLeaseForSession(database, "lease_destroy", "node_remote_1", "sess_destroy");

    const result = await adapter.destroySession({ workspace_id: "ws_test", session_ref: "lease_destroy" });
    expect(result.destroyed).toBe(true);
    expect(released).toBe(true);
    // Give the fire-and-forget RPC time to be dispatched
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.lastSentRequest?.method).toBe("destroy_session");
    expect(executor.lastSentRequest?.params?.["session_id"]).toBe("sess_destroy");
  });
});

/** Extended fake executor that also supports sendRequest for file/log RPCs. */
class FakeRemoteExecutorWithSendRequest extends FakeRemoteExecutor {
  public constructor(private readonly supportsStreaming = true) {
    super();
  }

  public sendRequestResult: {
    id: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> };
  } = { id: "rpc_default", result: { output_text: "ok", artifacts: [], meta: {} } };

  public lastSentRequest: { id: string; method: string; params?: Record<string, unknown> } | null = null;
  public streamingEvents: { event: string; data: Record<string, unknown> }[] = [
    { event: "pty_output", data: { pty_id: "pty_remote_1", text: "hello from remote pty" } },
    { event: "pty_exit", data: { pty_id: "pty_remote_1", exit_code: 0, signal: null } },
  ];

  public sendRequest(
    _node: StoredNode,
    request: { id: string; method: string; params?: Record<string, unknown> },
  ): Promise<{ id: string; result?: Record<string, unknown>; error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> } }> {
    this.lastSentRequest = request;
    return Promise.resolve({ ...this.sendRequestResult, id: request.id });
  }

  public sendStreamingRequest(
    _node: StoredNode,
    request: { id: string; method: string; params?: Record<string, unknown> },
  ): Promise<{ response: Promise<{ id: string; result?: Record<string, unknown>; error?: { code: string; message: string; retriable: boolean; details: Record<string, unknown> } }>; stream: AsyncIterable<{ event: string; data: Record<string, unknown> }> }> {
    if (!this.supportsStreaming) {
      throw new Error("streaming unavailable");
    }
    this.lastSentRequest = request;
    return Promise.resolve({
      response: Promise.resolve({ ...this.sendRequestResult, id: request.id }),
      stream: {
        async *[Symbol.asyncIterator](): AsyncIterator<{ event: string; data: Record<string, unknown> }> {
          for (const event of [
            { event: "pty_output", data: { pty_id: "pty_remote_1", text: "hello from remote pty" } },
            { event: "pty_exit", data: { pty_id: "pty_remote_1", exit_code: 0, signal: null } },
          ]) {
            await Promise.resolve();
            yield event;
          }
        },
      },
    });
  }
}

/** Helper to persist the lease record needed by session-aware adapter methods. */
const setupLeaseForSession = (
  database: ReturnType<typeof createControlPlaneDatabase>,
  leaseId: string,
  nodeId: string,
  sessionId = leaseId,
): void => {
  database.workspace("ws_test").saveJob({
    job: { job_id: `job_${leaseId}`, workspace_id: "ws_test", status: "pending", created_at: "2024-01-01T00:00:00.000Z" },
    task_package: {
      workspace_id: "ws_test",
      job_id: `job_${leaseId}`,
      kind: "runtime-session",
      instructions: "noop",
      artifacts: [],
      tool_policy: { mode: "deny_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1000 },
      lease_profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: { session_id: sessionId },
    },
  });
  database.workspace("ws_test").saveLease({
    workspace_id: "ws_test",
    job_id: `job_${leaseId}`,
    lease: {
      lease_id: leaseId,
      node_id: nodeId,
      profile: { profile_id: "runtime", ttl_seconds: 60, required_capabilities: ["exec"] },
      ttl: 60,
      reset_required: true,
      state: "active",
    },
    expires_at: "2024-01-01T00:01:00.000Z",
  });
};

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
