import { describe, expect, test } from "bun:test";

import { runCli } from "../cli/index.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const createFetchMock = (handler: (input: FetchInput, init?: FetchInit) => Promise<Response>): typeof fetch =>
	handler as unknown as typeof fetch;

describe("or3-net CLI", () => {
  test("prints help for empty input", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli([], {
      fetch: createFetchMock(() => Promise.reject(new Error("fetch should not be called"))),
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("auth exchange");
  });

  test("prints help for the boolean --help flag", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(["--help"], {
      fetch: createFetchMock(() => Promise.reject(new Error("fetch should not be called"))),
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("jobs submit");
  });

  test("submits jobs through the HTTP API", async () => {
    const stdout: string[] = [];
    const requests: Request[] = [];
    const exitCode = await runCli(
      [
        "jobs",
        "submit",
        "--base-url",
        "http://or3.test",
        "--workspace-id",
        "ws_cli",
        "--token",
        "token-123",
        "--session-key",
        "svc:cli",
        "--message",
        "hello",
      ],
      {
        fetch: createFetchMock((input, init) => {
          const request = input instanceof Request ? input : new Request(input.toString(), init);
          requests.push(request);
          return Promise.resolve(
            new Response(JSON.stringify({ job_id: "job_cli", workspace_id: "ws_cli", status: "pending" }), {
              status: 202,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://or3.test/v1/workspaces/ws_cli/jobs");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer token-123");
    const body = await requests[0]?.text();
    expect(body).toContain("svc:cli");
    expect(stdout.join(" ")).toContain("job_cli");
  });

  test("streams job inspection output", async () => {
    const stdout: string[] = [];
    const exitCode = await runCli(
      ["jobs", "stream", "--base-url", "http://or3.test", "--job-id", "job_1", "--token", "token-123"],
      {
        fetch: createFetchMock(() =>
          Promise.resolve(
            new Response("event: job.started\ndata: {\"job_id\":\"job_1\"}\n\n", {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          )),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("job.started");
  });

  test("lists jobs and aborts a job through the HTTP API", async () => {
    const stdout: string[] = [];
    const requests: Request[] = [];

    const listExitCode = await runCli(
      ["jobs", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123", "--status", "running"],
      {
        fetch: createFetchMock((input, init) => {
          const request = input instanceof Request ? input : new Request(input.toString(), init);
          requests.push(request);
          return Promise.resolve(
            new Response(JSON.stringify({ items: [{ job_id: "job_running", status: "running" }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(listExitCode).toBe(0);
    expect(requests[0]?.url).toBe("http://or3.test/v1/workspaces/ws_cli/jobs?status=running");
    expect(stdout.join(" ")).toContain("job_running");

    const abortExitCode = await runCli(
      ["jobs", "abort", "--base-url", "http://or3.test", "--job-id", "job_running", "--token", "token-123"],
      {
        fetch: createFetchMock((input, init) => {
          const request = input instanceof Request ? input : new Request(input.toString(), init);
          requests.push(request);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true, job_id: "job_running" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(abortExitCode).toBe(0);
    expect(requests[1]?.url).toBe("http://or3.test/v1/jobs/job_running/abort");
  });

  test("manages api keys and session inspection through the HTTP API", async () => {
    const stdout: string[] = [];
    const requests: Request[] = [];
    const responses = [
      new Response(JSON.stringify({ items: [{ api_key_id: "api_1", name: "ops" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ api_key: "or3k_secret", record: { api_key_id: "api_2", name: "new-key", revoked_at: null } }), { status: 201, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ record: { api_key_id: "api_2", revoked_at: "2024-01-01T00:00:00.000Z" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { network_session_id: "sess_1" }, jobs: [{ job_id: "job_1" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];

    const fetchMock = createFetchMock((input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected request");
      }
      return Promise.resolve(response);
    });

    expect(
      await runCli(["api-keys", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli([
        "api-keys",
        "create",
        "--base-url",
        "http://or3.test",
        "--workspace-id",
        "ws_cli",
        "--token",
        "token-123",
        "--name",
        "new-key",
        "--scopes",
        "jobs:read,jobs:write",
      ], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["api-keys", "revoke", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123", "--api-key-id", "api_2"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["sessions", "get", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123", "--session-id", "sess_1"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(requests.map((request) => request.url)).toEqual([
      "http://or3.test/v1/workspaces/ws_cli/api-keys",
      "http://or3.test/v1/workspaces/ws_cli/api-keys",
      "http://or3.test/v1/workspaces/ws_cli/api-keys/api_2/revoke",
      "http://or3.test/v1/workspaces/ws_cli/sessions/sess_1",
    ]);
    expect(stdout.join(" ")).toContain("or3k_secret");
    expect(stdout.join(" ")).toContain("sess_1");
  });

  test("lists previews and service actions through the HTTP API", async () => {
    const stdout: string[] = [];
    const requests: Request[] = [];
    const responses = [
      new Response(JSON.stringify({ items: [{ preview_id: "preview_1", status: "ready" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ items: [{ service_id: "openclaw", status: "ready" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ ok: true, revoked: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ service_id: "openclaw", status: "ready" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ preview: { preview: { preview_id: "preview_1", status: "revoked" } } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];

    const fetchMock = createFetchMock((input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected request");
      }
      return Promise.resolve(response);
    });

    expect(
      await runCli(["previews", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["services", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--node-id", "node_1", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["services", "revoke", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--node-id", "node_1", "--service-id", "openclaw", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["services", "restart", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--node-id", "node_1", "--service-id", "openclaw", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(
      await runCli(["previews", "revoke", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--preview-id", "preview_1", "--token", "token-123"], {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      }),
    ).toBe(0);

    expect(requests.map((request) => request.url)).toEqual([
      "http://or3.test/v1/workspaces/ws_cli/previews",
      "http://or3.test/v1/workspaces/ws_cli/nodes/node_1/services",
      "http://or3.test/v1/workspaces/ws_cli/nodes/node_1/services/openclaw/revoke",
      "http://or3.test/v1/workspaces/ws_cli/nodes/node_1/services/openclaw/restart",
      "http://or3.test/v1/workspaces/ws_cli/previews/preview_1/revoke",
    ]);
    expect(stdout.join(" ")).toContain("preview_1");
    expect(stdout.join(" ")).toContain("openclaw");
  });

  test("manages runtimes and runtime sessions through the HTTP API", async () => {
    const stdout: string[] = [];
    const requests: Request[] = [];
    const responses = [
      new Response(JSON.stringify({ items: [{ adapter_id: "opensandbox", display_name: "OpenSandbox" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ runtime: { adapter_id: "opensandbox" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ items: [{ node_id: "opensandbox-runtime" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { session_id: "sess_runtime", adapter_id: "opensandbox" } }), { status: 201, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ items: [{ session_id: "sess_runtime", adapter_id: "opensandbox" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { session_id: "sess_runtime", status: "ready" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ execution_id: "exec_1", result: { exit_code: 0, stdout: "hello", stderr: "" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ chunks: [{ stream: "stdout", message: "hello" }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ transfer: { path: "/tmp/demo.txt", bytes_transferred: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ transfer: { path: "/tmp/demo.txt", bytes_transferred: 2, encoding: "text", content_text: "hi" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { session_id: "sess_runtime", status: "stopped" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ commit: { session_id: "sess_runtime", status: "committed", written_paths: [], deleted_paths: [], conflict_paths: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { session_id: "sess_runtime", staging_status: "discarded" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ staging: { status: "ready" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ session: { session_id: "sess_runtime", status: "destroyed" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];

    const fetchMock = createFetchMock((input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected request");
      }
      return Promise.resolve(response);
    });

    const run = (argv: string[]): Promise<number> =>
      runCli(argv, {
        fetch: fetchMock,
        stdout: { write: (chunk) => stdout.push(chunk) },
        stderr: { write: () => undefined },
      });

    expect(await run(["runtimes", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123"])).toBe(0);
    expect(await run(["runtimes", "get", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--runtime-id", "opensandbox", "--token", "token-123"])).toBe(0);
    expect(await run(["runtimes", "nodes", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--runtime-id", "opensandbox", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "create", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--token", "token-123", "--runtime-id", "opensandbox", "--input-json", '{"workspace_mode":"none"}'])).toBe(0);
    expect(await run(["runtime-sessions", "list", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--adapter-id", "opensandbox", "--limit", "5", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "get", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "exec", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123", "--command", "python", "--args-json", '["-c","print(1,2)"]', "--env-json", '{"DEMO":"1"}', "--timeout-ms", "5000"])).toBe(0);
    expect(await run(["runtime-sessions", "logs", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123", "--limit", "10"])).toBe(0);
    expect(await run(["runtime-sessions", "copy-in", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123", "--destination-path", "/tmp/demo.txt", "--content-text", "hi"])).toBe(0);
    expect(await run(["runtime-sessions", "copy-out", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123", "--source-path", "/tmp/demo.txt", "--encoding", "text"])).toBe(0);
    expect(await run(["runtime-sessions", "stop", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "commit", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "discard", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "staging", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);
    expect(await run(["runtime-sessions", "destroy", "--base-url", "http://or3.test", "--workspace-id", "ws_cli", "--session-id", "sess_runtime", "--token", "token-123"])).toBe(0);

    expect(requests.map((request) => request.url)).toEqual([
      "http://or3.test/v1/workspaces/ws_cli/runtimes",
      "http://or3.test/v1/workspaces/ws_cli/runtimes/opensandbox",
      "http://or3.test/v1/workspaces/ws_cli/runtimes/opensandbox/nodes",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions?adapter_id=opensandbox&limit=5",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/exec",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/logs?limit=10",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/files:copy-in",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/files:copy-out",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/stop",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/commit",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/discard",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/staging",
      "http://or3.test/v1/workspaces/ws_cli/runtime-sessions/sess_runtime/destroy",
    ]);

    const createBody = await requests[3]?.text();
    expect(createBody).toContain('"workspace_mode":"none"');
    expect(createBody).toContain('"adapter_id":"opensandbox"');
    const execBody = await requests[6]?.text();
    expect(execBody).toContain('"command":"python"');
    expect(execBody).toContain('"args":["-c","print(1,2)"]');
    expect(execBody).toContain('"DEMO":"1"');
    const copyInBody = await requests[8]?.text();
    expect(copyInBody).toContain('"destination_path":"/tmp/demo.txt"');
    expect(copyInBody).toContain('"content_text":"hi"');
    const copyOutBody = await requests[9]?.text();
    expect(copyOutBody).toContain('"source_path":"/tmp/demo.txt"');
    expect(stdout.join(" ")).toContain("opensandbox");
    expect(stdout.join(" ")).toContain("sess_runtime");
  });
});