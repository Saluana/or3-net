import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AgentService, AuthService, createControlPlaneDatabase, handleAppRequest, LocalJobService, Or3NetApp } from "../src/index.ts";
import type { SessionProofValidator } from "../src/auth/service.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";

class ConsoleValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "console_admin",
      workspace_id: "ws_console",
      scopes: ["agents:read", "agents:write", "jobs:read", "jobs:write", "nodes:read", "services:write", "previews:read", "api-keys:read", "sessions:read"],
    });
  }
}

class NoopInternClient implements InternClient {
  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> { void request; return Promise.resolve({ job_id: "noop", status: "completed" }); }
  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> { void request; await Promise.resolve(); yield { event: "queued", data: { job_id: "noop", status: "queued" } }; }
  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> { void request; return Promise.resolve({ job_id: "sub", child_session_key: "svc:sub", status: "queued" }); }
  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> { await Promise.resolve(); yield { event: "queued", data: { job_id: jobId, status: "queued" } }; }
  public abortJob(jobId: string): Promise<InternAbortResponse> { return Promise.resolve({ ok: true, job_id: jobId }); }
}

describe("console route", () => {
  let database = createControlPlaneDatabase();
  let app: Or3NetApp;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_console", name: "Console", created_at: "2024-01-01T00:00:00.000Z" });
    app = new Or3NetApp({
      authService: new AuthService({ secret: "console-secret", database, sessionProofValidator: new ConsoleValidator() }),
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
      agentService: new AgentService(database),
    });
  });

  afterEach(() => {
    database.close();
  });

  test("serves the built-in operator console", async () => {
    const response = await handleAppRequest(app, new Request("http://or3.test/console"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("OR3 Net Console");
    expect(html).toContain("Jobs");
    expect(html).toContain("API Keys");
    expect(html).toContain("Sessions");
    expect(html).toContain("Open Dashboard");
    expect(html).toContain("Revoke Access");
    expect(html).toContain("Restart Service");
    expect(html).toContain("/v1/workspaces/' + workspaceId + '/jobs");
    expect(html).toContain("/v1/workspaces/' + workspaceId + '/api-keys");
    expect(html).toContain("/v1/workspaces/' + workspaceId + '/sessions");
  });
});