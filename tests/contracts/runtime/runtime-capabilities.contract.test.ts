import { describe, expect, test } from "bun:test";

import {
  runtimeAdapterSessionHandleSchema,
  RuntimeCapabilitySet,
  runtimeCapabilitySchema,
  runtimeCoreCapabilityValues,
} from "../../../src/contracts/runtime/index.ts";

describe("runtime capabilities contract", () => {
  test("core capability list includes workspace staging substrate", () => {
    expect(runtimeCoreCapabilityValues).toContain("workspace-materialize");
  });

  test("accepts adapter extension capability namespace", () => {
    expect(runtimeCapabilitySchema.parse("ext:sandbox:warm-pool")).toBe("ext:sandbox:warm-pool");
  });

  test("rejects malformed extension capabilities", () => {
    expect(() => runtimeCapabilitySchema.parse("ext:sandbox")).toThrow();
  });

  test("capability set de-duplicates and supports includes", () => {
    const capabilities = RuntimeCapabilitySet.fromValues(["exec", "exec", "copy-in"]);

    expect(capabilities.length).toBe(2);
    expect(capabilities.includes("copy-in")).toBeTrue();
    expect(capabilities.hasAll(["exec", "copy-in"])) .toBeTrue();
  });

  test("adapter session handles reject invalid capabilities", () => {
    expect(() =>
      runtimeAdapterSessionHandleSchema.parse({
        ref: "sess_1",
        adapter_id: "sandbox-default",
        status: "ready",
        capabilities: ["exec", "not-a-real-capability"],
      }),
    ).toThrow();
  });
});
