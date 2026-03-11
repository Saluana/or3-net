import { describe, expect, test } from "bun:test";

import { HttpInternClient } from "../sdk/intern/client.ts";
import { HttpSandboxClient } from "../sdk/sandbox/client.ts";

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

    const events = await collect(client.submitTurnStream({ sessionKey: "svc:test", message: "hello" }));

    expect(events).toEqual([
      { event: "tool_result", data: { job_id: "job_1", result: { ok: true }, name: "shell" } },
      { event: "completion", data: { job_id: "job_1", status: "completed", final_text: "done" } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toMatch(/^Bearer /);
    expect(requests[0]?.headers.get("Accept")).toBe("text/event-stream");
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
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
          "event: stdout\ndata: {\"chunk\":\"hello\"}\n\n",
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

    const events = await collect(client.execStream("sbx_1", { command: ["echo", "hello"] }));

    expect(events).toEqual([
      { event: "stdout", data: { chunk: "hello" } },
      { event: "result", data: { exit_code: 0 } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer sandbox-token");
    expect(requests[0]?.headers.get("Accept")).toBe("text/event-stream");
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
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
