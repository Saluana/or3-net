import { describe, expect, test } from "bun:test";

import { handleCloudflareSandboxBridgeRequest, type BridgeSandbox, type CloudflareSandboxBridge } from "../examples/cloudflare-sandbox-bridge/handler.ts";
import { CloudflareSandboxRequestError } from "../sdk/cloudflare-sandbox/types.ts";

describe("cloudflare sandbox bridge handler", () => {
  test("routes lifecycle, exec, file, process, and port requests", async () => {
    const bridge = new FakeBridge();

    const createResponse = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes", { workspace_id: "ws_test", sandbox_id: "cf_sbx_1" }),
    );
    expect(createResponse.status).toBe(201);

    const execResponse = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes/cf_sbx_1/exec", { command: "pwd", cwd: "/workspace" }),
    );
    expect(await execResponse.json()).toEqual({
      ok: true,
      result: { exit_code: 0, stdout: "pwd", stderr: "", meta: { provider: "cloudflare-sandbox" } },
    });

    await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("PUT", "https://bridge.test/sandboxes/cf_sbx_1/files", { entries: [{ path: "/workspace/README.md", data: "hello" }] }),
    );
    const readResponse = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes/cf_sbx_1/files/read", { path: "/workspace/README.md" }),
    );
    expect(await readResponse.json()).toEqual({ ok: true, result: "hello" });

    const processResponse = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes/cf_sbx_1/processes", { command: "node server.js", process_id: "proc_1" }),
    );
    expect(await processResponse.json()).toEqual({
      ok: true,
      result: { process_id: "proc_1", command: "node server.js", status: "running" },
    });

    const exposeResponse = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes/cf_sbx_1/ports/3000/expose", { name: "web" }),
    );
    expect(await exposeResponse.json()).toEqual({
      ok: true,
      result: { port: 3000, url: "https://preview.example.test", name: "web" },
    });
  });

  test("returns provider-shaped errors and enforces auth", async () => {
    const bridge = new FakeBridge();
    bridge.requireBadToken = true;

    const unauthorized = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("GET", "https://bridge.test/health"),
    );
    expect(unauthorized.status).toBe(401);

    bridge.requireBadToken = false;
    bridge.failPreviewExposure = true;
    await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes", { workspace_id: "ws_test", sandbox_id: "cf_sbx_1" }),
    );
    const previewFailure = await handleCloudflareSandboxBridgeRequest(
      bridge,
      jsonRequest("POST", "https://bridge.test/sandboxes/cf_sbx_1/ports/3000/expose", { name: "web" }),
    );
    expect(previewFailure.status).toBe(400);
    expect(await previewFailure.json()).toEqual({
      ok: false,
      error: ".workers.dev does not support wildcard preview domains",
      status: 400,
      code: "custom_domain_required",
    });
  });
});

class FakeBridge implements CloudflareSandboxBridge {
  public readonly sandboxes = new Map<string, FakeSandbox>();
  public requireBadToken = false;
  public failPreviewExposure = false;

  public createSandbox(input: { sandbox_id: string; workspace_id: string }): Promise<BridgeSandbox> {
    const sandbox = new FakeSandbox(input.sandbox_id, this);
    this.sandboxes.set(input.sandbox_id, sandbox);
    return Promise.resolve(sandbox);
  }

  public getSandbox(id: string): Promise<BridgeSandbox | null> {
    return Promise.resolve(this.sandboxes.get(id) ?? null);
  }

  public health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }> {
    return Promise.resolve({ status: "healthy", preview_enabled: !this.failPreviewExposure });
  }

  public authenticate(request: Request): Promise<void> {
    void request;
    if (this.requireBadToken) {
      return Promise.reject(new CloudflareSandboxRequestError("unauthorized", 401, { code: "unauthorized" }));
    }
    return Promise.resolve();
  }
}

class FakeSandbox implements BridgeSandbox {
  private readonly files = new Map<string, string>();
  private readonly processes = new Map<string, { command: string; status: string }>();

  public constructor(public readonly id: string, private readonly bridge: FakeBridge) {}

  public exec(command: string): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    return Promise.resolve({ exit_code: 0, stdout: command, stderr: "", meta: { provider: "cloudflare-sandbox" } });
  }

  public writeFile(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    return Promise.resolve(this.files.get(path) ?? "");
  }

  public mkdir(path: string): Promise<void> {
    void path;
    return Promise.resolve();
  }

  public startProcess(command: string, options?: { process_id?: string }): Promise<{ process_id: string; command: string; status: string }> {
    const processId = options?.process_id ?? "proc_1";
    this.processes.set(processId, { command, status: "running" });
    return Promise.resolve({ process_id: processId, command, status: "running" });
  }

  public getProcess(processId: string): Promise<{ process_id: string; command: string; status: string } | null> {
    const process = this.processes.get(processId);
    return Promise.resolve(process === undefined ? null : { process_id: processId, ...process });
  }

  public getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }> {
    return Promise.resolve({ stdout: `logs:${processId}`, stderr: "", process_id: processId });
  }

  public killProcess(processId: string): Promise<void> {
    this.processes.delete(processId);
    return Promise.resolve();
  }

  public waitForPort(processId: string, port: number): Promise<void> {
    void processId;
    void port;
    return Promise.resolve();
  }

  public exposePort(port: number, options?: { name?: string }): Promise<{ port: number; url: string; name?: string }> {
    if (this.bridge.failPreviewExposure) {
      return Promise.reject(
        new CloudflareSandboxRequestError(".workers.dev does not support wildcard preview domains", 400, {
          code: "custom_domain_required",
        }),
      );
    }
    return Promise.resolve({ port, url: "https://preview.example.test", ...(options?.name === undefined ? {} : { name: options.name }) });
  }

  public listExposedPorts(): Promise<{ port: number; url: string; name?: string }[]> {
    return Promise.resolve([{ port: 3000, url: "https://preview.example.test", name: "web" }]);
  }

  public unexposePort(port: number): Promise<void> {
    void port;
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    return Promise.resolve();
  }

  public delete(): Promise<void> {
    return Promise.resolve();
  }

  public info(): Promise<{ id: string; status: string; preview_enabled: boolean }> {
    return Promise.resolve({ id: this.id, status: "running", preview_enabled: !this.bridge.failPreviewExposure });
  }
}

const jsonRequest = (method: string, url: string, body?: unknown): Request =>
  new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
