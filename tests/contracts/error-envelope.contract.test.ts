import { describe, expect, test } from "bun:test";

import { errorEnvelopeSchema } from "../../src/contracts/platform/types.ts";
import { readFixtureJson } from "./helpers.ts";

const fixtureNames = [
  "error-envelope.401.json",
  "error-envelope.403.json",
  "error-envelope.404.json",
  "error-envelope.409.json",
  "error-envelope.429.json",
] as const;

describe("error envelope contract", () => {
  for (const fixtureName of fixtureNames) {
    test(`${fixtureName} parses as ErrorEnvelope`, async () => {
      const payload = await readFixtureJson<unknown>(fixtureName);
      const parsed = errorEnvelopeSchema.parse(payload);

      expect(parsed.request_id.startsWith("req_")).toBeTrue();
      expect(parsed.status).toBeGreaterThanOrEqual(400);
    });
  }
});
