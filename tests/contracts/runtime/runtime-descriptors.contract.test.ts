import { describe, expect, test } from "bun:test";

import {
  runtimeExposeServiceInputSchema,
  runtimeArtifactDescriptorSchema,
  runtimeDescriptorSchema,
  runtimeExecutionRequestSchema,
  runtimeSessionDescriptorSchema,
} from "../../../src/contracts/runtime/index.ts";
import { readFixtureJson } from "../helpers.ts";

describe("runtime descriptor contract", () => {
  test("runtime descriptor fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("runtime-descriptor.json");
    const parsed = runtimeDescriptorSchema.parse(payload);

    expect(parsed.health.status).toBe("healthy");
    expect(parsed.capabilities.has("workspace-materialize")).toBeTrue();
  });

  test("runtime session descriptor fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("runtime-session-descriptor.json");
    const parsed = runtimeSessionDescriptorSchema.parse(payload);

    expect(parsed.session_id).toBe("rts_demo");
    expect(parsed.status).toBe("ready");
  });

  test("runtime execution request fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("runtime-execution-request.json");
    const parsed = runtimeExecutionRequestSchema.parse(payload);

    expect(parsed.command).toBe("bun");
    expect(parsed.timeout_ms).toBe(30000);
  });

  test("runtime artifact fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("runtime-artifact-descriptor.json");
    const parsed = runtimeArtifactDescriptorSchema.parse(payload);

    expect(parsed.session_id).toBe("rts_demo");
    expect(parsed.size_bytes).toBe(12);
  });

  test("service exposure rejects invalid ports", () => {
    expect(() =>
      runtimeExposeServiceInputSchema.parse({
        session_ref: "sess_1",
        service_name: "web",
        port: 0,
      }),
    ).toThrow();

    expect(() =>
      runtimeExposeServiceInputSchema.parse({
        session_ref: "sess_1",
        service_name: "web",
        port: 65536,
      }),
    ).toThrow();
  });
});
