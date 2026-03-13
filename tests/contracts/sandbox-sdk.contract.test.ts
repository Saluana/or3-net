import { describe, expect, test } from "bun:test";

import {
  createSandboxRequestSchema,
  sandboxErrorResponseSchema,
  sandboxExecEventSchema,
  sandboxExecResultSchema,
  sandboxInfoSchema,
} from "../../sdk/sandbox/types.ts";
import { readFixtureJson, readJsonLines } from "./helpers.ts";

describe("sandbox SDK contract", () => {
  test("sandbox create request fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("sandbox-create-request.json");
    const parsed = createSandboxRequestSchema.parse(payload);

    expect(parsed.workspace_id).toBe("ws_demo");
  });

  test("sandbox create response fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("sandbox-create-response.json");
    const parsed = sandboxInfoSchema.parse(payload);

    expect(parsed.id).toBe("sbx_demo");
  });

  test("sandbox exec response fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("sandbox-exec-response.json");
    const parsed = sandboxExecResultSchema.parse(payload);

    expect(parsed.exit_code).toBe(0);
  });

  test("sandbox exec stream events fixture parses", async () => {
    const payload = await readJsonLines<unknown>("sandbox-exec-stream-events.jsonl");
    const parsed = payload.map((event) => sandboxExecEventSchema.parse(event));

    expect(parsed.map((event) => event.event)).toEqual(["stdout", "stderr", "result"]);
  });

  test("sandbox error fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("sandbox-error-response.json");
    const parsed = sandboxErrorResponseSchema.parse(payload);

    expect(parsed.status).toBe(404);
  });
});
