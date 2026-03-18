import { describe, expect, test } from "bun:test";

import { CloudflareSandboxNodeAdapter } from "../src/index.ts";
import type { StoredNode } from "../src/db/index.ts";
import type { TaskPackage } from "../src/contracts/index.ts";
import type {
  CloudflareSandboxClient,
  CloudflareSandboxClientConfig,
  CloudflareSandboxConnection,
  CloudflareSandboxCreateRequest,
  CloudflareSandboxInfo,
  CloudflareSandboxProcessInfo,
  CloudflareSandboxProcessStartResult,
} from "../sdk/cloudflare-sandbox/types.ts";

class FakeConnection implements CloudflareSandboxConnection {
  public readonly writes: { path: string; data: string }[] = [];
  public readonly directories: string[] = [];
  public readonly execs: string[] = [];
  public readonly startedProcesses: { command: string; processId: string }[] = [];
  public readonly killedProcesses: string[] = [];
  public readonly exposedPorts: number[] = [];
  public readonly unexposedPorts: number[] = [];

  public constructor(public readonly instance_id: string) {}

  public exec(command: string): Promise<{ exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    this.execs.push(command);
    return Promise.resolve({ exit_code: 0, stdout: "ok", stderr: "", meta: {} });
  }

  public writeFiles(entries: { readonly path: string; readonly data: string }[]): Promise<void> {
    this.writes.push(...entries.map((entry) => ({ path: entry.path, data: entry.data })));
    return Promise.resolve();
  }

  public readFile(path: string): Promise<string> {
    void path;
    return Promise.resolve("");
  }

  public createDirectories(paths: { readonly path: string }[]): Promise<void> {
    this.directories.push(...paths.map((entry) => entry.path));
    return Promise.resolve();
  }

  public startProcess(command: string, options?: { process_id?: string }): Promise<CloudflareSandboxProcessStartResult> {
    const processId = options?.process_id ?? "proc_1";
    this.startedProcesses.push({ command, processId });
    return Promise.resolve({ process_id: processId, command, status: "running" });
  }

  public getProcess(processId: string): Promise<CloudflareSandboxProcessInfo | null> {
    return Promise.resolve({ process_id: processId, command: "node server.js", status: "running" });
  }

  public getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }> {
    return Promise.resolve({ stdout: `logs:${processId}`, stderr: "", process_id: processId });
  }

  public killProcess(processId: string): Promise<void> {
    this.killedProcesses.push(processId);
    return Promise.resolve();
  }

  public waitForPort(processId: string, port: number): Promise<void> {
    void processId;
    void port;
    return Promise.resolve();
  }

  public exposePort(port: number, options?: { name?: string }): Promise<{ port: number; url: string; name?: string }> {
    this.exposedPorts.push(port);
    return Promise.resolve({ port, url: `https://preview.test/${String(port)}`, ...(options?.name === undefined ? {} : { name: options.name }) });
  }

  public listExposedPorts(): Promise<{ port: number; url: string; name?: string }[]> {
    return Promise.resolve(this.exposedPorts.map((port) => ({ port, url: `https://preview.test/${String(port)}` })));
  }

  public unexposePort(port: number): Promise<void> {
    this.unexposedPorts.push(port);
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

  public create(input: CloudflareSandboxCreateRequest): Promise<CloudflareSandboxConnection> {
    const connection = new FakeConnection(input.sandbox_id);
    this.connections.set(input.sandbox_id, connection);
    this.instances.set(input.sandbox_id, { id: input.sandbox_id, status: "running", preview_enabled: true });
    return Promise.resolve(connection);
  }

  public connect(instanceId: string): Promise<CloudflareSandboxConnection> {
    const connection = this.connections.get(instanceId);
    if (connection === undefined) {
      return Promise.reject(new Error(`missing ${instanceId}`));
    }
    return Promise.resolve(connection);
  }

  public get(instanceId: string): Promise<CloudflareSandboxInfo> {
    const instance = this.instances.get(instanceId);
    if (instance === undefined) {
      return Promise.reject(new Error(`missing ${instanceId}`));
    }
    return Promise.resolve(instance);
  }

  public health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }> {
    return Promise.resolve({ status: "healthy", preview_enabled: true });
  }

  public pause(instanceId: string): Promise<void> {
    void instanceId;
    return Promise.resolve();
  }

  public resume(instanceId: string): Promise<CloudflareSandboxConnection> {
    return this.connect(instanceId);
  }

  public kill(instanceId: string): Promise<void> {
    this.connections.delete(instanceId);
    this.instances.delete(instanceId);
    return Promise.resolve();
  }
}

describe("cloudflare sandbox node adapter", () => {
  test("stages task artifacts under /workspace and executes the task", async () => {
    const client = new FakeClient();
    const adapter = new CloudflareSandboxNodeAdapter(client);

    const result = await adapter.executeTaskWithProgress("ws_test", createTaskPackage(), () => undefined);
    const connection = client.connections.get(result.instance_id);
    expect(connection).toBeDefined();
    if (connection === undefined) {
      throw new Error("expected connection");
    }

    expect(connection.directories.includes("/workspace/src")).toBe(true);
    expect(connection.writes).toContainEqual({ path: "/workspace/README.md", data: "# demo" });
    expect(connection.writes).toContainEqual({ path: "/workspace/src/index.ts", data: "console.log('hi')" });
    expect(connection.execs).toEqual(["echo 'hello from cloudflare'"]);
  });

  test("launches, reuses, and revokes services through exposed ports", async () => {
    const client = new FakeClient();
    const adapter = new CloudflareSandboxNodeAdapter(client);
    const node = createStoredNode({ node_id: "node_cf_service", capabilities: ["service:web:3000"] });

    const firstLaunch = await adapter.prepareServiceLaunch("ws_test", node, "web");
    const secondLaunch = await adapter.prepareServiceLaunch("ws_test", node, "web");
    const revoked = await adapter.revokeServiceLaunch("ws_test", node, "web");
    const revokedAgain = await adapter.revokeServiceLaunch("ws_test", node, "web");

    const [connection] = Array.from(client.connections.values());
    expect(firstLaunch.target_url).toBe("https://preview.test/3000");
    expect(secondLaunch.reused_tunnel).toBe(true);
    expect(connection?.startedProcesses).toHaveLength(1);
    expect(connection?.exposedPorts).toEqual([3000, 3000]);
    expect(connection?.unexposedPorts).toEqual([3000]);
    expect(connection?.killedProcesses).toEqual(["svc-web"]);
    expect(revoked).toBe(1);
    expect(revokedAgain).toBe(0);
  });
});

const createTaskPackage = (): TaskPackage => ({
  workspace_id: "ws_test",
  job_id: "job_cf_1",
  kind: "chat.turn",
  instructions: "echo 'hello from cloudflare'",
  artifacts: [
    {
      artifact_id: "artifact_readme",
      path: "README.md",
      kind: "text",
      content_type: "text/markdown",
      size_bytes: 6,
      text: "# demo",
    },
    {
      artifact_id: "artifact_src",
      path: "src/index.ts",
      kind: "text",
      content_type: "application/typescript",
      size_bytes: 17,
      text: "console.log('hi')",
    },
  ],
  tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
  timeout: { soft_ms: 30_000, hard_ms: 60_000 },
  lease_profile: { profile_id: "default", ttl_seconds: 300, required_capabilities: [] },
  subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
  metadata: {},
});

const createStoredNode = (input: { node_id: string; capabilities: string[] }): StoredNode => ({
  workspace_id: "ws_test",
  manifest: {
    node_id: input.node_id,
    pubkey: "pub",
    signature: "sig",
    adapter_kind: "sandbox",
    capabilities: input.capabilities,
    isolation_class: "sandbox",
    supports_transports: ["outbound-wss"],
    resource_limits: { max_concurrent_jobs: 1, cpu_cores: 2, memory_mb: 2048, disk_mb: 2048 },
    lease_policy: { max_ttl_seconds: 300, supports_warm_pool: false, reset_methods: ["process_kill"] },
    version: "1.0.0",
  },
  pubkey_fingerprint: "fingerprint",
  status: "approved",
  health_status: "healthy",
  approved_at: "2024-01-01T00:00:00.000Z",
  revoked_at: null,
  last_seen_at: "2024-01-01T00:00:00.000Z",
  last_error: null,
  created_at: "2024-01-01T00:00:00.000Z",
});
