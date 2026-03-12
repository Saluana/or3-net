import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { AuthService, createControlPlaneDatabase, handleAppRequest, InMemoryWorkspaceFileService, LocalJobService, NodeRegistryService, Or3NetApp, PreviewService, SandboxNodeAdapter, signNodeManifest } from "../src/index.ts";
import type { SessionProofValidator } from "../src/auth/service.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";
import type { CreateSandboxRequest, CreateTunnelRequest, SandboxClient, SandboxExecEvent, SandboxExecRequest, SandboxExecResult, SandboxInfo, SandboxTunnel, SandboxWriteFileRequest } from "../sdk/sandbox/index.ts";

type UnsignedManifest = Parameters<typeof signNodeManifest>[0];

class PreviewPhaseValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "preview_admin",
      workspace_id: "ws_preview",
      scopes: [
        "jobs:read",
        "jobs:write",
        "nodes:read",
        "nodes:write",
        "files:read",
        "previews:read",
        "previews:write",
        "services:read",
        "services:write",
      ],
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

class FakeSandboxClient implements SandboxClient {
  private readonly sandboxes = new Map<string, SandboxInfo>();
  private readonly tunnels = new Map<string, SandboxTunnel[]>();
  public createCalls: string[] = [];
  public createRequests: CreateSandboxRequest[] = [];
  public deleteCalls: string[] = [];
  public getCalls: string[] = [];
  public tunnelCreateCalls: string[] = [];
  public failExecFor = new Set<string>();
  public failNextExecCount = 0;
  private nextSandboxId = 1;

  public create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    const workspaceId = request.workspace_id ?? "ws";
    const sandbox = { id: `sbx_${workspaceId}_${String(this.nextSandboxId++)}`, status: "running", workspace_id: workspaceId };
    this.createCalls.push(sandbox.id);
    this.createRequests.push(request);
    this.sandboxes.set(sandbox.id, sandbox);
    return Promise.resolve(sandbox);
  }
  public get(sandboxId: string): Promise<SandboxInfo> {
    this.getCalls.push(sandboxId);
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    return Promise.resolve(sandbox);
  }
  public delete(sandboxId: string): Promise<void> {
    this.deleteCalls.push(sandboxId);
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
    if (this.failNextExecCount > 0) {
      this.failNextExecCount -= 1;
      return Promise.reject(new Error("sandbox exec failed"));
    }
    if (this.failExecFor.has(sandboxId)) {
      return Promise.reject(new Error("sandbox exec failed"));
    }
    void request;
    return Promise.resolve({ exit_code: 0, stdout: "ok" });
  }
  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    void sandboxId;
    void request;
    await Promise.resolve();
    yield { event: "stdout", data: { chunk: "ok" } };
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
    const tunnel = {
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      endpoint: `https://launch.local/${sandboxId}/${String(request.target_port)}`,
      auth_mode: "token",
      visibility: "private",
    };
    this.tunnelCreateCalls.push(tunnel.id);
    const current = this.tunnels.get(sandboxId) ?? [];
    current.push(tunnel);
    this.tunnels.set(sandboxId, current);
    return Promise.resolve(tunnel);
  }
  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    return Promise.resolve(this.tunnels.get(sandboxId) ?? []);
  }
  public createSignedTunnelUrl(tunnelId: string): Promise<{ url: string; expires_at: string }> {
    return Promise.resolve({
      url: `https://launch.local/signed/${tunnelId}`,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  }
  public revokeTunnel(tunnelId: string): Promise<void> {
    for (const [sandboxId, tunnels] of this.tunnels.entries()) {
      const next = tunnels.filter((tunnel) => tunnel.id !== tunnelId);
      this.tunnels.set(sandboxId, next);
    }
    return Promise.resolve();
  }
  public runtimeInfo(): Promise<Record<string, unknown>> {
    return Promise.resolve({ runtime: "docker" });
  }
  public runtimeHealth(): Promise<{ status: string }> {
    return Promise.resolve({ status: "ok" });
  }
  public runtimeCapacity(): Promise<Record<string, unknown>> {
    return Promise.resolve({ total: 1, available: 1 });
  }
  public getQuota(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
  public getMetrics(): Promise<string> {
    return Promise.resolve("");
  }
}

describe("phase 4.5-6 previews, files, and service launches", () => {
  let database = createControlPlaneDatabase();
  let authService: AuthService;
  let fileService: InMemoryWorkspaceFileService;
  let previewService: PreviewService;
  let nodeRegistry: NodeRegistryService;
  let app: Or3NetApp;
  let sandboxClient: FakeSandboxClient;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_preview", name: "Preview Workspace", created_at: "2024-01-01T00:00:00.000Z" });
    database.saveWorkspace({ workspace_id: "ws_other", name: "Other Workspace", created_at: "2024-01-01T00:00:00.000Z" });
    authService = new AuthService({
      secret: "phase45-secret",
      database,
      sessionProofValidator: new PreviewPhaseValidator(),
    });
    fileService = new InMemoryWorkspaceFileService();
    previewService = new PreviewService(database);
    nodeRegistry = new NodeRegistryService({ database });
    sandboxClient = new FakeSandboxClient();
    fileService.putFile(
      "ws_preview",
      {
        workspace_id: "ws_preview",
        path: "/site/index.html",
        kind: "file",
        size_bytes: 17,
        mime_type: "text/html",
        modified_at: "2024-01-01T00:00:00.000Z",
      },
      "<h1>Hello</h1>",
    );
    fileService.putFile(
      "ws_preview",
      {
        workspace_id: "ws_preview",
        path: "/site/app.js",
        kind: "file",
        size_bytes: 20,
        mime_type: "application/javascript",
        modified_at: "2024-01-01T00:00:00.000Z",
      },
      "console.log('hello');",
    );
    app = new Or3NetApp({
      authService,
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
      nodeRegistryService: nodeRegistry,
      previewService,
      workspaceFileService: fileService,
      sandboxNodeAdapter: new SandboxNodeAdapter(sandboxClient),
    });
  });

  afterEach(() => {
    database.close();
  });

  test("lists files and manages preview launch/revoke lifecycle", async () => {
    const token = await exchangeToken(app, "ws_preview");

    const filesResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/files", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const filesPayload = (await filesResponse.json()) as { items: { path: string }[] };
    expect(filesPayload.items[0]?.path).toBe("/site/index.html");

    const registerResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          preview_id: "preview_site",
          workspace_id: "ws_preview",
          kind: "static-site",
          delivery_mode: "embedded-preferred",
          source_type: "files",
          path: "/site",
          entry_path: "/site/index.html",
          status: "ready",
          supports_iframe: true,
          supports_new_tab: true,
        }),
      }),
    );
    expect(registerResponse.status).toBe(201);

    const launchResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews/preview_site/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const launchPayload = (await launchResponse.json()) as { launch_url: string; supports_iframe: boolean };
    expect(launchPayload.launch_url).toContain("http://or3.test/v1/launch/");
    expect(launchPayload.supports_iframe).toBeTrue();

    const resolvedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(resolvedLaunchResponse.status).toBe(200);
    expect(await resolvedLaunchResponse.text()).toContain("Hello");

    const assetResponse = await handleAppRequest(
      app,
      new Request(new URL("app.js", launchPayload.launch_url).toString()),
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toContain("console.log");

    const revokeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews/preview_site/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const revokePayload = (await revokeResponse.json()) as { preview: { preview: { status: string } } };
    expect(revokePayload.preview.preview.status).toBe("revoked");

    const revokedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(revokedLaunchResponse.status).toBe(410);
  });

  test("returns embedded pane launch metadata for iframe-safe previews and falls back to new-tab mode", async () => {
    const token = await exchangeToken(app, "ws_preview");
    previewService.registerPreview("ws_preview", {
      preview_id: "preview_pane",
      workspace_id: "ws_preview",
      kind: "static-site",
      delivery_mode: "embedded-preferred",
      source_type: "files",
      path: "/site",
      entry_path: "/site/index.html",
      status: "ready",
      supports_iframe: true,
      supports_new_tab: true,
    });

    const paneResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews/preview_pane/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ launch_mode_hint: "pane" }),
      }),
    );
    const panePayload = (await paneResponse.json()) as { delivery_mode: string; embed_url?: string };
    expect(panePayload.delivery_mode).toBe("embedded");
    expect(panePayload.embed_url).toContain("http://or3.test/v1/launch/");

    const tabResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews/preview_pane/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ launch_mode_hint: "new_tab" }),
      }),
    );
    const tabPayload = (await tabResponse.json()) as { delivery_mode: string; embed_url?: string };
    expect(tabPayload.delivery_mode).toBe("external");
    expect(tabPayload.embed_url).toBeUndefined();
  });

  test("denies launching expired previews", async () => {
    const token = await exchangeToken(app, "ws_preview");
    previewService.registerPreview("ws_preview", {
      preview_id: "preview_expired",
      workspace_id: "ws_preview",
      kind: "static-site",
      delivery_mode: "external",
      source_type: "files",
      path: "/site",
      entry_path: "/site/index.html",
      status: "ready",
      expires_at: "2020-01-01T00:00:00.000Z",
      supports_iframe: false,
      supports_new_tab: true,
    });

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews/preview_expired/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(410);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("expired");
  });

  test("rejects preview registration when body workspace does not match the token workspace", async () => {
    const token = await exchangeToken(app, "ws_preview");

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          preview_id: "preview_bad",
          workspace_id: "ws_other",
          kind: "static-site",
          delivery_mode: "external",
          source_type: "files",
          path: "/site",
          status: "ready",
          launch_url: "https://preview.local/bad",
          supports_iframe: false,
          supports_new_tab: true,
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("rejects caller-supplied preview URLs", async () => {
    const token = await exchangeToken(app, "ws_preview");

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/previews", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          preview_id: "preview_bad_urls",
          workspace_id: "ws_preview",
          kind: "static-site",
          delivery_mode: "external",
          source_type: "files",
          path: "/site",
          status: "ready",
          launch_url: "https://evil.example/phish",
          supports_iframe: false,
          supports_new_tab: true,
        }),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("lists and launches sandbox-backed node services with workspace isolation", async () => {
    const token = await exchangeToken(app, "ws_preview");
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_service",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec", "network", "service:openclaw:3000:OpenClaw Dashboard"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    await nodeRegistry.enrollNode("ws_preview", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_preview", "node_service");

    const servicesResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_service/services", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const servicesPayload = (await servicesResponse.json()) as { items: { service_id: string }[] };
    expect(servicesPayload.items[0]?.service_id).toBe("openclaw");

    const launchResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_service/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const launchPayload = (await launchResponse.json()) as { launch_url: string };
    expect(launchPayload.launch_url).toContain("http://or3.test/v1/launch/");

    const resolvedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(resolvedLaunchResponse.status).toBe(302);
    expect(resolvedLaunchResponse.headers.get("Location")).toContain("https://launch.local/signed/");

    const revokeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_service/services/openclaw/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(revokeResponse.status).toBe(200);

    const revokedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(revokedLaunchResponse.status).toBe(410);

    const otherToken = await authService.createApiKey({
      workspace_id: "ws_other",
      name: "other-key",
      scopes: ["files:read", "previews:read", "services:read"],
    });
    const forbiddenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/files", {
        headers: { Authorization: `Bearer ${otherToken.api_key}` },
      }),
    );
    expect(forbiddenResponse.status).toBe(403);
  });

  test("recycles sandbox-backed task execution safely when execution fails", async () => {
    const adapter = new SandboxNodeAdapter(sandboxClient);
    sandboxClient.failNextExecCount = 1;

    let failure: Error | null = null;
    try {
      await adapter.executeTask("ws_preview", {
        workspace_id: "ws_preview",
        job_id: "job_fail",
        kind: "turn",
        instructions: "echo fail",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("sandbox exec failed");
    }

    expect(failure?.message).toBe("sandbox exec failed");

    expect(sandboxClient.deleteCalls.length).toBeGreaterThan(0);
    expect(sandboxClient.createCalls.length).toBeGreaterThan(1);
  });

  test("only requests tunnel-capable sandboxes for service launches", async () => {
    const adapter = new SandboxNodeAdapter(sandboxClient);
    const node = {
      workspace_id: "ws_preview",
      manifest: {
        node_id: "node_services",
        pubkey: "pubkey",
        adapter_kind: "sandbox",
        capabilities: ["exec", "service:openclaw:3000:OpenClaw Dashboard"],
        isolation_class: "docker-trusted",
        supports_transports: ["https"],
        resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
        lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
        version: "1.0.0",
      },
      pubkey_fingerprint: "fp",
      status: "approved",
      health_status: "ready",
      approved_at: null,
      revoked_at: null,
      last_seen_at: null,
      last_error: null,
      created_at: new Date(0).toISOString(),
    };

    await adapter.executeTask("ws_preview", {
      workspace_id: "ws_preview",
      job_id: "job_tunnel_scope",
      kind: "turn",
      instructions: "echo ok",
      artifacts: [],
      tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1000 },
      lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: {},
    });
    await adapter.prepareServiceLaunch("ws_preview", node, "openclaw");

    expect(sandboxClient.createRequests[0]).toEqual({ workspace_id: "ws_preview", start: true });
    expect(sandboxClient.createRequests.some((request) => request.allow_tunnels === true)).toBe(true);
  });

  test("reuses existing service tunnels on subsequent launches", async () => {
    const token = await exchangeToken(app, "ws_preview");
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_reuse",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec", "network", "service:openclaw:3000:OpenClaw Dashboard"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    await nodeRegistry.enrollNode("ws_preview", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_preview", "node_reuse");

    const firstResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_reuse/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const firstLaunch = (await firstResponse.json()) as { reused_tunnel: boolean };

    const secondResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_reuse/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const secondLaunch = (await secondResponse.json()) as { reused_tunnel: boolean };

    expect(firstLaunch.reused_tunnel).toBeFalse();
    expect(secondLaunch.reused_tunnel).toBeTrue();
    expect(sandboxClient.tunnelCreateCalls).toHaveLength(1);
  });

  test("scopes sandbox-backed service caches by workspace instead of bare node_id", async () => {
    const previewToken = await exchangeToken(app, "ws_preview");
    const { api_key: otherToken } = await authService.createApiKey({
      workspace_id: "ws_other",
      name: "other-service-key",
      scopes: ["services:read", "services:write"],
    });
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_shared",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec", "network", "service:openclaw:3000:OpenClaw Dashboard"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    await nodeRegistry.enrollNode("ws_preview", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_preview", "node_shared");
    await nodeRegistry.enrollNode("ws_other", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_other", "node_shared");

    const firstResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_shared/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${previewToken}` },
      }),
    );
    const secondResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_other/nodes/node_shared/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${otherToken}` },
      }),
    );

    expect(((await firstResponse.json()) as { reused_tunnel: boolean }).reused_tunnel).toBeFalse();
    expect(((await secondResponse.json()) as { reused_tunnel: boolean }).reused_tunnel).toBeFalse();
    expect(sandboxClient.tunnelCreateCalls).toHaveLength(2);
  });

  test("restarts sandbox-backed services and forces a fresh tunnel on next launch", async () => {
    const token = await exchangeToken(app, "ws_preview");
    const keyPair = nacl.sign.keyPair();
    const unsignedManifest: UnsignedManifest = {
      node_id: "node_restart",
      pubkey: Buffer.from(keyPair.publicKey).toString("base64"),
      adapter_kind: "sandbox",
      capabilities: ["exec", "network", "service:openclaw:3000:OpenClaw Dashboard"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
      lease_policy: { max_ttl_seconds: 300, supports_warm_pool: true, reset_methods: ["process_kill"] },
      version: "1.0.0",
    };
    await nodeRegistry.enrollNode("ws_preview", { ...unsignedManifest, signature: signNodeManifest(unsignedManifest, keyPair.secretKey) });
    await nodeRegistry.approveNode("ws_preview", "node_restart");

    await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_restart/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    const restartResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_restart/services/openclaw/restart", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(restartResponse.status).toBe(200);
    expect(sandboxClient.deleteCalls.length).toBeGreaterThan(0);

    const relaunched = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_restart/services/openclaw/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const relaunchedPayload = (await relaunched.json()) as { reused_tunnel: boolean };
    expect(relaunchedPayload.reused_tunnel).toBeFalse();
    expect(sandboxClient.tunnelCreateCalls).toHaveLength(2);
  });

  test("rejects file-backed previews with no target path", () => {
    previewService.registerPreview("ws_preview", {
      preview_id: "preview_missing_target",
      workspace_id: "ws_preview",
      kind: "static-site",
      delivery_mode: "embedded-preferred",
      source_type: "files",
      status: "ready",
      supports_iframe: true,
      supports_new_tab: true,
    });

    expect(() => previewService.launchPreview("ws_preview", "preview_missing_target")).toThrow(
      "file-backed preview is missing a target path",
    );
  });

  test("expires direct launch capabilities even when they are not tied to a stored preview", () => {
    const launch = previewService.mintLaunchCapability({
      workspace_id: "ws_preview",
      target_url: "https://launch.local/direct",
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: false,
      service_status: "ready",
      expires_at: "2020-01-01T00:00:00.000Z",
    });

    const token = launch.launch_url.split("/").pop();
    expect(token).toBeDefined();
    expect(() => previewService.resolveLaunchCapability(token ?? "")).toThrow("launch capability has expired");
  });
});

const exchangeToken = async (app: Or3NetApp, workspaceId: string): Promise<string> => {
  const response = await handleAppRequest(
    app,
    new Request("http://or3.test/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "test", session_proof: { ok: true }, workspace_id: workspaceId }),
    }),
  );
  const payload = (await response.json()) as { token: string };
  return payload.token;
};
