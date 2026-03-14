import { beforeEach, describe, expect, test } from "bun:test";

import { AuthService, createControlPlaneDatabase } from "../src/index.ts";
import { validateWorkspaceToken, issueWorkspaceToken } from "../src/auth/tokens.ts";
import { encodeBase64Url, hmacSha256Hex } from "../src/lib/crypto.ts";

const secret = "phase2-secret";

describe("auth principal canonical fields", () => {
  let authService: AuthService;
  const issuedAtDate = new Date("2099-01-01T00:00:00.000Z");
  const issuedAtSeconds = Math.floor(issuedAtDate.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + 60;

  beforeEach(() => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_test",
      name: "Test Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    authService = new AuthService({
      secret,
      database,
      sessionProofValidator: {
        validateSessionProof: () => Promise.resolve({
          user_id: "user_1",
          workspace_id: "ws_test",
          scopes: ["jobs:read", "jobs:write"],
        }),
      },
    });
  });

  test("workspace token auth returns canonical principal fields", async () => {
    const token = await issueWorkspaceToken({
      secret,
      subject: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read"],
      now: issuedAtDate,
      ttlMs: 60_000,
    });

    const principal = await authService.authenticateBearerToken(`Bearer ${token.token}`);
    expect(principal).toEqual({
      subject: "user_1",
      workspace_id: "ws_test",
      scopes: ["jobs:read"],
      auth_type: "workspace-token",
      issued_at: issuedAtSeconds,
      expires_at: expiresAtSeconds,
    });
  });

  test("api key auth returns canonical principal fields", async () => {
    const { api_key: apiKey } = await authService.createApiKey({
      workspace_id: "ws_test",
      name: "principal-test-key",
      scopes: ["jobs:read"],
    });

    const principal = await authService.authenticateBearerToken(`Bearer ${apiKey}`);
    expect(principal.subject.startsWith("api_")).toBeTrue();
    expect(principal.workspace_id).toBe("ws_test");
    expect(principal.scopes).toEqual(["jobs:read"]);
    expect(principal.auth_type).toBe("api-key");
    expect(principal.issued_at).toBeGreaterThan(0);
    expect(principal.expires_at).toBeGreaterThan(principal.issued_at);
  });

  test("token validation remains compatible with legacy sub-only claims", async () => {
    const claims = {
      sub: "legacy_user",
      workspace_id: "ws_test",
      scopes: ["jobs:read"],
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
      kind: "workspace-token",
    };
    const payload = encodeBase64Url(JSON.stringify(claims));
    const signature = await hmacSha256Hex(secret, payload);

    const principal = await validateWorkspaceToken(secret, `${payload}.${signature}`, new Date(issuedAtDate.getTime() + 30_000));
    expect(principal).toEqual({
      subject: "legacy_user",
      workspace_id: "ws_test",
      scopes: ["jobs:read"],
      auth_type: "workspace-token",
      issued_at: issuedAtSeconds,
      expires_at: expiresAtSeconds,
    });
  });
});
