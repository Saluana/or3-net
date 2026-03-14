import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createControlPlaneDatabase } from "../src/index.ts";

describe("control plane database", () => {
  let database = createControlPlaneDatabase();

  beforeEach(() => {
    database = createControlPlaneDatabase();
  });

  afterEach(() => {
    database.close();
  });

  test("initializes schema migrations and persists workspace-scoped records", () => {
    database.saveWorkspace({
      workspace_id: "ws_alpha",
      name: "Alpha",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      config: {
        region: "local",
      },
    });
    database.saveWorkspace({
      workspace_id: "ws_beta",
      name: "Beta",
      created_at: "2024-01-02T00:00:00.000Z",
    });

    const alphaStore = database.workspace("ws_alpha");
    const betaStore = database.workspace("ws_beta");

    alphaStore.saveAgent({
      agent_id: "agent_alpha",
      workspace_id: "ws_alpha",
      name: "Alpha Agent",
      instructions: "Help alpha",
      tool_policy: {
        mode: "allow_all",
        allowed_tools: [],
        blocked_tools: [],
      },
      node_requirements: {
        capabilities: ["exec"],
        preferred_node_ids: [],
      },
    });

    betaStore.saveAgent({
      agent_id: "agent_beta",
      workspace_id: "ws_beta",
      name: "Beta Agent",
      instructions: "Help beta",
      tool_policy: {
        mode: "deny_all",
        allowed_tools: [],
        blocked_tools: [],
      },
      node_requirements: {
        capabilities: ["file_io"],
        preferred_node_ids: [],
      },
    });

    expect(alphaStore.listAgents()).toHaveLength(1);
    expect(betaStore.listAgents()).toHaveLength(1);
    expect(alphaStore.listAgents()[0]?.workspace_id).toBe("ws_alpha");
    expect(betaStore.listAgents()[0]?.workspace_id).toBe("ws_beta");
  });

  test("stores jobs, leases, previews, and nodes inside the workspace boundary", () => {
    database.saveWorkspace({
      workspace_id: "ws_alpha",
      name: "Alpha",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    const store = database.workspace("ws_alpha");

    store.saveNode({
      manifest: {
        node_id: "node_1",
        pubkey: "pub",
        signature: "sig",
        adapter_kind: "sandbox",
        capabilities: ["exec", "network"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: {
          max_concurrent_jobs: 1,
          cpu_cores: 2,
          memory_mb: 2048,
          disk_mb: 4096,
        },
        lease_policy: {
          max_ttl_seconds: 300,
          supports_warm_pool: true,
          reset_methods: ["process_kill", "fs_scrub"],
        },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp_1",
      status: "approved",
      health_status: "healthy",
      last_seen_at: "2024-01-01T00:00:10.000Z",
    });

    store.saveJob({
      job: {
        job_id: "job_1",
        workspace_id: "ws_alpha",
        status: "running",
        node_id: "node_1",
        created_at: "2024-01-01T00:00:00.000Z",
        started_at: "2024-01-01T00:00:05.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_1",
        kind: "turn",
        instructions: "Do the thing",
        artifacts: [],
        tool_policy: {
          mode: "allow_all",
          allowed_tools: [],
          blocked_tools: [],
        },
        timeout: {
          soft_ms: 10_000,
        },
        lease_profile: {
          profile_id: "default",
          ttl_seconds: 120,
          required_capabilities: ["exec"],
        },
        subagent_policy: {
          enabled: false,
          max_depth: 0,
          max_jobs: 0,
        },
        metadata: {},
      },
    });

    store.saveLease({
      workspace_id: "ws_alpha",
      job_id: "job_1",
      lease: {
        lease_id: "lease_1",
        node_id: "node_1",
        profile: {
          profile_id: "default",
          ttl_seconds: 120,
          required_capabilities: ["exec"],
        },
        ttl: 120,
        reset_required: true,
        state: "active",
      },
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2024-01-01T00:01:00.000Z",
    });

    store.savePreview({
      preview: {
        preview_id: "preview_1",
        workspace_id: "ws_alpha",
        node_id: "node_1",
        kind: "dashboard",
        delivery_mode: "external",
        source_type: "live-service",
        service_id: "openclaw",
        port: 3000,
        status: "ready",
        launch_url: "https://launch.example/preview_1",
        supports_iframe: false,
        supports_new_tab: true,
      },
    });

    expect(store.listNodes()).toHaveLength(1);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listLeases()).toHaveLength(1);
    expect(store.listPreviews()).toHaveLength(1);
    expect(store.getJob("job_1").job.node_id).toBe("node_1");
  });

  test("reconciles in-progress jobs, expired leases, and stale nodes on startup", () => {
    database.saveWorkspace({
      workspace_id: "ws_alpha",
      name: "Alpha",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    const store = database.workspace("ws_alpha");

    store.saveNode({
      manifest: {
        node_id: "node_1",
        pubkey: "pub",
        signature: "sig",
        adapter_kind: "sandbox",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: {
          max_concurrent_jobs: 1,
          cpu_cores: 2,
          memory_mb: 2048,
          disk_mb: 4096,
        },
        lease_policy: {
          max_ttl_seconds: 300,
          supports_warm_pool: true,
          reset_methods: ["process_kill"],
        },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp_1",
      status: "approved",
      health_status: "healthy",
      last_seen_at: "2024-01-01T00:00:00.000Z",
    });

    store.saveJob({
      job: {
        job_id: "job_1",
        workspace_id: "ws_alpha",
        status: "running",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_1",
        kind: "turn",
        instructions: "Do the thing",
        artifacts: [],
        tool_policy: {
          mode: "allow_all",
          allowed_tools: [],
          blocked_tools: [],
        },
        timeout: {
          soft_ms: 10_000,
        },
        lease_profile: {
          profile_id: "default",
          ttl_seconds: 120,
          required_capabilities: ["exec"],
        },
        subagent_policy: {
          enabled: false,
          max_depth: 0,
          max_jobs: 0,
        },
        metadata: {},
      },
    });

    store.saveLease({
      workspace_id: "ws_alpha",
      job_id: "job_1",
      lease: {
        lease_id: "lease_1",
        node_id: "node_1",
        profile: {
          profile_id: "default",
          ttl_seconds: 120,
          required_capabilities: ["exec"],
        },
        ttl: 120,
        reset_required: true,
        state: "active",
      },
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: "2024-01-01T00:00:01.000Z",
    });

    const summary = database.reconcileStartupState(Date.parse("2024-01-01T00:02:00.000Z"));

    expect(summary.failed_jobs).toBe(1);
    expect(summary.expired_leases).toBe(1);
    expect(summary.released_leases).toBe(0);
    expect(summary.stale_nodes).toBe(1);
    expect(store.getJob("job_1").job.status).toBe("failed");
    expect(store.getLease("lease_1").lease.state).toBe("expired");
    expect(store.getNode("node_1").health_status).toBe("stale");
  });

  test("preserves child rows when updating parent records", () => {
    database.saveWorkspace({
      workspace_id: "ws_alpha",
      name: "Alpha",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    const store = database.workspace("ws_alpha");

    store.saveNode({
      manifest: {
        node_id: "node_1",
        pubkey: "pub",
        signature: "sig",
        adapter_kind: "sandbox",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 1024, disk_mb: 1024 },
        lease_policy: { max_ttl_seconds: 60, supports_warm_pool: true, reset_methods: ["process_kill"] },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp_1",
      status: "approved",
    });
    store.saveNodeCredential({
      credential_id: "cred_1",
      node_id: "node_1",
      token_hash: "hash",
      expires_at: "2024-01-01T01:00:00.000Z",
    });

    store.saveJob({
      job: {
        job_id: "job_1",
        workspace_id: "ws_alpha",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_1",
        kind: "turn",
        instructions: "do thing",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    store.saveLease({
      workspace_id: "ws_alpha",
      job_id: "job_1",
      lease: {
        lease_id: "lease_1",
        node_id: "node_1",
        profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      expires_at: "2024-01-01T00:01:00.000Z",
    });

    database.saveWorkspace({
      workspace_id: "ws_alpha",
      name: "Alpha Updated",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:05:00.000Z",
    });
    store.saveNode({
      manifest: {
        node_id: "node_1",
        pubkey: "pub",
        signature: "sig",
        adapter_kind: "sandbox",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 1024, disk_mb: 1024 },
        lease_policy: { max_ttl_seconds: 60, supports_warm_pool: true, reset_methods: ["process_kill"] },
        version: "1.0.1",
      },
      pubkey_fingerprint: "fp_1",
      status: "approved",
    });
    store.saveJob({
      job: {
        job_id: "job_1",
        workspace_id: "ws_alpha",
        status: "running",
        node_id: "node_1",
        created_at: "2024-01-01T00:00:00.000Z",
        started_at: "2024-01-01T00:00:10.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_1",
        kind: "turn",
        instructions: "do thing again",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    expect(store.listNodeCredentials("node_1")).toHaveLength(1);
    expect(store.getLease("lease_1").lease.node_id).toBe("node_1");
    expect(store.getJob("job_1").job.node_id).toBe("node_1");
  });

  test("keeps same ids isolated across workspaces", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    database.saveWorkspace({ workspace_id: "ws_beta", name: "Beta", created_at: "2024-01-01T00:00:00.000Z" });

    const alpha = database.workspace("ws_alpha");
    const beta = database.workspace("ws_beta");

    alpha.saveNode({
      manifest: {
        node_id: "node_same",
        pubkey: "pub-a",
        signature: "sig-a",
        adapter_kind: "sandbox",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 1, memory_mb: 512, disk_mb: 512 },
        lease_policy: { max_ttl_seconds: 60, supports_warm_pool: true, reset_methods: ["process_kill"] },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp-a",
    });
    beta.saveNode({
      manifest: {
        node_id: "node_same",
        pubkey: "pub-b",
        signature: "sig-b",
        adapter_kind: "sandbox",
        capabilities: ["exec"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 1, memory_mb: 512, disk_mb: 512 },
        lease_policy: { max_ttl_seconds: 60, supports_warm_pool: true, reset_methods: ["process_kill"] },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp-b",
    });

    alpha.savePreview({
      preview: {
        preview_id: "preview_same",
        workspace_id: "ws_alpha",
        kind: "static-site",
        delivery_mode: "external",
        source_type: "files",
        path: "/site-a",
        status: "ready",
        supports_iframe: false,
        supports_new_tab: true,
      },
    });
    beta.savePreview({
      preview: {
        preview_id: "preview_same",
        workspace_id: "ws_beta",
        kind: "static-site",
        delivery_mode: "external",
        source_type: "files",
        path: "/site-b",
        status: "ready",
        supports_iframe: false,
        supports_new_tab: true,
      },
    });

    alpha.saveJob({
      job: {
        job_id: "job_same",
        workspace_id: "ws_alpha",
        status: "pending",
        node_id: "node_same",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_same",
        kind: "turn",
        instructions: "alpha",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    beta.saveJob({
      job: {
        job_id: "job_same",
        workspace_id: "ws_beta",
        status: "pending",
        node_id: "node_same",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_beta",
        job_id: "job_same",
        kind: "turn",
        instructions: "beta",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    alpha.saveLease({
      workspace_id: "ws_alpha",
      job_id: "job_same",
      lease: {
        lease_id: "lease_same",
        node_id: "node_same",
        profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      expires_at: "2024-01-01T00:01:00.000Z",
    });
    beta.saveLease({
      workspace_id: "ws_beta",
      job_id: "job_same",
      lease: {
        lease_id: "lease_same",
        node_id: "node_same",
        profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        ttl: 60,
        reset_required: true,
        state: "active",
      },
      expires_at: "2024-01-01T00:01:00.000Z",
    });

    expect(alpha.getNode("node_same").pubkey_fingerprint).toBe("fp-a");
    expect(beta.getNode("node_same").pubkey_fingerprint).toBe("fp-b");
    expect(alpha.getPreview("preview_same").preview.path).toBe("/site-a");
    expect(beta.getPreview("preview_same").preview.path).toBe("/site-b");
    expect(alpha.getJob("job_same").task_package.instructions).toBe("alpha");
    expect(beta.getJob("job_same").task_package.instructions).toBe("beta");
    expect(alpha.getLease("lease_same").job_id).toBe("job_same");
    expect(beta.getLease("lease_same").job_id).toBe("job_same");
  });

  test("creates durable network sessions and resolves legacy session keys", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    const store = database.workspace("ws_alpha");

    store.saveJob({
      job: {
        job_id: "job_1",
        workspace_id: "ws_alpha",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_1",
        kind: "turn",
        instructions: "alpha",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    const created = store.saveNetworkSession({
      network_session_id: "sess_1",
      client_kind: "or3-chat",
      client_session_id: "thread_1",
      intern_session_key: "svc:thread_1",
      initiator_subject: "user_1",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      last_activity_at: "2024-01-01T00:00:00.000Z",
    });

    expect(created.network_session_id).toBe("sess_1");
    expect(store.getNetworkSession("sess_1").client_session_id).toBe("thread_1");
    expect(store.findNetworkSessionByClient("or3-chat", "thread_1")?.network_session_id).toBe("sess_1");
    expect(store.findNetworkSessionByInternSessionKey("svc:thread_1")?.network_session_id).toBe("sess_1");

    const touched = store.touchNetworkSession("sess_1", {
      last_job_id: "job_1",
      last_activity_at: "2024-01-01T00:01:00.000Z",
    });
    expect(touched.last_job_id).toBe("job_1");
    expect(touched.last_activity_at).toBe("2024-01-01T00:01:00.000Z");
  });

  test("stores bounded job events and keeps them workspace-scoped", () => {
    database.close();
    database = createControlPlaneDatabase({ jobEventRetentionPerJob: 3 });
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    database.saveWorkspace({ workspace_id: "ws_beta", name: "Beta", created_at: "2024-01-01T00:00:00.000Z" });

    const alpha = database.workspace("ws_alpha");
    const beta = database.workspace("ws_beta");

    alpha.saveJob({
      job: {
        job_id: "job_alpha",
        workspace_id: "ws_alpha",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_alpha",
        kind: "turn",
        instructions: "alpha",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });
    beta.saveJob({
      job: {
        job_id: "job_beta",
        workspace_id: "ws_beta",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_beta",
        job_id: "job_beta",
        kind: "turn",
        instructions: "beta",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    alpha.saveNetworkSession({
      network_session_id: "sess_alpha",
      client_kind: "cli",
      intern_session_key: "svc:alpha",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      last_activity_at: "2024-01-01T00:00:00.000Z",
    });
    beta.saveNetworkSession({
      network_session_id: "sess_beta",
      client_kind: "cli",
      intern_session_key: "svc:beta",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      last_activity_at: "2024-01-01T00:00:00.000Z",
    });

    for (const eventType of ["job.accepted", "job.started", "text.delta", "job.completed"] as const) {
      alpha.appendJobEvent({
        job_id: "job_alpha",
        network_session_id: "sess_alpha",
        event_type: eventType,
        payload: { eventType, text: "x".repeat(5000) },
        created_at: "2024-01-01T00:00:00.000Z",
      });
    }

    beta.appendJobEvent({
      job_id: "job_beta",
      network_session_id: "sess_beta",
      event_type: "job.accepted",
      payload: { ok: true },
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const alphaEvents = alpha.listJobEvents({ job_id: "job_alpha" });
    const sessionEvents = alpha.listJobEvents({ network_session_id: "sess_alpha" });
    const betaEvents = beta.listJobEvents({ network_session_id: "sess_beta" });

    expect(alphaEvents.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(alphaEvents[0]?.payload_json.length ?? 0).toBeLessThan(3000);
    expect(sessionEvents).toHaveLength(3);
    expect(betaEvents).toHaveLength(1);
    expect(betaEvents[0]?.job_id).toBe("job_beta");
  });

  test("lists the newest bounded event tail in chronological order", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    const store = database.workspace("ws_alpha");

    store.saveJob({
      job: {
        job_id: "job_tail",
        workspace_id: "ws_alpha",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      task_package: {
        workspace_id: "ws_alpha",
        job_id: "job_tail",
        kind: "turn",
        instructions: "tail",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
    });

    store.saveNetworkSession({
      network_session_id: "sess_tail",
      client_kind: "cli",
      intern_session_key: "svc:tail",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      last_activity_at: "2024-01-01T00:00:00.000Z",
    });

    for (let index = 1; index <= 150; index += 1) {
      store.appendJobEvent({
        job_id: "job_tail",
        network_session_id: "sess_tail",
        event_type: "text.delta",
        payload: { index },
        created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const events = store.listJobEvents({ network_session_id: "sess_tail", limit: 100 });
    expect(events).toHaveLength(100);
    expect(events[0]?.sequence).toBe(51);
    expect(events.at(-1)?.sequence).toBe(150);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((left, right) => left - right));
  });
});