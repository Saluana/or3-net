import { describe, expect, test } from "bun:test";

import {
  internJobEventSchema,
  internTurnRequestSchema,
  internTurnResponseSchema,
} from "../../sdk/intern/types.ts";
import { readFixtureJson, readJsonLines } from "./helpers.ts";

describe("intern SDK contract", () => {
  test("intern turn request fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("intern-turn-request.json");
    const parsed = internTurnRequestSchema.parse(payload);

    expect(parsed.session_key).toBe("svc:sess_demo");
  });

  test("intern turn response fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("intern-turn-response.json");
    const parsed = internTurnResponseSchema.parse(payload);

    expect(parsed.status).toBe("completed");
  });

  test("intern stream event fixtures parse", async () => {
    const payload = await readJsonLines<unknown>("intern-stream-events.jsonl");
    const parsed = payload.map((event) => internJobEventSchema.parse(event));

    expect(parsed).toHaveLength(4);
  });
});
