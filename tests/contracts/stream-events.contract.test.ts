import { describe, expect, test } from "bun:test";

import { platformStreamEventSchema } from "../../src/contracts/platform/stream-events.ts";
import { readJsonLines } from "./helpers.ts";

describe("platform stream event contract", () => {
  test("fixture stream events parse as PlatformStreamEvent", async () => {
    const events = await readJsonLines<unknown>("job-stream-events.jsonl");
    const parsed = events.map((event) => platformStreamEventSchema.parse(event));

    expect(parsed.map((event) => event.event)).toContain("job.completed");
    expect(parsed.at(-1)?.event).toBe("error");
  });
});
