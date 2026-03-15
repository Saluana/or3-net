/**
 * @module src/runtime/registry
 *
 * Purpose:
 * In-memory registry of available runtime adapter implementations.
 */
import {
  type RuntimeAdapter,
  type RuntimeAdapterHealth,
  type RuntimeAdapterManifest,
  runtimeAdapterManifestSchema,
} from "../contracts/runtime/index.ts";

const unavailableHealth = (): RuntimeAdapterHealth => ({
  status: "unavailable",
  checked_at: new Date().toISOString(),
});

/**
 * Purpose:
 * Stores runtime adapters by id and exposes health aggregation utilities.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  /** Purpose: Registers a runtime adapter after validating its manifest. */
  public register(adapter: RuntimeAdapter): RuntimeAdapterManifest {
    const manifest = runtimeAdapterManifestSchema.parse(adapter.manifest);
    if (this.adapters.has(manifest.adapter_id)) {
      throw new Error(`runtime adapter ${manifest.adapter_id} is already registered`);
    }

    this.adapters.set(manifest.adapter_id, adapter);
    return manifest;
  }

  /** Purpose: Returns a runtime adapter by id when registered. */
  public get(adapterId: string): RuntimeAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /** Purpose: Lists all registered runtime adapters. */
  public list(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  /** Purpose: Aggregates runtime health across all registered adapters. */
  public async health(workspaceId?: string): Promise<Record<string, RuntimeAdapterHealth>> {
    const entries = await Promise.all(
      this.list().map(async (adapter) => {
        try {
          const health = await adapter.health(workspaceId === undefined ? undefined : { workspace_id: workspaceId });
          return [adapter.manifest.adapter_id, health] as const;
        } catch {
          return [adapter.manifest.adapter_id, unavailableHealth()] as const;
        }
      }),
    );

    return Object.fromEntries(entries);
  }
}
