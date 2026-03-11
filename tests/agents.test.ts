import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AgentService, AuthService, createControlPlaneDatabase, handleAppRequest, LocalJobService, Or3NetApp } from "../src/index.ts";
import type { SessionProofValidator } from "../src/auth/service.ts";
import type { InternAbortResponse, InternClient, InternJobEvent, InternSubagentRequest, InternSubagentResponse, InternTurnRequest, InternTurnResponse } from "../sdk/intern/index.ts";

class AgentPhaseValidator implements SessionProofValidator {
  public validateSessionProof(): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    return Promise.resolve({
      user_id: "agent_admin",
      workspace_id: "ws_agents",
      scopes: ["agents:read", "agents:write"],
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

describe("agent CRUD routes", () => {
  let database = createControlPlaneDatabase();
  let authService: AuthService;
  let app: Or3NetApp;

  beforeEach(() => {
    database = createControlPlaneDatabase();
    database.saveWorkspace({ workspace_id: "ws_agents", name: "Agents", created_at: "2024-01-01T00:00:00.000Z" });
    database.saveWorkspace({ workspace_id: "ws_other", name: "Other", created_at: "2024-01-01T00:00:00.000Z" });
    authService = new AuthService({
      secret: "agents-secret",
      database,
      sessionProofValidator: new AgentPhaseValidator(),
    });
    app = new Or3NetApp({
      authService,
      localJobService: new LocalJobService({ database, internClient: new NoopInternClient() }),
      agentService: new AgentService(database),
    });
  });

  afterEach(() => {
    database.close();
  });

  test("creates, reads, updates, lists, and deletes agents", async () => {
    const token = await exchangeToken(app);

    const createResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent_chat",
          workspace_id: "ws_agents",
          name: "Chat Agent",
          instructions: "Help with chat plugin workflows",
          tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
          node_requirements: { capabilities: ["exec"], preferred_node_ids: [] },
        }),
      }),
    );
    expect(createResponse.status).toBe(201);

    const listResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const listPayload = (await listResponse.json()) as { items: { agent_id: string }[] };
    expect(listPayload.items.map((item) => item.agent_id)).toEqual(["agent_chat"]);

    const updateResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents/agent_chat", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent_chat",
          workspace_id: "ws_agents",
          name: "Chat Agent v2",
          instructions: "Help with chat plugin workflows carefully",
          tool_policy: { mode: "allow_list", allowed_tools: ["read_file"], blocked_tools: [] },
          node_requirements: { capabilities: ["exec"], preferred_node_ids: ["node_a"] },
        }),
      }),
    );
    const updated = (await updateResponse.json()) as { agent: { name: string } };
    expect(updated.agent.name).toBe("Chat Agent v2");

    const getResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents/agent_chat", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    const getPayload = (await getResponse.json()) as { agent: { tool_policy: { mode: string } } };
    expect(getPayload.agent.tool_policy.mode).toBe("allow_list");

    const deleteResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents/agent_chat", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(deleteResponse.status).toBe(204);

    const missingResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents/agent_chat", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(missingResponse.status).toBe(404);
  });

  test("enforces workspace and scope boundaries for agent routes", async () => {
    const token = await exchangeToken(app);
    const forbiddenBody = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent_bad",
          workspace_id: "ws_other",
          name: "Bad",
          instructions: "nope",
          tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
          node_requirements: { capabilities: [], preferred_node_ids: [] },
        }),
      }),
    );
    expect(forbiddenBody.status).toBe(403);

    const { api_key: readonlyKey } = await authService.createApiKey({
      workspace_id: "ws_agents",
      name: "agents-readonly",
      scopes: ["agents:read"],
    });
    const scopeResponse = await handleAppRequest(
      app,
      new Request("http://or3.test/v1/workspaces/ws_agents/agents", {
        method: "POST",
        headers: { Authorization: `Bearer ${readonlyKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "agent_scope",
          workspace_id: "ws_agents",
          name: "Scoped",
          instructions: "nope",
          tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
          node_requirements: { capabilities: [], preferred_node_ids: [] },
        }),
      }),
    );
    expect(scopeResponse.status).toBe(403);
  });
});

const exchangeToken = async (app: Or3NetApp): Promise<string> => {
  const response = await handleAppRequest(
    app,
    new Request("http://or3.test/v1/auth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "test", session_proof: { ok: true }, workspace_id: "ws_agents" }),
    }),
  );
  const payload = (await response.json()) as { token: string };
  return payload.token;
};