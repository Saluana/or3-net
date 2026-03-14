import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createControlPlaneDatabase, RuntimeCapabilitySet, schemaMigrations } from "../src/index.ts";

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
    const truncatedPayload = JSON.parse(alphaEvents[0]?.payload_json ?? "{}") as {
      text?: { _truncated?: boolean; _original_length?: number; value?: string };
    };

    expect(alphaEvents.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(alphaEvents[0]?.payload_json.length ?? 0).toBeLessThan(3000);
    expect(truncatedPayload.text?._truncated).toBeTrue();
    expect(truncatedPayload.text?._original_length).toBe(5000);
    expect(truncatedPayload.text?.value?.length).toBe(2048);
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

  test("stores runtime session CRUD round-trip with workspace scoping", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    database.saveWorkspace({ workspace_id: "ws_beta", name: "Beta", created_at: "2024-01-01T00:00:00.000Z" });

    const alpha = database.workspace("ws_alpha");
    const beta = database.workspace("ws_beta");

    alpha.saveRuntimeSession({
      session_id: "rt_same",
      adapter_id: "sandbox",
      adapter_session_ref: "sbx_alpha",
      node_id: "node_a",
      preset_id: "python",
      status: "creating",
      capabilities: ["exec", "copy-in"],
      config: {
        preset_id: "python",
        required_capabilities: RuntimeCapabilitySet.fromValues(["exec"]),
        workspace_mode: "read_only",
      },
      isolation_class: "container",
      trust_tier: "development",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });
    beta.saveRuntimeSession({
      session_id: "rt_same",
      adapter_id: "remote",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "vm",
      trust_tier: "production",
      created_at: "2024-01-01T00:01:00.000Z",
      updated_at: "2024-01-01T00:01:00.000Z",
    });

    const touched = alpha.touchRuntimeSession("rt_same", {
      status: "ready",
      error: null,
      updated_at: "2024-01-01T00:02:00.000Z",
    });

    expect(touched.session.status).toBe("ready");
    expect(touched.adapter_session_ref).toBe("sbx_alpha");
    expect(alpha.getRuntimeSession("rt_same").session.preset_id).toBe("python");
    expect(beta.getRuntimeSession("rt_same").session.adapter_id).toBe("remote");
    expect(alpha.listRuntimeSessions({ status: "ready" })).toHaveLength(1);
    expect(alpha.listRuntimeSessions({ adapter_id: "sandbox" })).toHaveLength(1);
  });

  test("stores runtime session events with monotonic sequence", () => {
    database.close();
    database = createControlPlaneDatabase({ runtimeSessionEventRetentionPerSession: 3 });
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    const store = database.workspace("ws_alpha");

    store.saveRuntimeSession({
      session_id: "rt_events",
      adapter_id: "sandbox",
      status: "ready",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    store.appendRuntimeSessionEvent({
      session_id: "rt_events",
      event_type: "session.ready",
      payload: { order: 1 },
      created_at: "2024-01-01T00:00:01.000Z",
    });
    store.appendRuntimeSessionEvent({
      session_id: "rt_events",
      event_type: "exec.started",
      payload: { order: 2 },
      created_at: "2024-01-01T00:00:02.000Z",
    });
    store.appendRuntimeSessionEvent({
      session_id: "rt_events",
      event_type: "exec.stdout",
      payload: { order: 3 },
      created_at: "2024-01-01T00:00:03.000Z",
    });
    store.appendRuntimeSessionEvent({
      session_id: "rt_events",
      event_type: "exec.exit",
      payload: { order: 4 },
      created_at: "2024-01-01T00:00:04.000Z",
    });

    const events = store.listRuntimeSessionEvents("rt_events");
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(events[0]?.event_type).toBe("exec.started");
    expect(events[1]?.event_type).toBe("exec.stdout");
    expect(events[2]?.event_type).toBe("exec.exit");
  });

  test("stores runtime artifacts per session", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    const store = database.workspace("ws_alpha");

    store.saveRuntimeSession({
      session_id: "rt_artifacts",
      adapter_id: "sandbox",
      status: "ready",
      capabilities: ["exec", "artifact-push"],
      isolation_class: "container",
      trust_tier: "development",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    store.saveRuntimeArtifact({
      artifact: {
        artifact_id: "art_1",
        session_id: "rt_artifacts",
        path: "/workspace/out.txt",
        kind: "file",
        content_type: "text/plain",
        size_bytes: 4,
        source: { transport: "exec" },
      },
      created_at: "2024-01-01T00:00:01.000Z",
    });
    store.saveRuntimeArtifact({
      artifact: {
        artifact_id: "art_2",
        session_id: "rt_artifacts",
        path: "/workspace/out-2.txt",
        kind: "file",
        content_type: "text/plain",
        size_bytes: 8,
        source: {},
      },
      created_at: "2024-01-01T00:00:02.000Z",
    });

    const artifacts = store.listRuntimeArtifacts("rt_artifacts");
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.artifact.artifact_id).toBe("art_1");
    expect(artifacts[0]?.artifact.source).toEqual({ transport: "exec" });
    expect(artifacts[1]?.artifact.source).toEqual({});
  });

  test("preserves runtime session created_at across upserts", () => {
    database.saveWorkspace({ workspace_id: "ws_alpha", name: "Alpha", created_at: "2024-01-01T00:00:00.000Z" });
    const store = database.workspace("ws_alpha");

    store.saveRuntimeSession({
      session_id: "rt_upsert",
      adapter_id: "sandbox",
      status: "creating",
      capabilities: ["exec"],
      isolation_class: "container",
      trust_tier: "development",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    store.saveRuntimeSession({
      session_id: "rt_upsert",
      adapter_id: "sandbox",
      status: "ready",
      capabilities: ["exec", "copy-in"],
      isolation_class: "container",
      trust_tier: "development",
      created_at: "2024-02-01T00:00:00.000Z",
      updated_at: "2024-02-01T00:00:00.000Z",
    });

    const stored = store.getRuntimeSession("rt_upsert");
    expect(stored.session.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(stored.session.updated_at).toBe("2024-02-01T00:00:00.000Z");
    expect(stored.session.status).toBe("ready");
  });

  test("applies runtime migration on fresh and version-5 databases", () => {
    const freshTables = database.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runtime_sessions', 'runtime_session_events', 'runtime_artifacts') ORDER BY name ASC",
      )
      .all()
      .map((row) => row.name);

    expect(freshTables).toEqual(["runtime_artifacts", "runtime_session_events", "runtime_sessions"]);

    const tempDir = process.env["TMPDIR"] ?? "/tmp";
    const migrationPath = `${tempDir}/or3-net-runtime-migration-${crypto.randomUUID()}.sqlite`;
    const seeded = new Database(migrationPath);
    seeded.run("PRAGMA foreign_keys = ON;");
    seeded.run(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of schemaMigrations.filter((entry) => entry.version <= 5)) {
      for (const statement of migration.statements) {
        seeded.run(statement);
      }
      seeded
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, Date.now());
    }
    seeded.close();

    let migrated: ReturnType<typeof createControlPlaneDatabase> | undefined;

    try {
      migrated = createControlPlaneDatabase({ path: migrationPath });
      const appliedVersions = migrated.sqlite
        .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all()
        .map((row) => row.version);

      expect(appliedVersions.at(-1)).toBe(6);
      expect(
        migrated.sqlite
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runtime_sessions', 'runtime_session_events', 'runtime_artifacts') ORDER BY name ASC",
          )
          .all()
          .map((row) => row.name),
      ).toEqual(["runtime_artifacts", "runtime_session_events", "runtime_sessions"]);
    } finally {
      migrated?.close();
      void Bun.file(migrationPath).delete();
    }
  });

  test("runtime tables stay independent from node, job, and network session foreign keys", () => {
    const foreignKeys = ["runtime_sessions", "runtime_session_events", "runtime_artifacts"].map((table) => ({
      table,
      references: database.sqlite
        .query<{ table: string }, []>(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => row.table),
    }));

    for (const entry of foreignKeys) {
      expect(entry.references.includes("nodes")).toBeFalse();
      expect(entry.references.includes("jobs")).toBeFalse();
      expect(entry.references.includes("network_sessions")).toBeFalse();
    }
  });
});