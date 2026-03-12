import { describe, expect, test } from "bun:test";

import { WarmPoolManager } from "../src/index.ts";
import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInfo,
  SandboxTunnel,
  SandboxWriteFileRequest,
} from "../sdk/sandbox/index.ts";

class PoolSandboxClient implements SandboxClient {
  public readonly created: string[] = [];
  public readonly deleted: string[] = [];
  public readonly createRequests: CreateSandboxRequest[] = [];
  private readonly sandboxes = new Map<string, SandboxInfo>();
  private readonly unhealthy = new Set<string>();
  private readonly deleteFailures = new Set<string>();
  private failNextCreate = false;
  private nextCreateStatus: string | null = null;
  private nextId = 1;

  public create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error("create failed"));
    }
    const workspaceId = request.workspace_id ?? "ws";
    this.createRequests.push(request);
    const sandbox = {
      id: `sbx_${String(this.nextId++)}`,
      status: this.nextCreateStatus ?? "running",
      workspace_id: workspaceId,
    };
    this.nextCreateStatus = null;
    this.created.push(sandbox.id);
    this.sandboxes.set(sandbox.id, sandbox);
    return Promise.resolve(sandbox);
  }

  public get(sandboxId: string): Promise<SandboxInfo> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      return Promise.reject(new Error(`sandbox ${sandboxId} not found`));
    }
    if (this.unhealthy.has(sandboxId)) {
      return Promise.resolve({ ...sandbox, status: "failed" });
    }
    return Promise.resolve(sandbox);
  }

  public delete(sandboxId: string): Promise<void> {
    if (this.deleteFailures.has(sandboxId)) {
      return Promise.reject(new Error("delete failed"));
    }
    this.deleted.push(sandboxId);
    this.sandboxes.delete(sandboxId);
    return Promise.resolve();
  }

  public list(): Promise<SandboxInfo[]> {
    return Promise.resolve([...this.sandboxes.values()]);
  }

  public start(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public stop(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public suspend(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public resume(sandboxId: string): Promise<SandboxInfo> {
    return this.get(sandboxId);
  }

  public exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    void sandboxId;
    void request;
    return Promise.resolve({ exit_code: 0 });
  }

  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    void sandboxId;
    void request;
    await Promise.resolve();
    yield { event: "result", data: { exit_code: 0 } };
  }

  public writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void> {
    void sandboxId;
    void request;
    return Promise.resolve();
  }

  public readFile(sandboxId: string, path: string): Promise<{ path: string; content: string; encoding?: string }> {
    void sandboxId;
    return Promise.resolve({ path, content: "" });
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
    return Promise.resolve({
      id: `tun_${sandboxId}_${String(request.target_port)}`,
      sandbox_id: sandboxId,
      target_port: request.target_port,
      endpoint: `https://launch.local/${sandboxId}/${String(request.target_port)}`,
    });
  }

  public listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    void sandboxId;
    return Promise.resolve([]);
  }

  public createSignedTunnelUrl(tunnelId: string): Promise<{ url: string; expires_at: string }> {
    return Promise.resolve({
      url: `https://launch.local/signed/${tunnelId}`,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  }

  public revokeTunnel(tunnelId: string): Promise<void> {
    void tunnelId;
    return Promise.resolve();
  }

  public runtimeInfo(): Promise<Record<string, unknown>> {
    return Promise.resolve({ runtime: "docker" });
  }

  public runtimeHealth(): Promise<{ status: string }> {
    return Promise.resolve({ status: "ok" });
  }

  public runtimeCapacity(): Promise<Record<string, unknown>> {
    return Promise.resolve({ total: 1, available: 1 });
  }

  public getQuota(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  public getMetrics(): Promise<string> {
    return Promise.resolve("");
  }

  public markUnhealthy(sandboxId: string): void {
    this.unhealthy.add(sandboxId);
  }

  public failDeleteFor(sandboxId: string): void {
    this.deleteFailures.add(sandboxId);
  }

  public failNextCreateCall(): void {
    this.failNextCreate = true;
  }

  public setNextCreateStatus(status: string): void {
    this.nextCreateStatus = status;
  }
}

describe("warm pool manager", () => {
  test("keeps warm sandboxes isolated per workspace", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient, { maxPoolSizePerWorkspace: 1 });

    const firstA = await manager.acquire("ws_a");
    await manager.release("ws_a", firstA);

    const reusedA = await manager.acquire("ws_a");
    const firstB = await manager.acquire("ws_b");

    expect(reusedA.id).toBe("sbx_2");
    expect(firstB.id).toBe("sbx_3");
    expect(sandboxClient.created).toEqual(["sbx_1", "sbx_2", "sbx_3"]);
  });

  test("replaces unhealthy retained sandboxes instead of handing them back to nodes", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient);

    const sandbox = await manager.acquire("ws_nodes");
    sandboxClient.markUnhealthy(sandbox.id);

    const retained = await manager.retainForNode("ws_nodes", sandbox);

    expect(retained.id).toBe("sbx_2");
    expect(sandboxClient.deleted).toContain("sbx_1");
  });

  test("drops extra warm replacements once the workspace pool is full", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient, { maxPoolSizePerWorkspace: 1 });

    const first = await manager.acquire("ws_pool");
    await manager.release("ws_pool", first);

    const extra = await sandboxClient.create({ workspace_id: "ws_pool" });
    await manager.release("ws_pool", extra);

    expect(sandboxClient.created).toEqual(["sbx_1", "sbx_2", "sbx_3", "sbx_4"]);
    expect(sandboxClient.deleted).toContain("sbx_4");
  });

  test("quarantines sandboxes when reset-for-reuse cannot create a healthy replacement", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient);

    const sandbox = await manager.acquire("ws_fail");
    sandboxClient.failNextCreateCall();
    await manager.release("ws_fail", sandbox);

    const next = await manager.acquire("ws_fail");
    expect(next.id).toBe("sbx_2");
    expect(sandboxClient.deleted).toContain("sbx_1");
  });

  test("replaces dropped pooled sandboxes instead of reusing them", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient, { maxPoolSizePerWorkspace: 1 });

    const sandbox = await manager.acquire("ws_drop");
    await manager.release("ws_drop", sandbox);
    sandboxClient.failDeleteFor("sbx_2");
    sandboxClient.markUnhealthy("sbx_2");

    const replacement = await manager.acquire("ws_drop");
    expect(replacement.id).toBe("sbx_3");
  });

  test("deletes sandboxes that never become healthy during startup", async () => {
    const sandboxClient = new PoolSandboxClient();
    const manager = new WarmPoolManager(sandboxClient, {
      healthTimeoutMs: 5,
      healthPollIntervalMs: 1,
    });
    sandboxClient.setNextCreateStatus("starting");

    await expect(manager.acquire("ws_timeout")).rejects.toThrow("did not become healthy");
    expect(sandboxClient.deleted).toContain("sbx_1");
  });

  test("only enables tunnels when the pool is configured for them", async () => {
    const defaultClient = new PoolSandboxClient();
    const defaultManager = new WarmPoolManager(defaultClient);
    await defaultManager.acquire("ws_default");

    const tunnelClient = new PoolSandboxClient();
    const tunnelManager = new WarmPoolManager(tunnelClient, { allowTunnels: true });
    await tunnelManager.acquire("ws_tunnel");

    expect(defaultClient.createRequests[0]).toEqual({ workspace_id: "ws_default", start: true });
    expect(tunnelClient.createRequests[0]).toEqual({ workspace_id: "ws_tunnel", start: true, allow_tunnels: true });
  });
});
