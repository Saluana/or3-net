import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

import { AuthService, createControlPlaneDatabase, handleAppRequest, InMemoryWorkspaceFileService, LocalJobService, NodeRegistryService, OpenSandboxNodeAdapter, Or3NetApp, PreviewService, signNodeManifest } from "../src/index.ts";
import type { SessionProofValidator } from "../src/auth/service.ts";
import type { StoredNode } from "../src/db/index.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";
import type {
  OpenSandboxClient,
  OpenSandboxClientConfig,
  OpenSandboxCommandOptions,
  OpenSandboxConnection,
  OpenSandboxCreateRequest,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstanceInfo,
} from "../sdk/opensandbox/types.ts";

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

class FakeSandboxClient implements OpenSandboxClient {
  public readonly config: OpenSandboxClientConfig = {
    domain: "sandbox.test",
    apiKey: "sandbox-token",
    defaultImage: "ubuntu",
    defaultTimeoutSeconds: 600,
  };
  private readonly sandboxes = new Map<string, OpenSandboxInstanceInfo>();
  public createCalls: string[] = [];
  public createRequests: OpenSandboxCreateRequest[] = [];
  public deleteCalls: string[] = [];
  public getCalls: string[] = [];
  public endpointCalls: string[] = [];
  public execCalls: { instanceId: string; command: string }[] = [];
  public failExecFor = new Set<string>();
  public failNextExecStreamCount = 0;
  public omitNextResultEvent = false;
  private nextSandboxId = 1;

  public create(request: OpenSandboxCreateRequest): Promise<OpenSandboxConnection> {
    const workspaceId = request.workspace_id;
    const sandbox = { id: `sbx_${workspaceId}_${String(this.nextSandboxId++)}`, status: "running", metadata: { workspace_id: workspaceId } };
    this.createCalls.push(sandbox.id);
    this.createRequests.push(request);
    this.sandboxes.set(sandbox.id, sandbox);
    return Promise.resolve(new FakeSandboxConnection(this, sandbox.id));
  }
  public get(sandboxId: string): Promise<OpenSandboxInstanceInfo> {
    this.getCalls.push(sandboxId);
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    return Promise.resolve(sandbox);
  }
  public kill(sandboxId: string): Promise<void> {
    this.deleteCalls.push(sandboxId);
    this.sandboxes.delete(sandboxId);
    return Promise.resolve();
  }
  public list(): Promise<OpenSandboxInstanceInfo[]> {
    return Promise.resolve([...this.sandboxes.values()]);
  }
  public connect(sandboxId: string): Promise<OpenSandboxConnection> {
    if (!this.sandboxes.has(sandboxId)) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    return Promise.resolve(new FakeSandboxConnection(this, sandboxId));
  }
  public pause(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox !== undefined) {
      this.sandboxes.set(sandboxId, { ...sandbox, status: "paused" });
    }
    return Promise.resolve();
  }
  public resume(sandboxId: string): Promise<OpenSandboxConnection> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox !== undefined) {
      this.sandboxes.set(sandboxId, { ...sandbox, status: "running" });
    }
    return this.connect(sandboxId);
  }
  public renew(sandboxId: string, timeoutSeconds: number): Promise<void> {
    void sandboxId;
    void timeoutSeconds;
    return Promise.resolve();
  }
}

class FakeSandboxConnection implements OpenSandboxConnection {
  public constructor(private readonly client: FakeSandboxClient, public readonly instance_id: string) {}

  public async runCommand(
    command: string,
    options: OpenSandboxCommandOptions = {},
    handlers: OpenSandboxExecutionHandlers = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    void options;
    this.client.execCalls.push({ instanceId: this.instance_id, command });
    if (this.client.failNextExecStreamCount > 0) {
      this.client.failNextExecStreamCount -= 1;
      throw new Error("sandbox exec failed");
    }
    if (this.client.failExecFor.has(this.instance_id)) {
      throw new Error("sandbox exec failed");
    }
    await handlers.onStdout?.({ text: "ok" });
    if (!this.client.omitNextResultEvent) {
      await handlers.onResult?.({ status: "completed" });
    } else {
      this.client.omitNextResultEvent = false;
    }
    return { exit_code: 0, stdout: "ok", stderr: "", meta: {} };
  }

  public writeFiles(): Promise<void> {
    return Promise.resolve();
  }

  public readFile(): Promise<string> {
    return Promise.resolve("");
  }

  public createDirectories(): Promise<void> {
    return Promise.resolve();
  }

  public getEndpoint(): Promise<{ endpoint: string; url?: string }> {
    this.client.endpointCalls.push(this.instance_id);
    return Promise.resolve({
      endpoint: `launch.local/${this.instance_id}/3000`,
      url: `https://launch.local/${this.instance_id}/3000`,
    });
  }

  public pause(): Promise<void> {
    return this.client.pause(this.instance_id);
  }

  public resume(): Promise<OpenSandboxConnection> {
    return this.client.resume(this.instance_id);
  }

  public renew(timeoutSeconds: number): Promise<void> {
    return this.client.renew(this.instance_id, timeoutSeconds);
  }

  public kill(): Promise<void> {
    return this.client.kill(this.instance_id);
  }

  public close(): Promise<void> {
    return Promise.resolve();
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
      nodeExecutionAdapter: new OpenSandboxNodeAdapter(sandboxClient),
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
    expect(launchPayload.launch_url).toContain("cap_");
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
    expect(revokedLaunchResponse.status).toBe(403);
  });

  test("uses configured public base URL for launch metadata and rejects file route writes", async () => {
    app = new Or3NetApp({
      authService,
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
      nodeRegistryService: nodeRegistry,
      previewService,
      workspaceFileService: fileService,
      nodeExecutionAdapter: new OpenSandboxNodeAdapter(sandboxClient),
      publicBaseUrl: "https://control-plane.example/base/path",
    });

    const token = await exchangeToken(app, "ws_preview");
    previewService.registerPreview("ws_preview", {
      preview_id: "preview_base_url",
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

    const launchResponse = await handleAppRequest(
      app,
      new Request("http://evil.example/v1/workspaces/ws_preview/previews/preview_base_url/launch", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const launchPayload = (await launchResponse.json()) as { launch_url: string };
    expect(launchPayload.launch_url.startsWith("https://control-plane.example/v1/launch/")).toBeTrue();

    const fileWriteResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/files/site/index.html", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(fileWriteResponse.status).toBe(405);
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
    expect(launchPayload.launch_url).toContain("cap_");

    const resolvedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(resolvedLaunchResponse.status).toBe(302);
    expect(resolvedLaunchResponse.headers.get("Location")).toContain("https://launch.local/");

    const revokeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_service/services/openclaw/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(revokeResponse.status).toBe(200);
    expect(((await revokeResponse.json()) as { revoked: number }).revoked).toBeGreaterThan(0);

    const secondRevokeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_preview/nodes/node_service/services/openclaw/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(secondRevokeResponse.status).toBe(200);
    expect(((await secondRevokeResponse.json()) as { revoked: number }).revoked).toBe(0);

    const revokedLaunchResponse = await handleAppRequest(
      app,
      new Request(launchPayload.launch_url),
    );
    expect(revokedLaunchResponse.status).toBe(403);

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
    const adapter = new OpenSandboxNodeAdapter(sandboxClient);
    sandboxClient.failNextExecStreamCount = 1;

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
    expect(sandboxClient.createCalls.length).toBe(1);
  });

  test("does not rerun provider execution when result callbacks are omitted", async () => {
    const adapter = new OpenSandboxNodeAdapter(sandboxClient);
    sandboxClient.omitNextResultEvent = true;
    const execution = await adapter.executeTask("ws_preview", {
      workspace_id: "ws_preview",
      job_id: "job_missing_result",
      kind: "turn",
      instructions: "echo missing-result",
      artifacts: [],
      tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1000 },
      lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: {},
    });

    expect(execution.exit_code).toBe(0);
    expect(sandboxClient.execCalls).toHaveLength(1);
  });

  test("enforces in-memory workspace file size and count limits", () => {
    expect(() => {
      fileService.putFile(
        "ws_preview",
        {
          workspace_id: "ws_preview",
          path: "/too-large.txt",
          kind: "file",
          size_bytes: 10 * 1024 * 1024 + 1,
          modified_at: "2024-01-01T00:00:00.000Z",
        },
        "x".repeat(10 * 1024 * 1024 + 1),
      );
    }).toThrow("file exceeds maximum size");

    const limitedService = new InMemoryWorkspaceFileService();
    for (let index = 0; index < 500; index += 1) {
      limitedService.putFile(
        "ws_preview",
        {
          workspace_id: "ws_preview",
          path: `/file-${String(index)}.txt`,
          kind: "file",
          size_bytes: 1,
          modified_at: "2024-01-01T00:00:00.000Z",
        },
        "x",
      );
    }

    expect(() => {
      limitedService.putFile(
        "ws_preview",
        {
          workspace_id: "ws_preview",
          path: "/overflow.txt",
          kind: "file",
          size_bytes: 1,
          modified_at: "2024-01-01T00:00:00.000Z",
        },
        "x",
      );
    }).toThrow("workspace file limit");
  });

  test("uses distinct OpenSandbox roles for job and service instances", async () => {
    const adapter = new OpenSandboxNodeAdapter(sandboxClient);
    const node: StoredNode = {
      workspace_id: "ws_preview",
      manifest: {
        node_id: "node_services",
        pubkey: "pubkey",
        signature: "sig",
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

    expect(sandboxClient.createRequests[0]?.workspace_id).toBe("ws_preview");
    expect(sandboxClient.createRequests[0]?.metadata?.["or3_role"]).toBe("job");
    expect(sandboxClient.createRequests.some((request) => request.metadata?.["or3_role"] === "service")).toBeTrue();
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
    expect(sandboxClient.createCalls).toHaveLength(1);
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
    expect(sandboxClient.createCalls).toHaveLength(2);
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
    expect(relaunchedPayload.reused_tunnel).toBeTrue();
    expect(sandboxClient.createCalls).toHaveLength(2);
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
    expect(token).toStartWith("cap_");
    expect(() => previewService.resolveLaunchCapability(token ?? "")).toThrow("launch capability has expired");
    expect((previewService as unknown as { launchCapabilities: Map<string, unknown> }).launchCapabilities.size).toBe(0);
  });

  test("removes reverse-index entries when preview and scoped launch capabilities are revoked", () => {
    previewService.registerPreview("ws_preview", {
      preview_id: "preview_cleanup",
      workspace_id: "ws_preview",
      kind: "dashboard",
      delivery_mode: "external",
      source_type: "live-service",
      status: "ready",
      supports_iframe: false,
      supports_new_tab: true,
    });

    const previewLaunch = previewService.mintLaunchCapability({
      workspace_id: "ws_preview",
      preview_id: "preview_cleanup",
      target_url: "https://launch.local/preview-cleanup",
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: false,
      service_status: "ready",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    previewService.mintLaunchCapability({
      workspace_id: "ws_preview",
      scope_key: "service:node_cleanup:openclaw",
      target_url: "https://launch.local/service-cleanup",
      delivery_mode: "external",
      supports_iframe: false,
      supports_new_tab: true,
      reused_tunnel: false,
      service_status: "ready",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    previewService.revokePreview("ws_preview", "preview_cleanup");
    previewService.revokeLaunchScope("service:node_cleanup:openclaw");

    const launchState = previewService as unknown as {
      previewLaunchTokens: Map<string, Set<string>>;
      scopedLaunchTokens: Map<string, Set<string>>;
      launchCapabilities: Map<string, { grant: { revoked_at: string | null } }>;
      revokedLaunchCapabilities: Map<string, { revoked_at: string; expires_at: string }>;
    };
    const revokedPreviewToken = previewLaunch.launch_url.split("/").pop();

    expect(launchState.previewLaunchTokens.has("preview_cleanup")).toBeFalse();
    expect(launchState.scopedLaunchTokens.has("service:node_cleanup:openclaw")).toBeFalse();
    expect(revokedPreviewToken).toBeDefined();
    expect(launchState.launchCapabilities.has(revokedPreviewToken ?? "")).toBeFalse();
    expect(launchState.revokedLaunchCapabilities.get(revokedPreviewToken ?? "")?.revoked_at).toBeString();
  });

  test("keeps capability state bounded across repeated service launch and revoke cycles", () => {
    const launchState = previewService as unknown as {
      launchCapabilities: Map<string, unknown>;
      scopedLaunchTokens: Map<string, Set<string>>;
      revokedLaunchCapabilities: Map<string, { revoked_at: string; expires_at: string }>;
    };

    for (let index = 0; index < 400; index += 1) {
      previewService.mintLaunchCapability({
        workspace_id: "ws_preview",
        scope_key: "service:node_bounded:openclaw",
        target_url: `https://launch.local/service-bounded/${String(index)}`,
        delivery_mode: "external",
        supports_iframe: false,
        supports_new_tab: true,
        reused_tunnel: false,
        service_status: "ready",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
      previewService.revokeLaunchScope("service:node_bounded:openclaw");
    }

    expect(launchState.launchCapabilities.size).toBe(0);
    expect(launchState.scopedLaunchTokens.has("service:node_bounded:openclaw")).toBeFalse();
    expect(launchState.revokedLaunchCapabilities.size).toBeLessThanOrEqual(256);
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
