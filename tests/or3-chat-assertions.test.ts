
import { describe, expect, test } from "bun:test";

import {
  AuthService,
  createControlPlaneDatabase,
  handleAppRequest,
  issueOr3ChatSessionProof,
  LocalJobService,
  Or3ChatSessionProofValidator,
  Or3NetApp,
  validateOr3ChatSessionProof,
  validateWorkspaceToken,
} from "../src/index.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";

const secret = "or3-chat-proof-secret";

const expectRejectsWithMessage = async (
  action: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> => {
  try {
    await action();
    throw new Error(`expected action to reject with ${expectedMessage}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expectedMessage);
  }
};

class NoopInternClient implements InternClient {
  public submitTurn(_request: InternTurnRequest): Promise<InternTurnResponse> {
    return Promise.resolve({ job_id: "noop", status: "completed" });
  }

  public async *submitTurnStream(_request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "completion", data: { job_id: "noop", status: "completed" } };
  }

  public spawnSubagent(_request: InternSubagentRequest): Promise<InternSubagentResponse> {
    return Promise.resolve({ job_id: "noop-sub", child_session_key: "svc:noop", status: "queued" });
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    await Promise.resolve();
    yield { event: "completion", data: { job_id: jobId, status: "completed" } };
  }

  public abortJob(jobId: string): Promise<InternAbortResponse> {
    return Promise.resolve({ ok: true, job_id: jobId, status: "aborted" });
  }
}

describe("or3-chat host assertion exchange", () => {
  test("issues and validates a host-signed session proof", async () => {
    const proof = await issueOr3ChatSessionProof({
      secret,
      subject: "user_chat",
      workspace_id: "ws_chat",
      scopes: ["jobs:read", "jobs:write"],
      now: new Date("2099-01-01T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    const claims = await validateOr3ChatSessionProof(proof, {
      secret,
      now: new Date("2099-01-01T00:00:30.000Z"),
    });

    expect(claims.subject).toBe("user_chat");
    expect(claims.workspace_id).toBe("ws_chat");
    expect(claims.scopes).toEqual(["jobs:read", "jobs:write"]);
    expect(claims.kind).toBe("or3-chat-assertion-v1");
  });

  test("rejects expired host assertions", async () => {
    const proof = await issueOr3ChatSessionProof({
      secret,
      subject: "user_chat",
      workspace_id: "ws_chat",
      scopes: ["jobs:read"],
      now: new Date("2099-01-01T00:00:00.000Z"),
      ttlMs: 1_000,
    });

    await expectRejectsWithMessage(
      () => validateOr3ChatSessionProof(proof, {
        secret,
        now: new Date("2099-01-01T00:00:02.000Z"),
      }),
      "expired",
    );
  });

  test("rejects issuer mismatch and bad signatures", async () => {
    const proof = await issueOr3ChatSessionProof({
      secret,
      issuer: "chat-a",
      subject: "user_chat",
      workspace_id: "ws_chat",
      scopes: ["jobs:read"],
      now: new Date("2099-01-01T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    await expectRejectsWithMessage(
      () => validateOr3ChatSessionProof(proof, {
        secret,
        issuer: "chat-b",
        now: new Date("2099-01-01T00:00:30.000Z"),
      }),
      "issuer",
    );

    await expectRejectsWithMessage(
      () => validateOr3ChatSessionProof(
        { ...proof, assertion: `${proof.assertion}00` },
        {
          secret,
          issuer: "chat-a",
          now: new Date("2099-01-01T00:00:30.000Z"),
        },
      ),
      "signature",
    );
  });

  test("rejects workspace hint mismatches when exchanging through AuthService", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_chat",
      name: "Chat Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const authService = new AuthService({
      secret: "workspace-secret",
      database,
      sessionProofValidator: new Or3ChatSessionProofValidator({ secret }),
    });

    const proof = await issueOr3ChatSessionProof({
      secret,
      subject: "user_chat",
      workspace_id: "ws_chat",
      scopes: ["jobs:read"],
      now: new Date("2099-01-01T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    await expectRejectsWithMessage(
      () =>
        authService.exchangeSessionProof({
          provider: "or3-chat",
          session_proof: proof,
          workspace_id: "ws_other",
        }),
      "workspace mismatch",
    );

    database.close();
  });

  test("exchanges a valid or3-chat proof through the HTTP auth route", async () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_chat",
      name: "Chat Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const authService = new AuthService({
      secret: "workspace-secret",
      database,
      sessionProofValidator: new Or3ChatSessionProofValidator({ secret }),
    });
    const app = new Or3NetApp({
      database,
      authService,
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
    });

    const proof = await issueOr3ChatSessionProof({
      secret,
      subject: "user_chat",
      workspace_id: "ws_chat",
      scopes: ["jobs:read", "jobs:write"],
      now: new Date("2099-01-01T00:00:00.000Z"),
      ttlMs: 60_000,
    });

    const response = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "or3-chat",
          session_proof: proof,
          workspace_id: "ws_chat",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { token: string; workspace_id: string; scopes: string[] };
    expect(payload.workspace_id).toBe("ws_chat");
    expect(payload.scopes).toEqual(["jobs:read", "jobs:write"]);

    const principal = await validateWorkspaceToken("workspace-secret", payload.token);
    expect(principal.subject).toBe("user_chat");
    expect(principal.workspace_id).toBe("ws_chat");

    database.close();
  });
});
