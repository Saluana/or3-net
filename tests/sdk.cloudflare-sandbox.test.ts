import { describe, expect, test } from "bun:test";

import {
  HttpCloudflareSandboxClient,
  resolveCloudflareSandboxClientConfig,
} from "../sdk/cloudflare-sandbox/client.ts";
import { CloudflareSandboxRequestError } from "../sdk/cloudflare-sandbox/types.ts";

describe("cloudflare sandbox sdk wrapper", () => {
  test("builds authenticated bridge requests and maps responses", async () => {
    const requests: Request[] = [];
    const client = new HttpCloudflareSandboxClient({
      baseUrl: "https://bridge.test",
      token: "bridge-token",
      requestTimeoutMs: 5000,
      fetch: ((input: FetchInput, init?: RequestInit) => {
        const request = toRequest(input, init);
        requests.push(request);
        if (request.url.endsWith("/sandboxes")) {
          return Promise.resolve(jsonResponse(201, { ok: true, result: { id: "cf_sbx_1", status: "running", preview_enabled: true } }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/exec")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: { exit_code: 0, stdout: "pwd", stderr: "", meta: { provider: "cloudflare-sandbox" } } }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/files")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: null }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/files/read")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: "hello" }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/processes")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: { process_id: "proc_1", command: "node server.js", status: "running" } }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/processes/proc_1/wait-for-port")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: null }));
        }
        if (request.url.endsWith("/sandboxes/cf_sbx_1/ports/3000/expose")) {
          return Promise.resolve(jsonResponse(200, { ok: true, result: { port: 3000, url: "https://preview.example.test", name: "web" } }));
        }
        return Promise.resolve(jsonResponse(200, { ok: true, result: null }));
      }) as unknown as typeof fetch,
    });

    const connection = await client.create({ workspace_id: "ws_test", sandbox_id: "cf_sbx_1" });
    const execResult = await connection.exec("pwd", { cwd: "/workspace" });
    await connection.writeFiles([{ path: "/workspace/README.md", data: "hi" }]);
    const content = await connection.readFile("/workspace/README.md");
    const process = await connection.startProcess("node server.js", { cwd: "/workspace" });
    await connection.waitForPort(process.process_id, 3000, { timeout_ms: 1000 });
    const exposed = await connection.exposePort(3000, { name: "web" });

    expect(execResult).toEqual({
      exit_code: 0,
      stdout: "pwd",
      stderr: "",
      meta: { provider: "cloudflare-sandbox" },
    });
    expect(content).toBe("hello");
    expect(process.process_id).toBe("proc_1");
    expect(exposed.url).toBe("https://preview.example.test");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer bridge-token");
    expect(await requests[0]?.clone().json()).toEqual({ workspace_id: "ws_test", sandbox_id: "cf_sbx_1" });
    expect(await requests[1]?.clone().json()).toEqual({ command: "pwd", cwd: "/workspace" });
  });

  test("maps bridge errors and retry metadata", async () => {
    const client = new HttpCloudflareSandboxClient({
      baseUrl: "https://bridge.test",
      token: "bridge-token",
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, error: "rate limited", status: 429, code: "rate_limited", retry_after_ms: 4000 }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "4" } },
          ),
        )) as unknown as typeof fetch,
    });

    try {
      await client.health();
      throw new Error("expected health request to fail");
    } catch (error: unknown) {
      expect(error).toEqual(
        expect.objectContaining({
          name: "CloudflareSandboxRequestError",
          message: "rate limited",
          status: 429,
          code: "rate_limited",
          retryAfterMs: 4000,
        }),
      );
    }
  });

  test("normalizes env configuration", () => {
    expect(resolveCloudflareSandboxClientConfig()).toBeNull();
    expect(
      resolveCloudflareSandboxClientConfig({
        OR3_NET_CLOUDFLARE_SANDBOX_BASE_URL: "https://bridge.test",
        OR3_NET_CLOUDFLARE_SANDBOX_TOKEN: "bridge-token",
        OR3_NET_CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS: "2500",
        OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME: "preview.example.test",
      }),
    ).toEqual({
      baseUrl: "https://bridge.test",
      token: "bridge-token",
      requestTimeoutMs: 2500,
      previewHostname: "preview.example.test",
    });
    expect(() =>
      resolveCloudflareSandboxClientConfig({ OR3_NET_CLOUDFLARE_SANDBOX_BASE_URL: "https://bridge.test" }),
    ).toThrow("OR3_NET_CLOUDFLARE_SANDBOX_TOKEN is required");
  });

  test("wraps transport failures as provider errors", async () => {
    const client = new HttpCloudflareSandboxClient({
      baseUrl: "https://bridge.test",
      token: "bridge-token",
      fetch: (() => Promise.reject(new Error("dial tcp refused"))) as unknown as typeof fetch,
    });

    try {
      await client.health();
      throw new Error("expected transport failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CloudflareSandboxRequestError);
    }
  });
});

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type FetchInput = Request | URL | string;

const toRequest = (input: FetchInput, init?: RequestInit): Request =>
  input instanceof Request ? input : new Request(input instanceof URL ? input.toString() : input, init);
