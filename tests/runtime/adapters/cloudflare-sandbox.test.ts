import { describe, expect, test } from "bun:test";

import { CloudflareSandboxRuntimeAdapter, RuntimeError } from "../../../src/index.ts";
import { runtimeSessionCreateInputSchema } from "../../../src/contracts/runtime/index.ts";
import type {
  CloudflareSandboxClient,
  CloudflareSandboxClientConfig,
  CloudflareSandboxConnection,
  CloudflareSandboxCreateRequest,
  CloudflareSandboxInfo,
  CloudflareSandboxProcessInfo,
  CloudflareSandboxProcessStartResult,
} from "../../../sdk/cloudflare-sandbox/types.ts";
import { CloudflareSandboxRequestError } from "../../../sdk/cloudflare-sandbox/types.ts";

class FakeConnection implements CloudflareSandboxConnection {
  public readonly writes: { path: string; data: string }[] = [];
  public readonly directories: string[] = [];
  public readonly commands: string[] = [];
  public nextExitCode = 0;

  public constructor(public readonly instance_id: string, private readonly files: Map<string, string>) {}

  public exec(command: string): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    this.commands.push(command);
    return Promise.resolve({ exit_code: this.nextExitCode, stdout: command, stderr: "", meta: { provider: "cloudflare-sandbox" } });
  }

  public writeFiles(entries: { readonly path: string; readonly data: string }[]): Promise<void> {
    for (const entry of entries) {
      this.writes.push({ path: entry.path, data: entry.data });
      this.files.set(entry.path, entry.data);
    }
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    return Promise.resolve(this.files.get(path) ?? "");
  }

  public createDirectories(paths: { readonly path: string }[]): Promise<void> {
    this.directories.push(...paths.map((path) => path.path));
    return Promise.resolve();
  }

  public startProcess(): Promise<CloudflareSandboxProcessStartResult> {
    return Promise.reject(new Error("not implemented"));
  }

  public getProcess(processId: string): Promise<CloudflareSandboxProcessInfo | null> {
    void processId;
    return Promise.resolve(null);
  }

  public getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }> {
    void processId;
    return Promise.resolve({ stdout: "", stderr: "", process_id: "proc_1" });
  }

  public killProcess(processId: string): Promise<void> {
    void processId;
    return Promise.resolve();
  }

  public waitForPort(processId: string, port: number): Promise<void> {
    void processId;
    void port;
    return Promise.resolve();
  }

  public exposePort(): Promise<{ port: number; url: string; name?: string }> {
    return Promise.reject(new Error("not implemented"));
  }

  public listExposedPorts(): Promise<{ port: number; url: string; name?: string }[]> {
    return Promise.resolve([]);
  }

  public unexposePort(port: number): Promise<void> {
    void port;
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<CloudflareSandboxConnection> {
    return Promise.resolve(this);
  }

  public kill(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeClient implements CloudflareSandboxClient {
  public readonly config: CloudflareSandboxClientConfig = {
    baseUrl: "https://bridge.test",
    token: "token",
  };

  public readonly connections = new Map<string, FakeConnection>();
  public readonly instances = new Map<string, CloudflareSandboxInfo>();
  public listError: Error | null = null;

  public create(input: CloudflareSandboxCreateRequest): Promise<CloudflareSandboxConnection> {
    const connection = new FakeConnection(input.sandbox_id, new Map());
    this.connections.set(input.sandbox_id, connection);
    this.instances.set(input.sandbox_id, {
      id: input.sandbox_id,
      status: "running",
      preview_enabled: true,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    return Promise.resolve(connection);
  }

  public connect(instanceId: string): Promise<CloudflareSandboxConnection> {
    const connection = this.connections.get(instanceId);
    if (connection === undefined) {
      return Promise.reject(new CloudflareSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(connection);
  }

  public get(instanceId: string): Promise<CloudflareSandboxInfo> {
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      return Promise.reject(new CloudflareSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(instance);
  }

  public health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }> {
    if (this.listError !== null) {
      return Promise.reject(this.listError);
    }
    return Promise.resolve({ status: "healthy", preview_enabled: true });
  }

  public pause(instanceId: string): Promise<void> {
    const current = this.instances.get(instanceId);
    if (current !== undefined) {
      this.instances.set(instanceId, { ...current, status: "paused" });
    }
    return Promise.resolve();
  }

  public resume(instanceId: string): Promise<CloudflareSandboxConnection> {
    const current = this.instances.get(instanceId);
    if (current !== undefined) {
      this.instances.set(instanceId, { ...current, status: "running" });
    }
    return this.connect(instanceId);
  }

  public kill(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    this.connections.delete(instanceId);
    return Promise.resolve();
  }
}

describe("cloudflare sandbox runtime adapter", () => {
  test("createSession and exec round-trip through the Cloudflare client", async () => {
    const client = new FakeClient();
    const adapter = new CloudflareSandboxRuntimeAdapter({ client });

    const session = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_1",
      config: createSessionConfig(["exec"]),
    });
    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: session.ref,
      request: { command: "echo", args: ["hello world", "a;echo pwned"], env: {}, background: false },
    });
    const result = await handle.result;

    expect(session.adapter_id).toBe("cloudflare-sandbox");
    expect(result.stdout).toBe("echo 'hello world' 'a;echo pwned'");
    expect(result.meta).toEqual({ provider: "cloudflare-sandbox" });
  });

  test("copyIn and copyOut use file APIs", async () => {
    const client = new FakeClient();
    const adapter = new CloudflareSandboxRuntimeAdapter({ client });
    const session = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_2",
      config: createSessionConfig(),
    });
    const connection = client.connections.get(session.ref);
    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error("expected connection");
    }

    await adapter.copyIn({
      workspace_id: "ws_test",
      session_ref: session.ref,
      destination_path: "/workspace/app/main.ts",
      content_text: "console.log('hi')",
      overwrite: true,
    });
    const copiedOut = await adapter.copyOut({
      workspace_id: "ws_test",
      session_ref: session.ref,
      source_path: "/workspace/app/main.ts",
      encoding: "text",
    });

    expect(connection.directories).toContain("/workspace/app");
    expect(copiedOut.content_text).toBe("console.log('hi')");
    expect(adapter.getWorkspaceStageTransportCapabilities()).toEqual({ archive: false, file_api: true });
  });

  test("getSession returns null for missing instances and stop maps provider errors", async () => {
    const client = new FakeClient();
    const adapter = new CloudflareSandboxRuntimeAdapter({ client });

    expect(await adapter.getSession({ workspace_id: "ws_test", session_ref: "missing" })).toBeNull();

    const created = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_3",
      config: createSessionConfig(),
    });
    client.connections.delete(created.ref);
    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: created.ref,
      request: { command: "pwd", args: [], env: {}, background: false },
    });
    expect(handle.result).rejects.toBeInstanceOf(RuntimeError);
  });
});

const createSessionConfig = (
  capabilities: string[] = ["exec"],
  timeout_rules: { soft_ms?: number; hard_ms?: number } = { soft_ms: 60_000 },
): ReturnType<typeof runtimeSessionCreateInputSchema.parse> =>
  runtimeSessionCreateInputSchema.parse({
    requested_capabilities: capabilities,
    timeout_rules,
    metadata: {},
  });
