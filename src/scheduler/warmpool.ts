import type { SandboxClient, SandboxInfo } from "../../sdk/sandbox/index.ts";

interface WarmPoolOptions {
  readonly maxPoolSizePerWorkspace?: number;
}

export class WarmPoolManager {
  private readonly readySandboxes = new Map<string, SandboxInfo[]>();
  private readonly quarantinedSandboxes = new Set<string>();
  private readonly maxPoolSizePerWorkspace: number;

  public constructor(
    private readonly sandboxClient: SandboxClient,
    options: WarmPoolOptions = {},
  ) {
    this.maxPoolSizePerWorkspace = options.maxPoolSizePerWorkspace ?? 2;
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
    return this.sandboxClient.create({ workspace_id: workspaceId });
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
    return this.sandboxClient.create({ workspace_id: workspaceId });
  }

  private async resetForReuse(sandbox: SandboxInfo, workspaceId: string): Promise<SandboxInfo | null> {
    try {
      await this.sandboxClient.delete(sandbox.id);
      const replacement = await this.sandboxClient.create({ workspace_id: workspaceId });
      return (await this.isHealthy(replacement)) ? replacement : null;
    } catch {
      return null;
    }
  }

  private async isHealthy(sandbox: SandboxInfo): Promise<boolean> {
    if (this.quarantinedSandboxes.has(sandbox.id)) {
      return false;
    }

    try {
      const current = await this.sandboxClient.get(sandbox.id);
      return current.status === "ready";
    } catch {
      return false;
    }
  }

  private async quarantine(sandbox: SandboxInfo): Promise<void> {
    this.quarantinedSandboxes.add(sandbox.id);
    try {
      await this.sandboxClient.delete(sandbox.id);
    } catch {
      return;
    }
  }
}