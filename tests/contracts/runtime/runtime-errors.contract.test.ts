import { describe, expect, test } from "bun:test";

import {
  RuntimeError,
  runtimeErrorEnvelopeSchema,
  runtimeErrorToApiEnvelope,
} from "../../../src/contracts/runtime/index.ts";
import { readFixtureJson } from "../helpers.ts";

const runtimeErrorFixtureNames = [
  "runtime-error-envelope.unsupported_capability.json",
  "runtime-error-envelope.policy_denied.json",
  "runtime-error-envelope.adapter_unavailable.json",
  "runtime-error-envelope.session_not_found.json",
  "runtime-error-envelope.session_destroyed.json",
  "runtime-error-envelope.exec_failed.json",
  "runtime-error-envelope.exec_timeout.json",
  "runtime-error-envelope.copy_failed.json",
  "runtime-error-envelope.log_unavailable.json",
  "runtime-error-envelope.adapter_internal.json",
] as const;

describe("runtime errors contract", () => {
  for (const fixtureName of runtimeErrorFixtureNames) {
    test(`${fixtureName} parses as RuntimeErrorEnvelope`, async () => {
      const payload = await readFixtureJson<unknown>(fixtureName);
      const parsed = runtimeErrorEnvelopeSchema.parse(payload);

      expect(parsed.message.length).toBeGreaterThan(0);
    });
  }

  test("runtime errors map to API envelopes", () => {
    const apiEnvelope = runtimeErrorToApiEnvelope(
      new RuntimeError("adapter_unavailable", "sandbox adapter is unavailable", {
        retriable: true,
        retryAfterMs: 5000,
      }),
      "req_runtime_1",
    );

    expect(apiEnvelope.code).toBe("runtime.adapter_unavailable");
    expect(apiEnvelope.status).toBe(503);
    expect(apiEnvelope.retry_after_ms).toBe(5000);
  });

  test("destroyed sessions map to conflict semantics", () => {
    const apiEnvelope = runtimeErrorToApiEnvelope(
      new RuntimeError("session_destroyed", "runtime session is already destroyed"),
      "req_runtime_2",
    );

    expect(apiEnvelope.code).toBe("resource.conflict");
    expect(apiEnvelope.status).toBe(409);
  });
});
