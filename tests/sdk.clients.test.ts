import { describe, expect, test } from "bun:test";

import { HttpInternClient } from "../sdk/intern/client.ts";
import { HttpSandboxClient } from "../sdk/sandbox/client.ts";
import { isInternSubagentsUnavailable } from "../sdk/intern/index.ts";

describe("HTTP SDK clients", () => {
  test("intern client sends service auth headers and parses multi-line SSE payloads", async () => {
    const requests: Request[] = [];
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      requests.push(toRequest(input, init));
      return Promise.resolve(new Response(
        chunkedStream([
          "event: tool_result\ndata: {\"job_id\":\"job_1\",\n",
          "data: \"result\":{\"ok\":true},\"name\":\"shell\"}\n\n",
          "event: completion\ndata: {\"job_id\":\"job_1\",\"status\":\"completed\",\"final_text\":\"done\"}\n\n",
        ]),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ));
    }) as unknown as typeof fetch;
    const client = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: fetchImpl,
    });

    const events = await collect(client.submitTurnStream({
      sessionKey: "svc:test",
      platformSessionRef: {
        workspace_id: "ws_test",
        client_kind: "chat",
        client_session_id: "thread_1",
        network_session_id: "sess_1",
        session_key: "svc:test",
      },
      requestContext: {
        requestId: "req_sdk_turn",
        workspaceId: "ws_test",
        networkSessionId: "sess_1",
      },
      message: "hello",
    }));

    expect(events).toEqual([
      { event: "tool_result", data: { job_id: "job_1", result: { ok: true }, name: "shell" } },
      { event: "completion", data: { job_id: "job_1", status: "completed", final_text: "done" } },
    ]);
    expect(requests).toHaveLength(1);
    const firstRequest = requests[0];
    expect(firstRequest).toBeDefined();
    if (firstRequest === undefined) {
      throw new Error("expected first request");
    }

    expect(firstRequest.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(firstRequest.headers.get("Accept")).toBe("text/event-stream");
    expect(firstRequest.headers.get("Content-Type")).toBe("application/json");
    expect(firstRequest.headers.get("X-Request-Id")).toBe("req_sdk_turn");
    expect(firstRequest.headers.get("X-Workspace-Id")).toBe("ws_test");
    expect(firstRequest.headers.get("X-Network-Session-Id")).toBe("sess_1");
    expect(await firstRequest.clone().json()).toEqual({
      session_key: "svc:test",
      platform_session_ref: {
        workspace_id: "ws_test",
        client_kind: "chat",
        client_session_id: "thread_1",
        network_session_id: "sess_1",
        session_key: "svc:test",
      },
      message: "hello",
    });
  });

  test("intern client serializes subagent requests in snake_case", async () => {
    const requests: Request[] = [];
    const client = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: ((input: FetchInput, init?: RequestInit) => {
        requests.push(toRequest(input, init));
        return Promise.resolve(new Response(
          JSON.stringify({ job_id: "sub_1", child_session_key: "svc:child", status: "queued" }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ));
      }) as unknown as typeof fetch,
    });

    await client.spawnSubagent({
      parentSessionKey: "svc:parent",
      task: "do the thing",
      promptSnapshot: [{ role: "user", content: "hi" }],
      requestContext: {
        requestId: "req_sdk_subagent",
        workspaceId: "ws_test",
        networkSessionId: "sess_parent",
      },
      allowedTools: ["shell"],
      timeoutSeconds: 30,
      profileName: "fast",
      channel: "service",
      replyTo: "job_1",
    });

    expect(requests).toHaveLength(1);
    const subagentRequest = requests[0];
    expect(subagentRequest).toBeDefined();
    if (subagentRequest === undefined) {
      throw new Error("expected subagent request");
    }

    expect(subagentRequest.headers.get("X-Request-Id")).toBe("req_sdk_subagent");
    expect(subagentRequest.headers.get("X-Workspace-Id")).toBe("ws_test");
    expect(subagentRequest.headers.get("X-Network-Session-Id")).toBe("sess_parent");
    expect(await subagentRequest.clone().json()).toEqual({
      parent_session_key: "svc:parent",
      task: "do the thing",
      prompt_snapshot: [{ role: "user", content: "hi" }],
      allowed_tools: ["shell"],
      timeout_seconds: 30,
      profile_name: "fast",
      channel: "service",
      reply_to: "job_1",
    });
  });

  test("intern client rejects stream responses without a body", () => {
    const client = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch,
    });

    expect(collect(client.streamJob("job_1"))).rejects.toThrow("Intern stream response missing body");
  });

  test("sandbox client sends bearer auth and flushes the final SSE frame at EOF", async () => {
    const requests: Request[] = [];
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      requests.push(toRequest(input, init));
      return Promise.resolve(new Response(
        chunkedStream([
          "event: stdout\ndata: hello\n\n",
          "event: result\ndata: {\"exit_code\":0}",
        ]),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ));
    }) as unknown as typeof fetch;
    const client = new HttpSandboxClient({
      baseUrl: "https://sandbox.test",
      token: "sandbox-token",
      fetch: fetchImpl,
    });

    const events = await collect(
      client.execStream("sbx_1", { command: ["echo", "hello"] }, { requestId: "req_sandbox", workspaceId: "ws_test" }),
    );

    expect(events).toEqual([
      { event: "stdout", data: { chunk: "hello" } },
      { event: "result", data: { exit_code: 0 } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer sandbox-token");
    expect(requests[0]?.headers.get("Accept")).toBe("text/event-stream");
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(requests[0]?.headers.get("X-Request-Id")).toBe("req_sandbox");
    expect(requests[0]?.headers.get("X-Workspace-Id")).toBe("ws_test");
    expect(requests[0]?.url).toContain("/v1/sandboxes/sbx_1/exec?stream=1");
  });

  test("SDK clients surface parsed backend request errors and retry metadata", async () => {
    const sandboxClient = new HttpSandboxClient({
      baseUrl: "https://sandbox.test",
      token: "sandbox-token",
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "rate limited", code: "rate_limited", status: 429 }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "3" },
          }),
        )) as unknown as typeof fetch,
    });
    const internClient = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "intern unavailable", code: "server_unavailable", status: 503 }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
          }),
        )) as unknown as typeof fetch,
    });

    let sandboxError: unknown;
    try {
      await sandboxClient.runtimeHealth();
    } catch (error: unknown) {
      sandboxError = error;
    }
    expect(sandboxError).toMatchObject({
      name: "SandboxRequestError",
      message: "rate limited",
      status: 429,
      retryAfterMs: 3000,
    });

    let internError: unknown;
    try {
      await collect(internClient.streamJob("job_1"));
    } catch (error: unknown) {
      internError = error;
    }
    expect(internError).toMatchObject({
      name: "InternRequestError",
      message: "intern unavailable",
      status: 503,
      retryAfterMs: 2000,
    });
  });

  test("sandbox client exposes file, runtime, tunnel, and signed-url helper methods", async () => {
    const requests: Request[] = [];
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      const request = toRequest(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/files/workspace.txt") && request.method === "GET") {
        return Promise.resolve(new Response(JSON.stringify({ path: "/workspace.txt", content: "hello", encoding: "utf-8" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname.endsWith("/files/workspace") && request.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.pathname === "/v1/runtime/health") {
        return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname === "/v1/runtime/info") {
        return Promise.resolve(new Response(JSON.stringify({ runtime: "docker" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname === "/v1/runtime/capacity") {
        return Promise.resolve(new Response(JSON.stringify({ total: 2, available: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname === "/v1/quotas/me") {
        return Promise.resolve(new Response(JSON.stringify({ cpu_seconds_remaining: 10 }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname === "/metrics") {
        return Promise.resolve(new Response("sandbox_up 1\n", { status: 200, headers: { "Content-Type": "text/plain" } }));
      }
      if (url.pathname.endsWith("/tunnels") && request.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ id: "tun_1", sandbox_id: "sbx_1", target_port: 3000, endpoint: "https://sandbox.test/v1/tunnels/tun_1/proxy", auth_mode: "token", visibility: "private" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname.endsWith("/tunnels/tun_1") && request.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.pathname.endsWith("/tunnels/tun_1/signed-url") && request.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ url: "https://sandbox.test/v1/tunnels/tun_1/proxy?or3_sig=abc", expires_at: "2099-01-01T00:00:00.000Z" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }) as unknown as typeof fetch;

    const client = new HttpSandboxClient({ baseUrl: "https://sandbox.test", token: "sandbox-token", fetch: fetchImpl });
    const file = await client.readFile("sbx_1", "/workspace.txt");
    expect(file.content).toBe("hello");
    await client.mkdir("sbx_1", "/workspace");
    const tunnel = await client.createTunnel("sbx_1", { target_port: 3000, protocol: "http", auth_mode: "token", visibility: "private" });
    const signedUrl = await client.createSignedTunnelUrl("tun_1", { path: "/", ttl_seconds: 300 });
    expect(await client.runtimeHealth()).toEqual({ status: "ok" });
    expect(await client.runtimeInfo()).toEqual({ runtime: "docker" });
    expect(await client.runtimeCapacity()).toEqual({ total: 2, available: 1 });
    expect(await client.getQuota()).toEqual({ cpu_seconds_remaining: 10 });
    expect(await client.getMetrics()).toBe("sandbox_up 1\n");
    await client.revokeTunnel("tun_1");

    expect(tunnel).toEqual({ id: "tun_1", sandbox_id: "sbx_1", target_port: 3000, endpoint: "https://sandbox.test/v1/tunnels/tun_1/proxy", auth_mode: "token", visibility: "private" });
    expect(signedUrl).toEqual({ url: "https://sandbox.test/v1/tunnels/tun_1/proxy?or3_sig=abc", expires_at: "2099-01-01T00:00:00.000Z" });
    expect(requests.some((request) => request.url.includes("/v1/sandboxes/sbx_1/files/workspace.txt") && request.method === "GET")).toBeTrue();
    expect(requests.some((request) => request.url.includes("/v1/sandboxes/sbx_1/tunnels") && request.method === "POST")).toBeTrue();
    expect(requests.some((request) => request.url.includes("/v1/tunnels/tun_1/signed-url") && request.method === "POST")).toBeTrue();
    expect(requests.some((request) => request.url.includes("/v1/runtime/health"))).toBeTrue();
    expect(requests.some((request) => request.url.includes("/metrics"))).toBeTrue();
  });

  test("sandbox client rejects stream responses without a body", () => {
    const client = new HttpSandboxClient({
      baseUrl: "https://sandbox.test",
      token: "sandbox-token",
      fetch: (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch,
    });

    expect(collect(client.execStream("sbx_1", { command: ["pwd"] }))).rejects.toThrow(
      "Sandbox stream response missing body",
    );
  });

  test("intern client uses documented stream and abort endpoints", async () => {
    const requests: Request[] = [];
    const client = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: ((input: FetchInput, init?: RequestInit) => {
        const request = toRequest(input, init);
        requests.push(request);
        if (request.url.endsWith("/stream")) {
          return Promise.resolve(new Response(chunkedStream([
            "event: queued\ndata: {\"job_id\":\"job_1\",\"status\":\"queued\"}\n\n",
          ]), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true, job_id: "job_1", status: "aborted" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }) as unknown as typeof fetch,
    });

    expect(await collect(client.streamJob("job_1"))).toEqual([
      { event: "queued", data: { job_id: "job_1", status: "queued" } },
    ]);
    expect(await client.abortJob("job_1")).toEqual({ ok: true, job_id: "job_1", status: "aborted" });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /internal/v1/jobs/job_1/stream",
      "POST /internal/v1/jobs/job_1/abort",
    ]);
  });

  test("treats subagent submission as capability-gated when upstream returns 503", async () => {
    const client = new HttpInternClient({
      baseUrl: "https://intern.test",
      secret: "intern-secret",
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "subagents disabled", code: "server_unavailable", status: 503 }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        )) as unknown as typeof fetch,
    });

    let subagentError: unknown;
    try {
      await client.spawnSubagent({
        parentSessionKey: "svc:parent",
        task: "do the thing",
        promptSnapshot: [{ role: "user", content: "hi" }],
      });
    } catch (error: unknown) {
      subagentError = error;
    }

    expect(isInternSubagentsUnavailable(subagentError)).toBeTrue();
  });
});

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

const chunkedStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

type FetchInput = Parameters<typeof fetch>[0];

const toRequest = (input: FetchInput, init?: RequestInit): Request => {
  if (input instanceof Request) {
    return new Request(input, init);
  }
  return new Request(String(input), init);
};
