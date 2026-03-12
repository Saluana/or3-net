import type { SandboxClient, SandboxInfo } from "../../sdk/sandbox/index.ts";

interface WarmPoolOptions {
  readonly maxPoolSizePerWorkspace?: number;
  readonly allowTunnels?: boolean;
  readonly healthTimeoutMs?: number;
  readonly healthPollIntervalMs?: number;
}

export class WarmPoolManager {
  private readonly readySandboxes = new Map<string, SandboxInfo[]>();
  private readonly quarantinedSandboxes = new Set<string>();
  private readonly maxPoolSizePerWorkspace: number;
  private readonly allowTunnels: boolean;
  private readonly healthTimeoutMs: number;
  private readonly healthPollIntervalMs: number;

  public constructor(
    private readonly sandboxClient: SandboxClient,
    options: WarmPoolOptions = {},
  ) {
    this.maxPoolSizePerWorkspace = options.maxPoolSizePerWorkspace ?? 2;
    this.allowTunnels = options.allowTunnels ?? false;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 15_000;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? 100;
  }

  public async acquire(workspaceId: string): Promise<SandboxInfo> {
    const pool = this.readySandboxes.get(workspaceId);
    if (pool !== undefined && pool.length > 0) {
      const sandbox = pool.shift();
      if (sandbox !== undefined) {
        if (await this.isHealthy(sandbox)) {
          return sandbox;
        }
        await this.quarantine(sandbox);
      }
    }
    return this.createHealthySandbox(workspaceId);
  }

  public async release(workspaceId: string, sandbox: SandboxInfo): Promise<void> {
    const replacement = await this.resetForReuse(sandbox, workspaceId);
    if (replacement === null) {
      await this.quarantine(sandbox);
      return;
    }

    const pool = this.readySandboxes.get(workspaceId) ?? [];
    if (pool.length >= this.maxPoolSizePerWorkspace) {
      await this.sandboxClient.delete(replacement.id);
      return;
    }

    pool.push(replacement);
    this.readySandboxes.set(workspaceId, pool);
  }

  public async retainForNode(workspaceId: string, sandbox: SandboxInfo): Promise<SandboxInfo> {
    if (await this.isHealthy(sandbox)) {
      return sandbox;
    }

    await this.quarantine(sandbox);
    return this.createHealthySandbox(workspaceId);
  }

  private async resetForReuse(sandbox: SandboxInfo, workspaceId: string): Promise<SandboxInfo | null> {
    try {
      await this.sandboxClient.delete(sandbox.id);
      return await this.createHealthySandbox(workspaceId);
    } catch {
      return null;
    }
  }

  private async createHealthySandbox(workspaceId: string): Promise<SandboxInfo> {
    const created = await this.sandboxClient.create(this.buildCreateRequest(workspaceId));
    try {
      return (await this.isHealthy(created)) ? created : await this.awaitHealthy(created.id);
    } catch (error) {
      await this.quarantineById(created.id);
      throw error;
    }
  }

  private buildCreateRequest(workspaceId: string): { workspace_id: string; start: true; allow_tunnels?: true } {
    return this.allowTunnels
      ? { workspace_id: workspaceId, start: true, allow_tunnels: true }
      : { workspace_id: workspaceId, start: true };
  }

  private async isHealthy(sandbox: SandboxInfo): Promise<boolean> {
    if (this.quarantinedSandboxes.has(sandbox.id)) {
      return false;
    }

    try {
      const current = await this.sandboxClient.get(sandbox.id);
      return current.status === "running";
    } catch {
      return false;
    }
  }

  private async quarantine(sandbox: SandboxInfo): Promise<void> {
    await this.quarantineById(sandbox.id);
  }

  private async quarantineById(sandboxId: string): Promise<void> {
    this.quarantinedSandboxes.add(sandboxId);
    try {
      await this.sandboxClient.delete(sandboxId);
    } catch {
      return;
    }
  }

  private async awaitHealthy(sandboxId: string): Promise<SandboxInfo> {
    const deadline = Date.now() + this.healthTimeoutMs;
    let lastSeen: SandboxInfo | null = null;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const current = await this.sandboxClient.get(sandboxId);
        lastSeen = current;
        lastError = null;
        if (current.status === "running") {
          return current;
        }
      } catch (error) {
        lastError = error;
        break;
      }
      await Bun.sleep(this.healthPollIntervalMs);
    }
    if (lastError instanceof Error) {
      throw new Error(`sandbox ${sandboxId} did not become healthy (${lastError.message})`);
    }
    if (lastSeen !== null) {
      throw new Error(`sandbox ${sandboxId} did not become healthy (last status: ${lastSeen.status})`);
    }
    throw new Error(`sandbox ${sandboxId} did not become healthy`);
  }
}
