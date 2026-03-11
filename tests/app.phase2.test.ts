import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SessionProofValidator } from "../src/auth/service.ts";
import { AuthService, createControlPlaneDatabase, handleAppRequest, LocalJobService, Or3NetApp } from "../src/index.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";
import { JobStreamBroker } from "../src/execution/job-streams.ts";

class StaticSessionProofValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read", "jobs:write"],
    });
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

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    authService = new AuthService({
      secret: "phase2-secret",
      database,
      sessionProofValidator: new StaticSessionProofValidator(),
    });
    internClient = new FakeInternClient();
    app = new Or3NetApp({
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
        },
        body: JSON.stringify({
          session_key: "svc:test",
          message: "say hello",
          allowed_tools: ["read_file"],
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