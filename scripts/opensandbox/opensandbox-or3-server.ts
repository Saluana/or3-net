import {
  AuthService,
  createControlPlaneDatabase,
  startServer,
  type SessionProofValidator,
  LocalJobService,
} from "../../src/index.ts";
import type {
  InternAbortResponse,
  InternClient,
  InternJobEvent,
  InternSubagentRequest,
  InternSubagentResponse,
  InternTurnRequest,
  InternTurnResponse,
} from "../../sdk/intern/index.ts";

const workspaceId = Bun.env["OR3_NET_DEV_WORKSPACE_ID"]?.trim() ?? "ws_demo";
const portValue = Bun.env["OR3_NET_DEV_PORT"]?.trim();
const port = portValue === undefined || portValue === "" ? 3001 : Number(portValue);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid OR3_NET_DEV_PORT: ${String(portValue)}`);
}

class StaticSessionProofValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "user_demo",
      workspace_id: workspaceId,
      scopes: [
        "runtimes:read",
        "runtime-sessions:read",
        "runtime-sessions:write",
        "jobs:read",
        "jobs:write",
        "sessions:read",
        "api-keys:read",
        "api-keys:write",
      ],
    });
  }
}

class FakeInternClient implements InternClient {
  public submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    void request;
    return Promise.resolve({ job_id: "job_sync", status: "completed", final_text: "ok" });
  }

  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    void request;
    await Promise.resolve();
    yield { event: "completion", data: { job_id: "job_stream", status: "completed", final_text: "ok" } };
  }

  public spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    void request;
    return Promise.resolve({ job_id: "subagent_1", child_session_key: "svc:child", status: "queued" });
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "queued", data: { job_id: jobId, status: "queued" } };
  }

  public abortJob(jobId: string): Promise<InternAbortResponse> {
    return Promise.resolve({ ok: true, job_id: jobId, status: "aborted" });
  }
}

const database = createControlPlaneDatabase();
database.saveWorkspace({
  workspace_id: workspaceId,
  name: "OpenSandbox Demo Workspace",
  created_at: new Date().toISOString(),
});

const authService = new AuthService({
  secret: Bun.env["OR3_NET_DEV_AUTH_SECRET"]?.trim() ?? "dev-secret",
  database,
  sessionProofValidator: new StaticSessionProofValidator(),
});

const localJobService = new LocalJobService({
  database,
  internClient: new FakeInternClient(),
  reconcileOnStartup: false,
});

const server = startServer({
  database,
  authService,
  localJobService,
  port,
});

console.log(`OR3 Net dev server listening on http://127.0.0.1:${String(server.port)}`);
console.log(`Workspace: ${workspaceId}`);
console.log("OpenSandbox runtime auto-registers when OR3_NET_OPENSANDBOX_* env vars are set.");

const shutdown = (): void => {
  void server.stop(true);
  database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
