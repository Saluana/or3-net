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
});