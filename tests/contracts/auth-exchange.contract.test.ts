import { describe, expect, test } from "bun:test";

import { exchangeSessionRequestSchema, exchangeSessionResponseSchema } from "../../src/contracts/platform/auth.ts";
import { readFixtureJson } from "./helpers.ts";

describe("auth exchange contract", () => {
  test("request fixture matches frozen exchange request schema", async () => {
    const payload = await readFixtureJson<unknown>("auth-exchange.request.json");
    const parsed = exchangeSessionRequestSchema.parse(payload);

    expect(parsed.provider).toBe("clerk");
    expect(parsed.workspace_id).toBe("ws_demo");
  });

  test("response fixture matches frozen exchange response schema", async () => {
    const payload = await readFixtureJson<unknown>("auth-exchange.response.json");
    const parsed = exchangeSessionResponseSchema.parse(payload);

    expect(parsed.workspace_id).toBe("ws_demo");
    expect(parsed.scopes).toContain("jobs:write");
  });
});
