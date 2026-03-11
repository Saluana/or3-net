import { z } from "zod";

import type { AuthToken } from "../contracts/index.ts";
import { authTokenSchema, nonEmptyStringSchema } from "../contracts/index.ts";
import { decodeBase64Url, encodeBase64Url, hmacSha256Hex } from "../lib/crypto.ts";

const workspaceTokenClaimsSchema = z.object({
  sub: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  scopes: z.array(nonEmptyStringSchema).min(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  kind: z.literal("workspace-token"),
});

export interface WorkspacePrincipal {
  readonly subject: string;
  readonly workspace_id: string;
  readonly scopes: string[];
  readonly auth_type: "workspace-token" | "api-key";
}

export interface IssueWorkspaceTokenInput {
  readonly secret: string;
  readonly subject: string;
  readonly workspace_id: string;
  readonly scopes: string[];
  readonly ttlMs?: number;
  readonly now?: Date;
}

export const issueWorkspaceToken = async (input: IssueWorkspaceTokenInput): Promise<AuthToken> => {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000));
  const claims = workspaceTokenClaimsSchema.parse({
    sub: input.subject,
    workspace_id: input.workspace_id,
    scopes: input.scopes,
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    kind: "workspace-token",
  });
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = await hmacSha256Hex(input.secret, payload);

  return authTokenSchema.parse({
    token: `${payload}.${signature}`,
    workspace_id: input.workspace_id,
    expires_at: expiresAt.toISOString(),
    scopes: input.scopes,
  });
};

export const validateWorkspaceToken = async (
  secret: string,
  token: string,
  now = new Date(),
): Promise<WorkspacePrincipal> => {
  const [payloadPart, signaturePart] = token.trim().split(".", 2);
  if (payloadPart === undefined || signaturePart === undefined) {
    throw new Error("invalid workspace token format");
  }

  const expectedSignature = await hmacSha256Hex(secret, payloadPart);
  if (expectedSignature !== signaturePart) {
    throw new Error("invalid workspace token signature");
  }

  const claims = workspaceTokenClaimsSchema.parse(JSON.parse(decodeBase64Url(payloadPart)) as unknown);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSeconds) {
    throw new Error("workspace token expired");
  }

  return {
    subject: claims.sub,
    workspace_id: claims.workspace_id,
    scopes: claims.scopes,
    auth_type: "workspace-token",
  };
};
