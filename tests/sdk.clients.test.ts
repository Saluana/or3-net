/* eslint-disable @typescript-eslint/array-type, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
import { afterEach, describe, expect, test } from "bun:test";

import { Sandbox, SandboxManager } from "@alibaba-group/opensandbox";

import { HttpInternClient } from "../sdk/intern/client.ts";
import { isInternSubagentsUnavailable } from "../sdk/intern/index.ts";
import { resolveOpenSandboxClientConfig, SdkOpenSandboxClient } from "../sdk/opensandbox/client.ts";

describe("SDK clients", () => {
  const restoreCallbacks: Array<() => void> = [];

  afterEach(() => {
    while (restoreCallbacks.length > 0) {
      restoreCallbacks.pop()?.();
    }
  });

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

  test("OpenSandbox wrapper maps lifecycle and connection operations onto the SDK", async () => {
    const runCalls: string[] = [];
    const endpointCalls: number[] = [];
    const writes: Array<{ path: string; data: string }> = [];
    const directories: string[] = [];
    const pauseCalls: string[] = [];
    const killCalls: string[] = [];
    const renewCalls: number[] = [];

    patchStatic(Sandbox, "create", async () => createFakeSandbox("osbx_created", {
      onRun: (command) => runCalls.push(command),
      onEndpoint: (port) => endpointCalls.push(port),
      onWrite: (entries) => writes.push(...entries),
      onCreateDirectories: (paths) => directories.push(...paths.map((entry) => entry.path)),
      onPause: (id) => pauseCalls.push(id),
      onKill: (id) => killCalls.push(id),
      onRenew: (timeout) => renewCalls.push(timeout),
    }), restoreCallbacks);
    patchStatic(Sandbox, "connect", async ({ sandboxId }: { sandboxId: string }) => createFakeSandbox(sandboxId, {
      onRun: (command) => runCalls.push(command),
      onEndpoint: (port) => endpointCalls.push(port),
      onWrite: (entries) => writes.push(...entries),
      onCreateDirectories: (paths) => directories.push(...paths.map((entry) => entry.path)),
      onPause: (id) => pauseCalls.push(id),
      onKill: (id) => killCalls.push(id),
      onRenew: (timeout) => renewCalls.push(timeout),
    }), restoreCallbacks);
    patchStatic(Sandbox, "resume", async ({ sandboxId }: { sandboxId: string }) => createFakeSandbox(sandboxId, {
      onPause: (id) => pauseCalls.push(id),
      onKill: (id) => killCalls.push(id),
      onRenew: (timeout) => renewCalls.push(timeout),
    }), restoreCallbacks);
    patchStatic(SandboxManager, "create", (() => ({
      listSandboxInfos: async () => ({
        items: [createSdkSandboxInfo("osbx_created", "running", { or3_workspace_id: "ws_test" })],
      }),
      getSandboxInfo: async (id: string) => createSdkSandboxInfo(id, "paused"),
      pauseSandbox: async (id: string) => {
        pauseCalls.push(id);
      },
      killSandbox: async (id: string) => {
        killCalls.push(id);
      },
      close: async () => undefined,
    })) as any, restoreCallbacks);

    const client = new SdkOpenSandboxClient({
      apiKey: "api-key",
      domain: "sandbox.test",
      defaultImage: "ubuntu",
      defaultTimeoutSeconds: 120,
    });

    const connection = await client.create({ workspace_id: "ws_test", metadata: { or3: "yes" } });
    const streamed: string[] = [];
    const resultEvents: Record<string, unknown>[] = [];
    const result = await connection.runCommand("echo hello", {}, {
      onStdout: ({ text }) => {
        streamed.push(text);
      },
      onResult: (payload) => {
        resultEvents.push(payload);
      },
    });
    await connection.writeFiles([{ path: "/tmp/demo.txt", data: "hello" }]);
    await connection.createDirectories([{ path: "/tmp/demo" }]);
    const content = await connection.readFile("/tmp/demo.txt");
    const endpoint = await connection.getEndpoint(3000);
    await connection.pause();
    await connection.resume();
    await connection.renew(90);
    await connection.kill();
    await connection.close();

    expect(streamed).toEqual(["echo hello"]);
    expect(resultEvents).toEqual([{ status: "completed" }]);
    expect(result).toMatchObject({ exit_code: 0, stdout: "echo hello", stderr: "" });
    expect(content).toBe("hello");
    expect(endpoint).toEqual({ endpoint: "launch.local/osbx_created/3000", url: "https://launch.local/osbx_created/3000" });
    expect(runCalls).toEqual(["echo hello"]);
    expect(writes).toEqual([{ path: "/tmp/demo.txt", data: "hello" }]);
    expect(directories).toEqual(["/tmp/demo"]);
    expect(endpointCalls).toEqual([3000]);

    expect(await client.list({ page_size: 10 })).toEqual([
      {
        id: "osbx_created",
        status: "running",
        created_at: "2024-01-01T00:00:00.000Z",
        expires_at: null,
        metadata: { or3_workspace_id: "ws_test" },
      },
    ]);
    expect(await client.get("osbx_created")).toEqual({
      id: "osbx_created",
      status: "paused",
      created_at: "2024-01-01T00:00:00.000Z",
      expires_at: null,
    });
    await client.pause("osbx_created");
    await client.resume("osbx_created");
    await client.renew("osbx_created", 120);
    await client.kill("osbx_created");

    expect(pauseCalls).toContain("osbx_created");
    expect(killCalls).toContain("osbx_created");
    expect(renewCalls).toContain(90);
    expect(renewCalls).toContain(120);
  });

  test("SDK clients surface parsed backend request errors and retry metadata", async () => {
    patchStatic(Sandbox, "create", async () => {
      const error = new Error("request failed") as Error & {
        status?: number;
        retryAfter?: number;
        error?: { message: string; code: string; status: number };
      };
      error.status = 429;
      error.retryAfter = 3;
      error.error = { message: "rate limited", code: "rate_limited", status: 429 };
      throw error;
    }, restoreCallbacks);

    const sandboxClient = new SdkOpenSandboxClient({
      apiKey: "api-key",
      domain: "sandbox.test",
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
      await sandboxClient.create({ workspace_id: "ws_test" });
    } catch (error: unknown) {
      sandboxError = error;
    }
    expect(sandboxError).toMatchObject({
      name: "OpenSandboxRequestError",
      message: "rate limited",
      status: 429,
      code: "rate_limited",
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

  test("OpenSandbox wrapper preserves provider exit codes from result payloads", async () => {
    patchStatic(Sandbox, "create", async () => ({
      id: "osbx_exit",
      commands: {
        run: async () => ({
          logs: { stdout: [{ text: "boom" }], stderr: [{ text: "bad" }] },
          result: [{ status: "failed", exit_code: 7 }],
        }),
      },
      files: {
        writeFiles: async () => undefined,
        readFile: async () => "",
        createDirectories: async () => undefined,
      },
      getEndpoint: async () => ({ endpoint: "launch.local/osbx_exit/3000" }),
      getEndpointUrl: async () => "https://launch.local/osbx_exit/3000",
      pause: async () => undefined,
      resume: async () => createFakeSandbox("osbx_exit"),
      renew: async () => undefined,
      kill: async () => undefined,
      close: async () => undefined,
    }) as unknown as Sandbox, restoreCallbacks);

    const client = new SdkOpenSandboxClient({
      apiKey: "api-key",
      domain: "sandbox.test",
    });

    const connection = await client.create({ workspace_id: "ws_test" });
    const result = await connection.runCommand("false");

    expect(result.exit_code).toBe(7);
    expect(result.stdout).toBe("boom");
    expect(result.stderr).toBe("bad");
  });

  test("resolveOpenSandboxClientConfig normalizes env aliases and optional fields", () => {
    expect(resolveOpenSandboxClientConfig({})).toBeNull();

    expect(resolveOpenSandboxClientConfig({
      OR3_NET_OPENSANDBOX_API_KEY: "api-key",
      OR3_NET_OPENSANDBOX_BASE_URL: "sandbox.test",
      OR3_NET_OPENSANDBOX_PROTOCOL: "https",
      OR3_NET_OPENSANDBOX_REQUEST_TIMEOUT_SECONDS: "12",
      OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS: "45",
      OR3_NET_OPENSANDBOX_DEFAULT_TIMEOUT_SECONDS: "90",
      OR3_NET_OPENSANDBOX_DEFAULT_IMAGE: "ubuntu",
      OR3_NET_OPENSANDBOX_USE_SERVER_PROXY: "true",
    })).toEqual({
      apiKey: "api-key",
      domain: "sandbox.test",
      protocol: "https",
      requestTimeoutSeconds: 12,
      defaultReadyTimeoutSeconds: 45,
      defaultTimeoutSeconds: 90,
      defaultImage: "ubuntu",
      useServerProxy: true,
    });
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

const createFakeSandbox = (
  sandboxId: string,
  hooks: {
    onRun?: (command: string) => void;
    onEndpoint?: (port: number) => void;
    onWrite?: (entries: Array<{ path: string; data: string }>) => void;
    onCreateDirectories?: (paths: Array<{ path: string }>) => void;
    onPause?: (sandboxId: string) => void;
    onKill?: (sandboxId: string) => void;
    onRenew?: (timeout: number) => void;
  } = {},
): Sandbox => {
  const files = new Map<string, string>();
  return {
    id: sandboxId,
    commands: {
      run: async (
        command: string,
        _options: unknown,
        handlers: { onStdout?: (message: { text: string }) => void; onResult?: (payload: Record<string, unknown>) => void },
      ) => {
        hooks.onRun?.(command);
        handlers.onStdout?.({ text: command });
        handlers.onResult?.({ status: "completed" });
        return {
          logs: { stdout: [{ text: command }], stderr: [] },
          result: [{ status: "completed", exit_code: 0 }],
        };
      },
    },
    files: {
      writeFiles: async (entries: Array<{ path: string; data: string }>) => {
        hooks.onWrite?.(entries);
        for (const entry of entries) {
          files.set(entry.path, entry.data);
        }
      },
      readFile: async (path: string) => files.get(path) ?? "",
      createDirectories: async (paths: Array<{ path: string }>) => {
        hooks.onCreateDirectories?.(paths);
      },
    },
    getEndpoint: async (port: number) => {
      hooks.onEndpoint?.(port);
      return { endpoint: `launch.local/${sandboxId}/${String(port)}` };
    },
    getEndpointUrl: async (port: number) => `https://launch.local/${sandboxId}/${String(port)}`,
    pause: async () => {
      hooks.onPause?.(sandboxId);
    },
    resume: async () => createFakeSandbox(sandboxId, hooks),
    renew: async (timeout: number) => {
      hooks.onRenew?.(timeout);
    },
    kill: async () => {
      hooks.onKill?.(sandboxId);
    },
    close: async () => undefined,
  } as unknown as Sandbox;
};

const patchStatic = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K],
  restoreCallbacks: Array<() => void>,
): void => {
  const original = target[key];
  target[key] = replacement;
  restoreCallbacks.push(() => {
    target[key] = original;
  });
};

const createSdkSandboxInfo = (id: string, state: string, metadata?: Record<string, unknown>): any => ({
  id,
  image: "ubuntu",
  entrypoint: ["tail", "-f", "/dev/null"],
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  expiresAt: null,
  status: { state },
  ...(metadata === undefined ? {} : { metadata }),
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
