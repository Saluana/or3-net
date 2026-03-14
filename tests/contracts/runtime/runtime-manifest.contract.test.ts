import { describe, expect, test } from "bun:test";

import {
  runtimeAdapterManifestSchema,
  RuntimeCapabilitySet,
} from "../../../src/contracts/runtime/index.ts";
import { readFixtureJson } from "../helpers.ts";

describe("runtime manifest contract", () => {
  test("valid runtime manifest fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("runtime-adapter-manifest.json");
    const parsed = runtimeAdapterManifestSchema.parse(payload);

    expect(parsed.adapter_id).toBe("sandbox-default");
    expect(parsed.capabilities).toBeInstanceOf(RuntimeCapabilitySet);
    expect(parsed.capabilities.has("workspace-materialize")).toBeTrue();
  });

  test("invalid manifests are rejected", () => {
    expect(() =>
      runtimeAdapterManifestSchema.parse({
        adapter_id: "sandbox-default",
        display_name: "Sandbox Runtime",
        version: "latest",
        adapter_kind: "sandbox",
        isolation_class: "container",
        trust_tier: "development",
        locality: "local",
        capabilities: ["bad:capability"],
        supported_presets: [],
        session_modes: [],
      }),
    ).toThrow();
  });
});
