import { describe, expect, test } from "bun:test";

import {
  OpenSandboxRequestError,
  isOpenSandboxRequestError,
  isProviderRequestErrorLike,
} from "../../sdk/opensandbox/types.ts";

describe("OpenSandbox SDK contract", () => {
  test("OpenSandboxRequestError preserves provider metadata", () => {
    const error = new OpenSandboxRequestError("rate limited", 429, {
      code: "rate_limited",
      retryAfterMs: 3000,
      details: { provider: { message: "slow down" } },
    });

    expect(error.name).toBe("OpenSandboxRequestError");
    expect(error.message).toBe("rate limited");
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(3000);
    expect(error.details).toEqual({ provider: { message: "slow down" } });
  });

  test("provider error guards accept the wrapped OpenSandbox error shape", () => {
    const error = new OpenSandboxRequestError("missing", 404, { code: "not_found" });

    expect(isProviderRequestErrorLike(error)).toBeTrue();
    expect(isOpenSandboxRequestError(error)).toBeTrue();
    expect(isOpenSandboxRequestError(new Error("plain"))).toBeFalse();
    expect(isProviderRequestErrorLike({ message: "bad" })).toBeFalse();
  });
});
