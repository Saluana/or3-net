/**
 * @module src/auth/tokens
 *
 * Purpose:
 * Implements the signed workspace-token format used by OR3 Net bearer auth.
 * Tokens are compact, HMAC-signed payloads that carry workspace scope and
 * expiry without requiring a database lookup.
 *
 * Constraints:
 * - Signature verification uses HMAC-SHA256 over the encoded payload
 * - Claims stay in snake_case to match the public auth contract
 * - Validation rejects expired tokens before returning a principal
 */
import { z } from "zod";
import nacl from "tweetnacl";

import type { AuthToken } from "../contracts/index.ts";
import type { WorkspacePrincipalContract } from "../contracts/platform/types.ts";
import { authTokenSchema, nonEmptyStringSchema } from "../contracts/index.ts";
import { decodeBase64Url, encodeBase64Url, hmacSha256Hex } from "../lib/crypto.ts";

const workspaceTokenClaimsSchema = z.object({
  subject: nonEmptyStringSchema.optional(),
  sub: nonEmptyStringSchema.optional(),
  workspace_id: nonEmptyStringSchema,
  scopes: z.array(nonEmptyStringSchema).min(1),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  kind: z.literal("workspace-token"),
}).superRefine((value, context) => {
  if (value.subject === undefined && value.sub === undefined) {
    context.addIssue({
      code: "custom",
      message: "workspace token requires subject",
      path: ["subject"],
    });
  }
});

/**
 * Purpose:
 * Public workspace principal type returned after bearer-token validation.
 */
export type WorkspacePrincipal = WorkspacePrincipalContract;

/**
 * Purpose:
 * Inputs required to mint a workspace-scoped bearer token.
 */
export interface IssueWorkspaceTokenInput {
  readonly secret: string;
  readonly subject: string;
  readonly workspace_id: string;
  readonly scopes: string[];
  readonly ttlMs?: number;
  readonly now?: Date;
}

/**
 * Purpose:
 * Issues a signed OR3 workspace token.
 *
 * Behavior:
 * Encodes validated claims, signs them with the shared secret, and returns the
 * token plus surfaced expiry metadata for the caller.
 *
 * Constraints:
 * - Default TTL is 15 minutes
 * - `scopes` must be non-empty
 */
export const issueWorkspaceToken = async (input: IssueWorkspaceTokenInput): Promise<AuthToken> => {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 15 * 60_000));
  const claims = workspaceTokenClaimsSchema.parse({
    subject: input.subject,
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

/**
 * Purpose:
 * Validates a previously issued workspace token and converts it into the public
 * workspace principal contract.
 *
 * Behavior:
 * Verifies token shape, compares signatures in constant time, validates claim
 * structure, and rejects expired tokens.
 *
 * @throws Error when the token format, signature, or expiry is invalid.
 */
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
  const expectedSignatureBytes = hexToBytes(expectedSignature);
  const providedSignatureBytes = hexToBytes(signaturePart);
  const signaturesMatch =
    expectedSignatureBytes !== null &&
    expectedSignatureBytes.length === providedSignatureBytes?.length &&
    nacl.verify(expectedSignatureBytes, providedSignatureBytes);
  if (!signaturesMatch) {
    throw new Error("invalid workspace token signature");
  }

  const claims = workspaceTokenClaimsSchema.parse(JSON.parse(decodeBase64Url(payloadPart)) as unknown);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= nowSeconds) {
    throw new Error("workspace token expired");
  }

  return {
    subject: claims.subject ?? claims.sub ?? "",
    workspace_id: claims.workspace_id,
    scopes: claims.scopes,
    auth_type: "workspace-token",
    issued_at: claims.iat,
    expires_at: claims.exp,
  };
};

const hexToBytes = (value: string): Uint8Array | null => {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};
