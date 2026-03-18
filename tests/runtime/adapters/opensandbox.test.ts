import { describe, expect, test } from "bun:test";

import { RuntimeCapabilitySet, RuntimeError, OpenSandboxRuntimeAdapter } from "../../../src/index.ts";
import { runtimeSessionCreateInputSchema } from "../../../src/contracts/runtime/index.ts";
import type {
  OpenSandboxClient,
  OpenSandboxClientConfig,
  OpenSandboxCommandOptions,
  OpenSandboxConnection,
  OpenSandboxCreateRequest,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstanceInfo,
  OpenSandboxListRequest,
} from "../../../sdk/opensandbox/types.ts";
import { OpenSandboxRequestError } from "../../../sdk/opensandbox/types.ts";

class FakeConnection implements OpenSandboxConnection {
  public readonly writes: { path: string; data: string }[] = [];
  public readonly directories: string[] = [];
  public readonly endpoints: number[] = [];
  public readonly commands: string[] = [];
  public nextExitCode = 0;

  public constructor(
    public readonly instance_id: string,
    private readonly files: Map<string, string>,
  ) {}

  public async runCommand(
    command: string,
    options: OpenSandboxCommandOptions = {},
    handlers: OpenSandboxExecutionHandlers = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    void options;
    this.commands.push(command);
    await handlers.onStdout?.({ text: command });
    await handlers.onResult?.({ status: this.nextExitCode === 0 ? "completed" : "failed", exit_code: this.nextExitCode });
    return {
      exit_code: this.nextExitCode,
      stdout: command,
      stderr: "",
      meta: { provider: "opensandbox" },
    };
  }

  public writeFiles(entries: { path: string; data: string }[]): Promise<void> {
    for (const entry of entries) {
      this.writes.push(entry);
      this.files.set(entry.path, entry.data);
    }
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    return Promise.resolve(this.files.get(path) ?? "");
  }

  public createDirectories(paths: { path: string }[]): Promise<void> {
    this.directories.push(...paths.map((entry) => entry.path));
    return Promise.resolve();
  }

  public getEndpoint(port: number): Promise<{ endpoint: string; url?: string }> {
    this.endpoints.push(port);
    return Promise.resolve({
      endpoint: `launch.local/${this.instance_id}/${String(port)}`,
      url: `https://launch.local/${this.instance_id}/${String(port)}`,
    });
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<OpenSandboxConnection> {
    return Promise.resolve(this);
  }

  public renew(timeoutSeconds: number): Promise<void> {
    void timeoutSeconds;
    return Promise.resolve();
  }

  public kill(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeOpenSandboxClient implements OpenSandboxClient {
  public readonly config: OpenSandboxClientConfig = {
    apiKey: "test-key",
    domain: "sandbox.test",
    defaultTimeoutSeconds: 600,
  };

  public readonly connections = new Map<string, FakeConnection>();
  public readonly instances = new Map<string, OpenSandboxInstanceInfo>();
  public readonly killed: string[] = [];
  public readonly paused: string[] = [];
  public listError: Error | null = null;
  public getError: Error | null = null;

  public create(input: OpenSandboxCreateRequest): Promise<OpenSandboxConnection> {
    const instanceId = `osbx_${String(this.instances.size + 1)}`;
    const connection = new FakeConnection(instanceId, new Map());
    this.connections.set(instanceId, connection);
    this.instances.set(instanceId, {
      id: instanceId,
      status: "running",
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    return Promise.resolve(connection);
  }

  public connect(instanceId: string): Promise<OpenSandboxConnection> {
    const connection = this.connections.get(instanceId);
    if (connection === undefined) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(connection);
  }

  public list(input?: OpenSandboxListRequest): Promise<OpenSandboxInstanceInfo[]> {
    void input;
    if (this.listError !== null) {
      return Promise.reject(this.listError);
    }
    return Promise.resolve([...this.instances.values()]);
  }

  public get(instanceId: string): Promise<OpenSandboxInstanceInfo> {
    if (this.getError !== null) {
      return Promise.reject(this.getError);
    }
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    return Promise.resolve(instance);
  }

  public pause(instanceId: string): Promise<void> {
    this.paused.push(instanceId);
    const current = this.instances.get(instanceId);
    if (current !== undefined) {
      this.instances.set(instanceId, { ...current, status: "paused" });
    }
    return Promise.resolve();
  }

  public resume(instanceId: string): Promise<OpenSandboxConnection> {
    const current = this.instances.get(instanceId);
    if (current !== undefined) {
      this.instances.set(instanceId, { ...current, status: "running" });
    }
    return this.connect(instanceId);
  }

  public renew(instanceId: string, timeoutSeconds: number): Promise<void> {
    void instanceId;
    void timeoutSeconds;
    return Promise.resolve();
  }

  public kill(instanceId: string): Promise<void> {
    if (!this.instances.has(instanceId)) {
      return Promise.reject(new OpenSandboxRequestError("missing", 404, { code: "not_found" }));
    }
    this.killed.push(instanceId);
    this.instances.delete(instanceId);
    this.connections.delete(instanceId);
    return Promise.resolve();
  }
}

describe("opensandbox runtime adapter", () => {
  test("createSession and exec round-trip through the OpenSandbox client", async () => {
    const client = new FakeOpenSandboxClient();
    const adapter = new OpenSandboxRuntimeAdapter({ client });

    const session = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_1",
      config: createSessionConfig(["exec"], { soft_ms: 45_000 }),
    });
    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: session.ref,
      request: { command: "echo", args: ["hello"], env: {}, background: false },
    });
    const result = await handle.result;

    expect(session.adapter_id).toBe("opensandbox");
    expect(result.stdout).toBe("echo hello");
    expect(result.meta).toEqual({ provider: "opensandbox" });
  });

  test("exec shell-quotes args so argv semantics survive spaces and shell metacharacters", async () => {
    const client = new FakeOpenSandboxClient();
    const adapter = new OpenSandboxRuntimeAdapter({ client });
    const session = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_quote",
      config: createSessionConfig(["exec"]),
    });
    const connection = client.connections.get(session.ref);
    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error("expected connection");
    }

    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: session.ref,
      request: { command: "echo", args: ["hello world", "a;echo pwned"], env: {}, background: false },
    });
    await handle.result;

    expect(connection.commands.at(-1)).toBe("echo 'hello world' 'a;echo pwned'");
  });

  test("copyIn and copyOut use file-based staging", async () => {
    const client = new FakeOpenSandboxClient();
    const adapter = new OpenSandboxRuntimeAdapter({ client });
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

    const copiedIn = await adapter.copyIn({
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
    expect(copiedIn.bytes_transferred).toBeGreaterThan(0);
    expect(copiedOut.content_text).toBe("console.log('hi')");
    expect(adapter.getWorkspaceStageTransportCapabilities()).toEqual({ archive: false, file_api: true });
  });

  test("health returns unavailable when the provider list call fails", async () => {
    const client = new FakeOpenSandboxClient();
    client.listError = new OpenSandboxRequestError("unavailable", 503, { code: "unavailable" });
    const adapter = new OpenSandboxRuntimeAdapter({ client });

    const health = await adapter.health();
    expect(health).toMatchObject({ status: "unavailable" });
  });

  test("getSession returns null and destroySession is idempotent for missing instances", async () => {
    const client = new FakeOpenSandboxClient();
    client.getError = new OpenSandboxRequestError("missing", 404, { code: "not_found" });
    const adapter = new OpenSandboxRuntimeAdapter({ client });

    const session = await adapter.getSession({ workspace_id: "ws_test", session_ref: "missing" });
    expect(session).toBeNull();
    const destroyed = await adapter.destroySession({ workspace_id: "ws_test", session_ref: "missing" });
    expect(destroyed).toEqual({
      destroyed: true,
      message: "session already absent",
    });
  });

  test("stop pauses the provider session and surfaces provider errors as RuntimeError", async () => {
    const client = new FakeOpenSandboxClient();
    const adapter = new OpenSandboxRuntimeAdapter({ client });
    const session = await adapter.createSession({
      workspace_id: "ws_test",
      session_id: "sess_3",
      config: createSessionConfig(),
    });

    const stopped = await adapter.stop({ workspace_id: "ws_test", session_ref: session.ref });
    expect(stopped).toEqual({
      stopped: true,
      status: "stopped",
    });
    expect(client.paused).toEqual([session.ref]);

    client.connections.delete(session.ref);
    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: session.ref,
      request: { command: "pwd", args: [], env: {}, background: false },
    });
    try {
      await handle.result;
      throw new Error("expected RuntimeError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeError);
    }
  });

  test("copyOut maps provider failures to RuntimeError", async () => {
    const client = new FakeOpenSandboxClient();
    const adapter = new OpenSandboxRuntimeAdapter({ client });

    try {
      await adapter.copyOut({
        workspace_id: "ws_test",
        session_ref: "missing",
        source_path: "/missing.txt",
        encoding: "text",
      });
      throw new Error("expected RuntimeError");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeError);
    }
  });
});

const createSessionConfig = (
  requiredCapabilities: string[] = [],
  timeoutRules: { soft_ms?: number } = {},
): ReturnType<typeof runtimeSessionCreateInputSchema.parse> => runtimeSessionCreateInputSchema.parse({
  required_capabilities: RuntimeCapabilitySet.fromValues(requiredCapabilities),
  ...(Object.keys(timeoutRules).length === 0 ? {} : { timeout_rules: timeoutRules }),
});
