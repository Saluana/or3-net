import { describe, expect, test } from "bun:test";

import {
  runtimeSessionCreateInputSchema,
  runtimeSessionStateValues,
} from "../../../src/contracts/runtime/index.ts";

describe("runtime sessions contract", () => {
  test("accepts generic staged-workspace session input without host-specific ownership", () => {
    const parsed = runtimeSessionCreateInputSchema.parse({
      preset_id: "default",
      required_capabilities: ["exec", "workspace-materialize"],
      workspace_ref: {
        kind: "host-stage",
        reference: "workspace-root",
        paths: ["src", "package.json"]
      },
      workspace_mode: "read_write",
      network_policy: {
        internet_access: false,
        ingress: "private"
      },
      resource_hints: {
        cpu_cores: 2,
        metadata: {
          preset: "default"
        }
      },
      persistence_mode: "ephemeral",
      env_refs: [{ name: "CI", ref: "env.ci" }],
      secret_refs: [{ name: "TOKEN", secret_ref: "secret.runtime.token" }],
      timeout_rules: { soft_ms: 30000 },
      artifact_rules: { capture_paths: ["dist"], push_on_completion: false, metadata: {} }
    });

    expect(parsed.workspace_mode).toBe("read_write");
    expect(parsed.required_capabilities?.has("workspace-materialize")).toBeTrue();
  });

  test("accepts host-owned workspace staging session input", () => {
    const parsed = runtimeSessionCreateInputSchema.parse({
      workspace_stage: {
        source_kind: "host",
        paths: ["src/index.ts", "package.json"],
        mode: "read_write",
        transport: "auto",
      },
      workspace_mode: "read_write",
      network_policy: { internet_access: false, ingress: "none" },
      resource_hints: { metadata: {} },
      persistence_mode: "ephemeral",
      env_refs: [],
      secret_refs: [],
      timeout_rules: {},
      artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
    });

    expect(parsed.workspace_stage?.source_kind).toBe("host");
    expect(parsed.workspace_stage?.mode).toBe("read_write");
  });

  test("runtime session states remain aligned with lifecycle design", () => {
    expect(runtimeSessionStateValues).toEqual([
      "creating",
      "ready",
      "stopping",
      "stopped",
      "destroying",
      "destroyed",
      "failed",
    ]);
  });
});
