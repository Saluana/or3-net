
import { describe, expect, test } from "bun:test";

import { exchangeSessionRequestSchema, exchangeSessionResponseSchema, or3ChatSessionProofSchema } from "../../src/contracts/platform/auth.ts";
import { readFixtureJson } from "./helpers.ts";

describe("auth exchange contract", () => {
  test("request fixture matches frozen exchange request schema", async () => {
    const payload = await readFixtureJson<unknown>("auth-exchange.request.json");
    const parsed = exchangeSessionRequestSchema.parse(payload);
    const proof = or3ChatSessionProofSchema.parse(parsed.session_proof);

    expect(parsed.provider).toBe("or3-chat");
    expect(parsed.workspace_id).toBe("ws_demo");
    expect(proof.format).toBe("or3-chat-assertion-v1");
  });

  test("response fixture matches frozen exchange response schema", async () => {
    const payload = await readFixtureJson<unknown>("auth-exchange.response.json");
    const parsed = exchangeSessionResponseSchema.parse(payload);

    expect(parsed.workspace_id).toBe("ws_demo");
    expect(parsed.scopes).toContain("jobs:write");
  });
});
