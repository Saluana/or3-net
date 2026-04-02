import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SessionProofValidator } from "../src/auth/service.ts";
import { AuthService, createControlPlaneDatabase, handleAppRequest, LocalJobService, Or3NetApp, PreviewService } from "../src/index.ts";
import { issueWorkspaceToken } from "../src/auth/tokens.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";
import { JobStreamBroker } from "../src/execution/job-streams.ts";

class StaticSessionProofValidator implements SessionProofValidator {
  public exchangeCalls = 0;

  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    this.exchangeCalls += 1;
    return Promise.resolve({
      user_id: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read", "jobs:write", "api-keys:read", "api-keys:write", "sessions:read"],
    });
  }
}

class ThrowingSessionProofValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.reject(new Error("session proof backend exploded"));
  }
}

class FakeInternClient implements InternClient {
  public abortCount = 0;
  private readonly abortSignals = new Map<string, () => void>();

  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    void request;
    return Promise.resolve({
      job_id: "intern_sync_job",
      status: "completed",
      final_text: "done",
    });
  }

  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    const backendJobId = `intern_${request.sessionKey}`;
    yield { event: "queued", data: { job_id: backendJobId, status: "queued" } };
    yield { event: "started", data: { job_id: backendJobId, status: "running" } };
    if (request.message === "hang until abort") {
      await new Promise<void>((resolve) => {
        this.abortSignals.set(backendJobId, resolve);
      });
      yield { event: "completion", data: { job_id: backendJobId, status: "aborted" } };
      return;
    }
    yield { event: "text_delta", data: { job_id: backendJobId, content: "hello from intern" } };
    yield { event: "completion", data: { job_id: backendJobId, status: "completed", final_text: "hello from intern" } };
  }

  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    void request;
    return Promise.resolve({
      job_id: "subagent_1",
      child_session_key: "svc:child",
      status: "queued",
    });
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "queued", data: { job_id: jobId, status: "queued" } };
  }

  public abortJob(jobId: string): Promise<InternAbortResponse> {
    this.abortCount += 1;
    const resolve = this.abortSignals.get(jobId);
    if (resolve !== undefined) {
      resolve();
    }
    return Promise.resolve({ ok: true, job_id: jobId, status: "aborted" });
  }
}

describe("phase 2 host API", () => {
  let database = createControlPlaneDatabase();
  let authService: AuthService;
  let internClient: FakeInternClient;
  let app: Or3NetApp;
  let validator: StaticSessionProofValidator;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    database.saveWorkspace({
      workspace_id: "ws_other",
      name: "Other Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    validator = new StaticSessionProofValidator();
    authService = new AuthService({
      secret: "phase2-secret",
      database,
      sessionProofValidator: validator,
    });
    internClient = new FakeInternClient();
    app = new Or3NetApp({
      database,
      authService,
      localJobService: new LocalJobService({ database, internClient }),
    });
  });

  afterEach(() => {
    database.close();
  });

  test("exchanges a session proof and submits a local job with a workspace token", async () => {
    const tokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );
    const tokenPayload = (await tokenResponse.json()) as { token: string };

    const createJobResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.token}`,
          "Content-Type": "application/json",
          "X-Request-Id": "req_phase2_create",
        },
        body: JSON.stringify({
          session_key: "svc:test",
          message: "say hello",
          allowed_tools: ["read_file"],
        }),
      }),
    );

    expect(createJobResponse.headers.get("X-Request-Id")).toBe("req_phase2_create");

    expect(createJobResponse.status).toBe(202);
    const createdJob = (await createJobResponse.json()) as { job_id: string };

    await waitFor(async () => {
      const getJobResponse = await handleAppRequest(
        app,
        new Request(`http://or3.test/v1/jobs/${createdJob.job_id}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${tokenPayload.token}` },
        }),
      );
      const payload = (await getJobResponse.json()) as { status: string; result?: { output_text?: string } };
      expect(payload.status).toBe("completed");
      expect(payload.result?.output_text).toBe("hello from intern");
    });

    const streamResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${createdJob.job_id}/stream`, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    const streamText = await streamResponse.text();

    expect(streamText.match(/event: job.accepted/g)?.length ?? 0).toBe(1);
    expect(streamText).toContain("event: job.started");
    expect(streamText).toContain("event: text.delta");
    expect(streamText).toContain("event: job.completed");
  });

  test("authenticates protected routes with a workspace API key and supports abort", async () => {
    const { api_key: apiKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "test-key",
      scopes: ["jobs:read", "jobs:write"],
    });

    const createJobResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:abort",
          message: "hang until abort",
        }),
      }),
    );
    const createdJob = (await createJobResponse.json()) as { job_id: string };

    const abortResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${createdJob.job_id}/abort`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );

    expect(abortResponse.status).toBe(200);
    expect(internClient.abortCount).toBe(1);

    const secondAbortResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${createdJob.job_id}/abort`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );

    expect(secondAbortResponse.status).toBe(200);
    expect(internClient.abortCount).toBe(1);

    await waitFor(async () => {
      const getJobResponse = await handleAppRequest(
        app,
        new Request(`http://or3.test/v1/jobs/${createdJob.job_id}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        }),
      );
      const payload = (await getJobResponse.json()) as { status: string };
      expect(payload.status).toBe("aborted");
    });
  });

  test("replays auth exchange and job creation when Idempotency-Key is reused", async () => {
    const createAuthRequest = (): Request =>
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-auth-1",
        },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      });

    const firstTokenResponse = await handleAppRequest(app, createAuthRequest());
    const secondTokenResponse = await handleAppRequest(app, createAuthRequest());
    const firstTokenPayload = (await firstTokenResponse.json()) as { token: string; expires_at: string };
    const secondTokenPayload = (await secondTokenResponse.json()) as { token: string; expires_at: string };

    expect(firstTokenPayload).toEqual(secondTokenPayload);
    expect(validator.exchangeCalls).toBe(1);

    const createJobRequest = (): Request =>
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firstTokenPayload.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-job-1",
        },
        body: JSON.stringify({
          session_key: "svc:test",
          message: "idempotent hello",
        }),
      });

    const firstJobResponse = await handleAppRequest(app, createJobRequest());
    const secondJobResponse = await handleAppRequest(app, createJobRequest());
    const firstJobPayload = (await firstJobResponse.json()) as { job_id: string };
    const secondJobPayload = (await secondJobResponse.json()) as { job_id: string };

    expect(firstJobPayload).toEqual(secondJobPayload);
    expect(database.workspace("ws_test").listJobsByFilter("all")).toHaveLength(1);

    const conflictResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firstTokenPayload.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-job-1",
        },
        body: JSON.stringify({
          session_key: "svc:test",
          message: "different body",
        }),
      }),
    );

    expect(conflictResponse.status).toBe(409);
  });

  test("lists jobs, manages api keys, and replays durable session history", async () => {
    const tokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );
    const tokenPayload = (await tokenResponse.json()) as { token: string };

    const createJobResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_kind: "or3-chat",
          client_session_id: "thread_1",
          message: "say hello again",
        }),
      }),
    );

    expect(createJobResponse.status).toBe(202);
    const createdJob = (await createJobResponse.json()) as { job_id: string };

    await waitFor(async () => {
      const getJobResponse = await handleAppRequest(
        app,
        new Request(`http://or3.test/v1/jobs/${createdJob.job_id}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${tokenPayload.token}` },
        }),
      );
      const payload = (await getJobResponse.json()) as { status: string };
      expect(payload.status).toBe("completed");
    });

    const jobsResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs?status=terminal", {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(jobsResponse.status).toBe(200);
    const jobsPayload = (await jobsResponse.json()) as {
      items: { job_id: string; status: string; network_session_id: string | null }[];
    };
    expect(jobsPayload.items).toHaveLength(1);
    expect(jobsPayload.items[0]?.job_id).toBe(createdJob.job_id);
    expect(jobsPayload.items[0]?.status).toBe("completed");
    expect(jobsPayload.items[0]?.network_session_id).toBeString();

    const sessionId = jobsPayload.items[0]?.network_session_id ?? "";

    const sessionsResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/sessions", {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(sessionsResponse.status).toBe(200);
    const sessionsPayload = (await sessionsResponse.json()) as {
      items: { network_session_id: string; client_kind: string; client_session_id: string | null }[];
    };
    expect(sessionsPayload.items).toHaveLength(1);
    expect(sessionsPayload.items[0]?.network_session_id).toBe(sessionId);
    expect(sessionsPayload.items[0]?.client_kind).toBe("or3-chat");
    expect(sessionsPayload.items[0]?.client_session_id).toBe("thread_1");

    const sessionDetailResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(sessionDetailResponse.status).toBe(200);
    const sessionDetailPayload = (await sessionDetailResponse.json()) as {
      session: { network_session_id: string; intern_session_key: string };
      jobs: { job_id: string }[];
    };
    expect(sessionDetailPayload.session.network_session_id).toBe(sessionId);
    expect(sessionDetailPayload.session.intern_session_key).toBeString();
    expect(sessionDetailPayload.jobs[0]?.job_id).toBe(createdJob.job_id);

    const sessionEventsResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/sessions/${sessionId}/events`, {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(sessionEventsResponse.status).toBe(200);
    const sessionEventsPayload = (await sessionEventsResponse.json()) as {
      items: { event_type: string; sequence: number; job_id: string }[];
    };
    expect(sessionEventsPayload.items.map((item) => item.event_type)).toContain("job.completed");
    expect(sessionEventsPayload.items.every((item) => item.job_id === createdJob.job_id)).toBeTrue();
    expect(sessionEventsPayload.items[0]?.sequence ?? 0).toBeGreaterThan(0);
    expect(sessionEventsPayload.items.map((item) => item.sequence)).toEqual(
      [...sessionEventsPayload.items.map((item) => item.sequence)].sort((left, right) => left - right),
    );

    const createKeyResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "operator",
          scopes: ["jobs:read"],
        }),
      }),
    );
    expect(createKeyResponse.status).toBe(201);
    const createKeyPayload = (await createKeyResponse.json()) as {
      api_key: string;
      record: { api_key_id: string; revoked_at: string | null };
    };
    expect(createKeyPayload.api_key.startsWith("or3k_")).toBeTrue();
    expect(createKeyPayload.record.revoked_at).toBeNull();
    expect(createKeyPayload.record).not.toHaveProperty("key_hash");

    const listKeysResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/api-keys", {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(listKeysResponse.status).toBe(200);
    const listKeysPayload = (await listKeysResponse.json()) as {
      items: { api_key_id: string; name: string; revoked_at: string | null }[];
    };
    expect(listKeysPayload.items).toHaveLength(1);
    expect(listKeysPayload.items[0]?.api_key_id).toBe(createKeyPayload.record.api_key_id);
    expect(listKeysPayload.items[0]?.name).toBe("operator");
    expect(listKeysPayload.items[0]).not.toHaveProperty("key_hash");

    const revokeKeyResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/workspaces/ws_test/api-keys/${createKeyPayload.record.api_key_id}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    expect(revokeKeyResponse.status).toBe(200);
    const revokeKeyPayload = (await revokeKeyResponse.json()) as {
      record: { api_key_id: string; revoked_at: string | null };
    };
    expect(revokeKeyPayload.record.api_key_id).toBe(createKeyPayload.record.api_key_id);
    expect(revokeKeyPayload.record.revoked_at).toBeString();
    expect(revokeKeyPayload.record).not.toHaveProperty("key_hash");
  });

  test("rejects invalid api key expiry timestamps", async () => {
    const tokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );
    const tokenPayload = (await tokenResponse.json()) as { token: string };

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "bad-expiry",
          scopes: ["jobs:read"],
          expires_at: "definitely-not-a-timestamp",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: "invalid expires_at",
      code: "input.invalid_parameter",
      status: 400,
    }));
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });

  test("returns a canonical error envelope for malformed JSON request bodies", async () => {
    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "req_malformed_json",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-Id")).toBe("req_malformed_json");
    expect(await response.json()).toEqual({
      error: "invalid JSON body",
      code: "input.malformed_body",
      status: 400,
      request_id: "req_malformed_json",
    });
  });

  test("rejects oversized auth exchange bodies with a stable 413 envelope", async () => {
    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "req_auth_too_large",
        },
        body: JSON.stringify({
          provider: "test",
          workspace_id: "ws_test",
          session_proof: { blob: "x".repeat(140 * 1024) },
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "request body too large",
      code: "input.malformed_body",
      status: 413,
      request_id: "req_auth_too_large",
    });
  });

  test("rejects oversized job creation bodies", async () => {
    const { api_key: apiKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "writer",
      scopes: ["jobs:write"],
    });

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:large",
          message: "x".repeat(300 * 1024),
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(expect.objectContaining({
      error: "request body too large",
      code: "input.malformed_body",
      status: 413,
    }));
  });

  test("caps session list queries at 100 items", async () => {
    for (let index = 0; index < 150; index += 1) {
      database.workspace("ws_test").saveNetworkSession({
        network_session_id: `sess_${String(index)}`,
        client_kind: "or3-chat",
        client_session_id: `thread_${String(index)}`,
        intern_session_key: `svc:sess_${String(index)}`,
        status: "active",
        created_at: `2024-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        updated_at: `2024-01-01T00:01:${String(index % 60).padStart(2, "0")}.000Z`,
        last_activity_at: `2024-01-01T00:02:${String(index % 60).padStart(2, "0")}.000Z`,
      });
    }

    const tokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );
    const tokenPayload = (await tokenResponse.json()) as { token: string };

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/sessions?limit=999999", {
        headers: { Authorization: `Bearer ${tokenPayload.token}` },
      }),
    );
    const payload = (await response.json()) as { items: { network_session_id: string }[] };

    expect(response.status).toBe(200);
    expect(payload.items).toHaveLength(100);
  });

  test("filters session list queries by client session identity", async () => {
    database.workspace("ws_test").saveNetworkSession({
      network_session_id: "sess_thread_1",
      client_kind: "or3-chat",
      client_session_id: "thread_1",
      intern_session_key: "svc:sess_thread_1",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:01:00.000Z",
      last_activity_at: "2024-01-01T00:02:00.000Z",
    });
    database.workspace("ws_test").saveNetworkSession({
      network_session_id: "sess_thread_2",
      client_kind: "or3-chat",
      client_session_id: "thread_2",
      intern_session_key: "svc:sess_thread_2",
      status: "active",
      created_at: "2024-01-01T00:03:00.000Z",
      updated_at: "2024-01-01T00:04:00.000Z",
      last_activity_at: "2024-01-01T00:05:00.000Z",
    });

    const tokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );
    const tokenPayload = (await tokenResponse.json()) as { token: string };

    const response = await handleAppRequest(
      app,
      new Request(
        "http://or3.test/v1/workspaces/ws_test/sessions?client_kind=or3-chat&client_session_id=thread_2&limit=100",
        {
          headers: { Authorization: `Bearer ${tokenPayload.token}` },
        },
      ),
    );
    const payload = (await response.json()) as {
      items: { network_session_id: string; client_session_id: string | null }[];
    };

    expect(response.status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.network_session_id).toBe("sess_thread_2");
    expect(payload.items[0]?.client_session_id).toBe("thread_2");
  });

  test("sanitizes unexpected 500 errors", async () => {
    const explodingApp = new Or3NetApp({
      database,
      authService: new AuthService({
        secret: "phase2-secret",
        database,
        sessionProofValidator: new ThrowingSessionProofValidator(),
      }),
      localJobService: new LocalJobService({ database, internClient }),
    });

    const response = await handleAppRequest(
      explodingApp,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "req_internal_sanitized",
        },
        body: JSON.stringify({
          provider: "test",
          session_proof: { session: "ok" },
          workspace_id: "ws_test",
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal server error",
      code: "server.internal",
      status: 500,
      request_id: "req_internal_sanitized",
    });
  });

  test("returns a stable 400 for malformed preview launch JSON bodies", async () => {
    const previewService = new PreviewService(database);
    previewService.registerPreview("ws_test", {
      preview_id: "preview_json",
      workspace_id: "ws_test",
      kind: "static-site",
      delivery_mode: "embedded-preferred",
      source_type: "files",
      status: "ready",
      path: "/index.html",
      supports_iframe: true,
      supports_new_tab: true,
    });

    const { api_key: previewKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "preview-reader",
      scopes: ["previews:read"],
    });

    const previewApp = new Or3NetApp({
      database,
      authService,
      localJobService: new LocalJobService({ database, internClient }),
      previewService,
    });

    const response = await handleAppRequest(
      previewApp,
      new Request("http://or3.test/v1/workspaces/ws_test/previews/preview_json/launch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${previewKey}`,
          "Content-Type": "application/json",
          "X-Request-Id": "req_preview_bad_json",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid JSON body",
      code: "input.malformed_body",
      status: 400,
      request_id: "req_preview_bad_json",
    });
  });

  test("keeps remaining subscribers active when one stream cancels", async () => {
    const broker = new JobStreamBroker();
    const firstReader = broker.stream("job_multi").getReader();
    const secondReader = broker.stream("job_multi").getReader();

    await firstReader.cancel();

    broker.publish("job_multi", {
      event: "job.started",
      data: { job_id: "job_multi" },
    });

    const next = await secondReader.read();
    expect(next.done).toBeFalse();
    expect(new TextDecoder().decode(next.value)).toContain("event: job.started");

    await secondReader.cancel();
  });

  test("rejects malformed, expired, and scope-limited credentials", async () => {
    const malformedResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: "Basic not-a-bearer",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:bad-auth",
          message: "nope",
        }),
      }),
    );
    expect(malformedResponse.status).toBe(401);
    expect(await malformedResponse.json()).toEqual(expect.objectContaining({
      code: "auth.token_invalid",
      status: 401,
    }));

    const expiredToken = await issueWorkspaceToken({
      secret: "phase2-secret",
      subject: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read", "jobs:write"],
      ttlMs: -1_000,
    });
    const expiredTokenResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${expiredToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:expired",
          message: "nope",
        }),
      }),
    );
    expect(expiredTokenResponse.status).toBe(401);
    expect(await expiredTokenResponse.json()).toEqual(expect.objectContaining({
      code: "auth.token_expired",
      status: 401,
    }));

    const { api_key: expiredApiKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "expired-key",
      scopes: ["jobs:read", "jobs:write"],
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    const expiredApiResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${expiredApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:expired-key",
          message: "nope",
        }),
      }),
    );
    expect(expiredApiResponse.status).toBe(401);
    expect(await expiredApiResponse.json()).toEqual(expect.objectContaining({
      code: "auth.token_invalid",
      status: 401,
    }));

    const { api_key: readonlyKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "readonly-key",
      scopes: ["jobs:read"],
    });
    const missingScopeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readonlyKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:missing-scope",
          message: "nope",
        }),
      }),
    );
    expect(missingScopeResponse.status).toBe(403);
    expect(await missingScopeResponse.json()).toEqual(expect.objectContaining({
      code: "auth.insufficient_scope",
      status: 403,
    }));

    const { api_key: otherWorkspaceKey } = await authService.createApiKey({
      workspace_id: "ws_other",
      name: "other-workspace-key",
      scopes: ["jobs:read", "jobs:write"],
    });
    const workspaceMismatchResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${otherWorkspaceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:workspace-mismatch",
          message: "nope",
        }),
      }),
    );
    expect(workspaceMismatchResponse.status).toBe(403);
    expect(await workspaceMismatchResponse.json()).toEqual(expect.objectContaining({
      code: "auth.workspace_mismatch",
      status: 403,
    }));
  });

  test("does not leak job routes across workspaces", async () => {
    const { api_key: ownerKey } = await exchangeWorkspaceApiKey("ws_test");
    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_test/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_key: "svc:isolated",
          message: "say hello",
        }),
      }),
    );
    const job = (await createResponse.json()) as { job_id: string };

    await waitFor(async () => {
      const stored = await handleAppRequest(
        app,
        new Request(`http://or3.test/v1/jobs/${job.job_id}`, {
          headers: { Authorization: `Bearer ${ownerKey}` },
        }),
      );
      expect(stored.status).toBe(200);
    });

    const { api_key: otherKey } = await exchangeWorkspaceApiKey("ws_other");
    const getResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${job.job_id}`, {
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
    );
    expect(getResponse.status).toBe(404);

    const streamResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${job.job_id}/stream`, {
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
    );
    expect(streamResponse.status).toBe(404);

    const abortResponse = await handleAppRequest(
      app,
      new Request(`http://or3.test/v1/jobs/${job.job_id}/abort`, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherKey}` },
      }),
    );
    expect(abortResponse.status).toBe(404);
  });

  const exchangeWorkspaceApiKey = async (
    workspaceId: string,
  ): Promise<Awaited<ReturnType<AuthService["createApiKey"]>>> =>
    authService.createApiKey({
      workspace_id: workspaceId,
      name: `${workspaceId}-key`,
      scopes: ["jobs:read", "jobs:write"],
    });
});

const waitFor = async (callback: () => Promise<void>, timeoutMs = 1_000): Promise<void> => {
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
