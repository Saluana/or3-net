import { describe, expect, test } from "bun:test";

import {
  type RuntimeAdapter,
  type RuntimeAdapterHealth,
  type RuntimeCapability,
  RuntimeCapabilitySet,
  RuntimeError,
  RuntimeRegistry,
  RuntimeSelectionService,
} from "../../src/index.ts";
import type {
  RuntimeAdapterSessionHandle,
  RuntimeExecutionHandle,
  RuntimeNodeDescriptor,
} from "../../src/contracts/runtime/index.ts";

class FakeRuntimeAdapter implements RuntimeAdapter {
  public constructor(
    public readonly manifest: RuntimeAdapter["manifest"],
    private readonly options: {
      health?: RuntimeAdapterHealth | (() => Promise<RuntimeAdapterHealth>);
      nodes?: RuntimeNodeDescriptor[];
    } = {},
  ) {}

  public health(): Promise<RuntimeAdapterHealth> {
    if (typeof this.options.health === "function") {
      return this.options.health();
    }

    return Promise.resolve(
      this.options.health ?? {
        status: "healthy",
        checked_at: "2026-03-14T00:00:00.000Z",
      },
    );
  }

  public listNodes(): Promise<RuntimeNodeDescriptor[]> {
    return Promise.resolve(this.options.nodes ?? []);
  }

  public createSession(): Promise<RuntimeAdapterSessionHandle> {
    return Promise.resolve({
      ref: "sess_1",
      adapter_id: this.manifest.adapter_id,
      status: "ready",
      capabilities: RuntimeCapabilitySet.fromValues(this.manifest.capabilities),
    });
  }

  public destroySession(): Promise<{ destroyed: boolean; message?: string }> {
    return Promise.resolve({ destroyed: true });
  }

  public exec(): Promise<RuntimeExecutionHandle> {
    return Promise.resolve({
      execution_id: "exec_1",
      result: Promise.resolve({ exit_code: 0, stdout: "", stderr: "", artifacts: [], meta: {} }),
      abort: () => Promise.resolve({ acknowledged: true }),
    });
  }

  public copyIn(): Promise<{ path: string; bytes_transferred: number }> {
    return Promise.resolve({ path: "/workspace/in", bytes_transferred: 1 });
  }

  public copyOut(): Promise<{ path: string; bytes_transferred: number }> {
    return Promise.resolve({ path: "/workspace/out", bytes_transferred: 1 });
  }

  public getLogs(): Promise<{ chunks: never[] }> {
    return Promise.resolve({ chunks: [] });
  }
}

const createAdapter = (
  overrides: Partial<Omit<RuntimeAdapter["manifest"], "capabilities">> & {
    capabilities?: Iterable<RuntimeCapability>;
  } = {},
  options?: ConstructorParameters<typeof FakeRuntimeAdapter>[1],
): FakeRuntimeAdapter =>
  new FakeRuntimeAdapter(
    {
      adapter_id: overrides.adapter_id ?? "sandbox-default",
      display_name: overrides.display_name ?? "Sandbox Runtime",
      version: overrides.version ?? "1.0.0",
      adapter_kind: overrides.adapter_kind ?? "sandbox",
      isolation_class: overrides.isolation_class ?? "container",
      trust_tier: overrides.trust_tier ?? "development",
      locality: overrides.locality ?? "local",
      capabilities: RuntimeCapabilitySet.fromValues(overrides.capabilities ?? ["exec", "copy-in"]),
      supported_presets: overrides.supported_presets ?? ["default"],
      session_modes: overrides.session_modes ?? ["ephemeral"],
    },
    options,
  );

const createNode = (overrides: Partial<RuntimeNodeDescriptor> = {}): RuntimeNodeDescriptor => ({
  node_id: overrides.node_id ?? "node_1",
  runtime_id: overrides.runtime_id ?? "sandbox-default",
  health:
    overrides.health ?? {
      status: "healthy",
      checked_at: "2026-03-14T00:00:00.000Z",
    },
  capabilities: overrides.capabilities ?? RuntimeCapabilitySet.fromValues(["exec", "copy-in"]),
  resource_limits: overrides.resource_limits ?? {},
  locality: overrides.locality ?? "local",
});

describe("runtime registry and selection", () => {
  test("registry rejects duplicate adapter ids", () => {
    const registry = new RuntimeRegistry();
    registry.register(createAdapter({ adapter_id: "dup" }));

    expect(() => registry.register(createAdapter({ adapter_id: "dup" }))).toThrow("already registered");
  });

  test("registry rejects invalid manifests", () => {
    const registry = new RuntimeRegistry();
    const adapter = createAdapter({ version: "latest" as never });

    expect(() => registry.register(adapter)).toThrow();
  });

  test("registry health aggregation returns per-adapter status", async () => {
    const registry = new RuntimeRegistry();
    registry.register(createAdapter({ adapter_id: "healthy" }));
    registry.register(
      createAdapter(
        { adapter_id: "degraded" },
        { health: { status: "degraded", message: "slow", checked_at: "2026-03-14T00:00:00.000Z" } },
      ),
    );

    const health = await registry.health("ws_1");
    expect(health["healthy"]?.status).toBe("healthy");
    expect(health["degraded"]?.status).toBe("degraded");
  });

  test("selection chooses an adapter by capability match", async () => {
    const registry = new RuntimeRegistry();
    registry.register(createAdapter({ adapter_id: "copy", capabilities: ["exec", "copy-in"] }));
    registry.register(createAdapter({ adapter_id: "exec-only", capabilities: ["exec"] }));

    const selection = await new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["exec", "copy-in"],
    });

    expect(selection.adapter.manifest.adapter_id).toBe("copy");
  });

  test("selection prefers healthy adapters over degraded ones", async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      createAdapter(
        { adapter_id: "degraded" },
        { health: { status: "degraded", checked_at: "2026-03-14T00:00:00.000Z" } },
      ),
    );
    registry.register(createAdapter({ adapter_id: "healthy" }));

    const selection = await new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["exec"],
    });

    expect(selection.adapter.manifest.adapter_id).toBe("healthy");
  });

  test("registry health marks thrown adapter probes unavailable", async () => {
    const registry = new RuntimeRegistry();
    registry.register(createAdapter({ adapter_id: "healthy" }));
    registry.register(
      createAdapter(
        { adapter_id: "broken" },
        {
          health: () => Promise.reject(new Error("timeout")),
        },
      ),
    );

    const health = await registry.health("ws_1");
    expect(health["healthy"]?.status).toBe("healthy");
    expect(health["broken"]?.status).toBe("unavailable");
  });

  test("selection skips adapters whose health probe throws", async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      createAdapter(
        { adapter_id: "broken", capabilities: ["exec"] },
        {
          health: () => Promise.reject(new Error("timeout")),
        },
      ),
    );
    registry.register(createAdapter({ adapter_id: "healthy", capabilities: ["exec"] }));

    const selection = await new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["exec"],
    });

    expect(selection.adapter.manifest.adapter_id).toBe("healthy");
  });

  test("selection ranks unknown health below healthy", async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      createAdapter(
        { adapter_id: "unknown", capabilities: ["exec"] },
        {
          health: { status: "unknown", checked_at: "2026-03-14T00:00:00.000Z" },
        },
      ),
    );
    registry.register(createAdapter({ adapter_id: "healthy", capabilities: ["exec"] }));

    const selection = await new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["exec"],
    });

    expect(selection.adapter.manifest.adapter_id).toBe("healthy");
  });

  test("selection respects trust tier, isolation class, locality, and preset", async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      createAdapter(
        {
          adapter_id: "remote-prod",
          trust_tier: "production",
          isolation_class: "vm",
          locality: "remote",
          supported_presets: ["python"],
        },
        { nodes: [createNode({ runtime_id: "remote-prod", locality: "remote" })] },
      ),
    );
    registry.register(
      createAdapter(
        {
          adapter_id: "local-dev",
          trust_tier: "development",
          isolation_class: "container",
          locality: "local",
          supported_presets: ["default"],
        },
        { nodes: [createNode({ runtime_id: "local-dev", locality: "local" })] },
      ),
    );

    const selection = await new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["exec"],
      trust_tier: "production",
      isolation_class: "vm",
      locality: "remote",
      preset_id: "python",
    });

    expect(selection.adapter.manifest.adapter_id).toBe("remote-prod");
    expect(selection.node?.locality).toBe("remote");
  });

  test("selection throws policy_denied when no adapter matches", async () => {
    const registry = new RuntimeRegistry();
    registry.register(createAdapter({ adapter_id: "exec-only", capabilities: ["exec"] }));

    const selectionPromise = new RuntimeSelectionService(registry).select("ws_1", {
      required_capabilities: ["service-expose"],
    });

    try {
      await selectionPromise;
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).toMatchObject({ code: "policy_denied" });
    }
  });
});