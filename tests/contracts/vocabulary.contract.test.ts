import { describe, expect, test } from "bun:test";

import {
  auditContextSchema,
  capabilityGrantSchema,
  platformSessionRefSchema,
  workspacePrincipalSchema,
} from "../../src/contracts/platform/types.ts";
import { readFixtureJson } from "./helpers.ts";

describe("platform vocabulary contract", () => {
  test("workspace principal fixture uses canonical field names", async () => {
    const payload = await readFixtureJson<Record<string, unknown>>("workspace-principal.json");
    const parsed = workspacePrincipalSchema.parse(payload);

    expect(parsed.subject).toBe("user_123");
    expect("provider_user_id" in payload).toBeFalse();
  });

  test("platform session ref fixture uses canonical field names", async () => {
    const payload = await readFixtureJson<unknown>("platform-session-ref.json");
    const parsed = platformSessionRefSchema.parse(payload);

    expect(parsed.network_session_id).toBe("sess_demo");
  });

  test("capability grant fixtures cover all current kinds", async () => {
    const payload = await readFixtureJson<unknown[]>("capability-grant.json");
    const parsed = payload.map((item) => capabilityGrantSchema.parse(item));

    expect(new Set(parsed.map((item) => item.kind))).toEqual(
      new Set(["preview-launch", "service-launch", "tunnel-access", "file-download"]),
    );
  });

  test("audit context fixture parses", async () => {
    const payload = await readFixtureJson<unknown>("audit-context.json");
    const parsed = auditContextSchema.parse(payload);

    expect(parsed.request_id).toBe("req_demo");
  });
});
