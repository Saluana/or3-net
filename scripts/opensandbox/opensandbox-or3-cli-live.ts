import { AuthService, createControlPlaneDatabase, startServer, type SessionProofValidator, LocalJobService } from "../../src/index.ts";
import { fileURLToPath } from "node:url";
import type {
  InternAbortResponse,
  InternClient,
  InternJobEvent,
  InternSubagentRequest,
  InternSubagentResponse,
  InternTurnRequest,
  InternTurnResponse,
} from "../../sdk/intern/index.ts";

const workspaceId = "ws_demo";
const port = 3002;
const baseUrl = `http://127.0.0.1:${String(port)}`;
const secret = "dev-secret";
const repoRoot = new URL("../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

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

const logStep = (message: string): void => {
  process.stdout.write(`\n==> ${message}\n`);
};

const waitForServer = async (): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/console`);
      if (response.ok) {
        return;
      }
    } catch {
      void 0;
    }
    await Bun.sleep(100);
  }
  throw new Error(`OR3 Net server did not become ready at ${baseUrl}`);
};

const runCli = async (args: string[]): Promise<string> => {
  const child = Bun.spawn(["bun", "run", "cli", "--", ...args], {
    cwd: repoRootPath,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (stderrText.trim() !== "") {
    process.stderr.write(stderrText);
  }

  if (exitCode !== 0) {
    throw new Error(`CLI command failed (${args.join(" ")}) with exit code ${String(exitCode)}`);
  }

  process.stdout.write(stdoutText);
  return stdoutText;
};

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const parseLogsResponse = (text: string): { chunks: { message?: string }[] } => parseJson(text) as { chunks: { message?: string }[] };

const database = createControlPlaneDatabase();
database.saveWorkspace({
  workspace_id: workspaceId,
  name: "OpenSandbox Demo Workspace",
  created_at: new Date().toISOString(),
});

const server = startServer({
  database,
  authService: new AuthService({
    secret,
    database,
    sessionProofValidator: new StaticSessionProofValidator(),
  }),
  localJobService: new LocalJobService({
    database,
    internClient: new FakeInternClient(),
    reconcileOnStartup: false,
  }),
  port,
});

let sessionId = "";

try {
  await waitForServer();
  logStep("exchanging auth token");
  const tokenResponse = parseJson(await runCli([
    "auth",
    "exchange",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
  ])) as { token: string };
  const token = tokenResponse.token;

  logStep("listing runtimes");
  await runCli([
    "runtimes",
    "list",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--token",
    token,
  ]);

  logStep("creating runtime session");
  const createResponse = parseJson(await runCli([
    "runtime-sessions",
    "create",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--token",
    token,
    "--runtime-id",
    "opensandbox",
    "--input-json",
    '{"workspace_mode":"none","required_capabilities":["exec","copy-in","copy-out"]}',
  ])) as { session: { session_id: string } };
  sessionId = createResponse.session.session_id;
  process.stdout.write(`session_id=${sessionId}\n`);

  logStep("executing command in runtime session");
  await runCli([
    "runtime-sessions",
    "exec",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--session-id",
    sessionId,
    "--token",
    token,
    "--command",
    "python",
    "--args-json",
    '["-c","print(\\"hello from or3 cli\\")"]',
  ]);

  logStep("copying text into runtime session");
  await runCli([
    "runtime-sessions",
    "copy-in",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--session-id",
    sessionId,
    "--token",
    token,
    "--destination-path",
    "/tmp/cli-demo.txt",
    "--content-text",
    "hello from copy-in",
  ]);

  logStep("copying text back out");
  await runCli([
    "runtime-sessions",
    "copy-out",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--session-id",
    sessionId,
    "--token",
    token,
    "--source-path",
    "/tmp/cli-demo.txt",
    "--encoding",
    "text",
  ]);

  logStep("reading runtime logs");
  const logsResponse = parseLogsResponse(await runCli([
    "runtime-sessions",
    "logs",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--session-id",
    sessionId,
    "--token",
    token,
    "--limit",
    "20",
  ]));
  if (logsResponse.chunks.length === 0) {
    throw new Error("runtime logs were empty");
  }

  logStep("destroying runtime session");
  await runCli([
    "runtime-sessions",
    "destroy",
    "--base-url",
    baseUrl,
    "--workspace-id",
    workspaceId,
    "--session-id",
    sessionId,
    "--token",
    token,
  ]);
  sessionId = "";

  logStep("manual OR3 Net runtime CLI session passed");
} finally {
  if (sessionId !== "") {
    try {
      const tokenResponse = parseJson(await runCli([
        "auth",
        "exchange",
        "--base-url",
        baseUrl,
        "--workspace-id",
        workspaceId,
      ])) as { token: string };
      await runCli([
        "runtime-sessions",
        "destroy",
        "--base-url",
        baseUrl,
        "--workspace-id",
        workspaceId,
        "--session-id",
        sessionId,
        "--token",
        tokenResponse.token,
      ]);
    } catch {
      void 0;
    }
  }
  void server.stop(true);
  database.close();
}
