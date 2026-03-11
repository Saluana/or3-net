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
  public deleteCalls: string[] = [];
  public getCalls: string[] = [];
  public failExecFor = new Set<string>();

  public create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    const sandbox = { id: `sbx_${request.workspace_id}`, status: "ready", workspace_id: request.workspace_id };
    this.createCalls.push(sandbox.id);
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
  public exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
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
  public createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    const tunnel = {
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      url: `https://launch.local/${sandboxId}/${String(request.target_port)}`,
      state: "ready",
    };
    const current = this.tunnels.get(sandboxId) ?? [];
    current.push(tunnel);
    this.tunnels.set(sandboxId, current);
    return Promise.resolve(tunnel);
  }
  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    return Promise.resolve(this.tunnels.get(sandboxId) ?? []);
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
    expect(launchPayload.launch_url).toContain("https://or3.local/v1/launch/");
    expect(launchPayload.supports_iframe).toBeTrue();

    const resolvedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url.replace("https://or3.local", "http://or3.test")),
    );
    expect(resolvedLaunchResponse.status).toBe(302);

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
      new Request(launchPayload.launch_url.replace("https://or3.local", "http://or3.test")),
    );
    expect(revokedLaunchResponse.status).toBe(410);
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
    expect(launchPayload.launch_url).toContain("https://or3.local/v1/launch/");

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
    const firstSandbox = await sandboxClient.create({ workspace_id: "ws_preview" });
    sandboxClient.failExecFor.add(firstSandbox.id);

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