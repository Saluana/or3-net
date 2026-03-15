import { describe, expect, test } from "bun:test";

import { RuntimeError, SandboxRuntimeAdapter } from "../../../src/index.ts";
import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  CreateTunnelSignedUrlRequest,
  RuntimeCapacity,
  RuntimeHealth,
  RuntimeInfo,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileContent,
  SandboxInfo,
  SandboxQuota,
  SandboxRequestContext,
  SandboxTunnel,
  SandboxTunnelSignedUrl,
  SandboxWriteFileRequest,
} from "../../../sdk/sandbox/types.ts";
import { SandboxRequestError } from "../../../sdk/sandbox/types.ts";

class FakeSandboxClient implements SandboxClient {
  public readonly writes: { sandboxId: string; request: SandboxWriteFileRequest }[] = [];
  public healthError: Error | null = null;
  public execEventsFactory: ((request: SandboxExecRequest) => SandboxExecEvent[]) | null = null;

  public create(request: CreateSandboxRequest, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    void requestContext;
    return Promise.resolve({
      id: "sbx_1",
      status: request.start === true ? "running" : "created",
      ...(request.workspace_id === undefined ? {} : { workspace_id: request.workspace_id }),
    });
  }
  public list(): Promise<SandboxInfo[]> {
    return Promise.resolve([{ id: "sbx_1", status: "running", workspace_id: "ws_test" }]);
  }
  public get(sandboxId: string): Promise<SandboxInfo> {
    return Promise.resolve({ id: sandboxId, status: "running", workspace_id: "ws_test" });
  }
  public delete(sandboxId: string): Promise<void> {
    void sandboxId;
    return Promise.resolve();
  }
  public start(sandboxId: string): Promise<SandboxInfo> {
    return Promise.resolve({ id: sandboxId, status: "running", workspace_id: "ws_test" });
  }
  public stop(sandboxId: string): Promise<SandboxInfo> {
    return Promise.resolve({ id: sandboxId, status: "stopped", workspace_id: "ws_test" });
  }
  public suspend(sandboxId: string): Promise<SandboxInfo> {
    return Promise.resolve({ id: sandboxId, status: "stopped", workspace_id: "ws_test" });
  }
  public resume(sandboxId: string): Promise<SandboxInfo> {
    return Promise.resolve({ id: sandboxId, status: "running", workspace_id: "ws_test" });
  }
  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    void sandboxId;
    await Promise.resolve();
    const events = this.execEventsFactory?.(request) ?? [
      { event: "stdout", data: { chunk: request.command.join(" ") } },
      { event: "result", data: { exit_code: 0, stdout: request.command.join(" "), stderr: "" } },
    ];
    for (const event of events) {
      yield event;
    }
  }
  public exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    void sandboxId;
    return Promise.resolve({ exit_code: 0, stdout: request.command.join(" "), stderr: "" });
  }
  public readFile(sandboxId: string, path: string): Promise<SandboxFileContent> {
    void sandboxId;
    return Promise.resolve({ path, content: "hello" });
  }
  public writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void> {
    this.writes.push({ sandboxId, request });
    return Promise.resolve();
  }
  public deleteFile(sandboxId: string, path: string): Promise<void> {
    void sandboxId;
    void path;
    return Promise.resolve();
  }
  public mkdir(sandboxId: string, path: string): Promise<void> {
    void sandboxId;
    void path;
    return Promise.resolve();
  }
  public createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    void sandboxId;
    void request;
    throw new Error("unused");
  }
  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    void sandboxId;
    return Promise.resolve([]);
  }
  public revokeTunnel(tunnelId: string): Promise<void> {
    void tunnelId;
    return Promise.resolve();
  }
  public createSignedTunnelUrl(tunnelId: string, request?: CreateTunnelSignedUrlRequest): Promise<SandboxTunnelSignedUrl> {
    void tunnelId;
    void request;
    throw new Error("unused");
  }
  public runtimeInfo(): Promise<RuntimeInfo> {
    return Promise.resolve({ cpu_cores: 2, memory_mb: 1024 });
  }
  public runtimeHealth(): Promise<RuntimeHealth> {
    if (this.healthError !== null) {
      return Promise.reject(this.healthError);
    }
    return Promise.resolve({ status: "healthy" });
  }
  public runtimeCapacity(): Promise<RuntimeCapacity> {
    return Promise.resolve({});
  }
  public getQuota(): Promise<SandboxQuota> {
    return Promise.resolve({});
  }
  public getMetrics(): Promise<string> {
    return Promise.resolve("");
  }
}

describe("sandbox runtime adapter", () => {
  test("exec produces equivalent results to direct sandbox exec stream", async () => {
    const client = new FakeSandboxClient();
    const adapter = new SandboxRuntimeAdapter({ sandboxClient: client });

    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: "sbx_1",
      request: { command: "echo", args: ["hello"], env: {}, background: false },
    });
    const result = await handle.result;

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("echo hello");
  });

  test("exec joins streamed stdout and stderr chunks without losing the final result payload", async () => {
    const client = new FakeSandboxClient();
    client.execEventsFactory = () => [
      { event: "stdout", data: { chunk: "echo " } },
      { event: "stdout", data: { chunk: "hello" } },
      { event: "stderr", data: { chunk: "warn" } },
      { event: "result", data: { exit_code: 0, stdout: "echo hello", stderr: "warn" } },
    ];
    const adapter = new SandboxRuntimeAdapter({ sandboxClient: client });

    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: "sbx_1",
      request: { command: "echo", args: ["hello"], env: {}, background: false },
    });
    const result = await handle.result;

    expect(result.stdout).toBe("echo hello");
    expect(result.stderr).toBe("warn");
  });

  test("file operations produce equivalent results to direct sandbox client calls", async () => {
    const client = new FakeSandboxClient();
    const adapter = new SandboxRuntimeAdapter({ sandboxClient: client });

    const copiedIn = await adapter.copyIn({
      workspace_id: "ws_test",
      session_ref: "sbx_1",
      destination_path: "/tmp/test.txt",
      content_text: "hi",
      overwrite: true,
    });
    const copiedOut = await adapter.copyOut({
      workspace_id: "ws_test",
      session_ref: "sbx_1",
      source_path: "/tmp/test.txt",
      encoding: "text",
    });

    expect(copiedIn.bytes_transferred).toBe(2);
    expect(client.writes[0]?.request.path).toBe("/tmp/test.txt");
    expect(copiedOut.content_text).toBe("hello");
  });

  test("health produces equivalent results to direct sandbox runtime health", async () => {
    const client = new FakeSandboxClient();
    const adapter = new SandboxRuntimeAdapter({ sandboxClient: client });

    const health = await adapter.health();
    expect(health.status).toBe("healthy");
  });

  test("error mapping from SandboxRequestError to RuntimeError", async () => {
    const client = new FakeSandboxClient();
    client.healthError = new SandboxRequestError("sandbox unavailable", 503, { error: "boom" });
    const adapter = new SandboxRuntimeAdapter({ sandboxClient: client });

    await expectRuntimeError(adapter.health(), "adapter_unavailable");
  });
});

const expectRuntimeError = async (promise: Promise<unknown>, code: RuntimeError["code"]): Promise<void> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  throw new Error("expected RuntimeError");
};
