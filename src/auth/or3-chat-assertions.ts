
/**
 * @module src/auth/or3-chat-assertions
 *
 * Purpose:
 * Provides the stable host-signed assertion format used by `or3-chat` to
 * exchange an authenticated SSR session for an OR3 Net workspace token.
 *
 * Responsibilities:
 * - Issue compact HMAC-signed `or3-chat-assertion-v1` proofs
 * - Validate proof signature, issuer, audience, expiry, and workspace binding
 * - Adapt validated assertions to the `SessionProofValidator` interface
 *
 * Non-responsibilities:
 * - Does not resolve the upstream chat session itself
 * - Does not mint OR3 workspace bearer tokens directly
 */
import nacl from "tweetnacl";
import { z } from "zod";

import type { SessionProofValidator } from "./service.ts";
import { or3ChatAssertionFormat, or3ChatSessionProofSchema, type Or3ChatSessionProof } from "../contracts/platform/auth.ts";
import { nonEmptyStringSchema } from "../contracts/shared.ts";
import { decodeBase64Url, encodeBase64Url, hmacSha256Hex } from "../lib/crypto.ts";

const DEFAULT_ISSUER = "or3-chat";
const DEFAULT_AUDIENCE = "or3-net";

const audienceClaimSchema = z.union([nonEmptyStringSchema, z.array(nonEmptyStringSchema).min(1)]);

/** Purpose: Internal assertion claims carried inside the compact host token. */
export const or3ChatAssertionClaimsSchema = z
  .object({
    iss: nonEmptyStringSchema,
    aud: audienceClaimSchema,
    subject: nonEmptyStringSchema.optional(),
    sub: nonEmptyStringSchema.optional(),
    workspace_id: nonEmptyStringSchema,
    scopes: z.array(nonEmptyStringSchema).min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    kind: z.literal(or3ChatAssertionFormat),
  })
  .superRefine((value, context) => {
    if (value.subject === undefined && value.sub === undefined) {
      context.addIssue({
        code: "custom",
        path: ["subject"],
        message: "or3-chat assertion requires subject",
      });
    }
  });

export interface IssueOr3ChatSessionProofInput {
  readonly secret: string;
  readonly subject: string;
  readonly workspace_id: string;
  readonly scopes: readonly string[];
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  readonly ttlMs?: number;
  readonly now?: Date;
}

export interface ValidateOr3ChatSessionProofOptions {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly now?: Date;
}

export interface Or3ChatSessionProofValidatorOptions {
  readonly secret: string;
  readonly issuer?: string;
  readonly audience?: string;
}

export type Or3ChatAssertionClaims = z.infer<typeof or3ChatAssertionClaimsSchema>;

/** Purpose: Provider id reserved for the `or3-chat` host assertion path. */
export const or3ChatSessionProofProvider = "or3-chat" as const;

/**
 * Purpose:
 * Issues a compact host assertion that `or3-chat` can pass to OR3 Net through
 * the existing `session_proof` exchange payload.
 */
export const issueOr3ChatSessionProof = async (input: IssueOr3ChatSessionProofInput): Promise<Or3ChatSessionProof> => {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 60_000));
  const claims = or3ChatAssertionClaimsSchema.parse({
    iss: input.issuer ?? DEFAULT_ISSUER,
    aud: input.audience ?? DEFAULT_AUDIENCE,
    subject: input.subject,
    sub: input.subject,
    workspace_id: input.workspace_id,
    scopes: [...input.scopes],
    iat: Math.floor(now.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    kind: or3ChatAssertionFormat,
  });
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = await hmacSha256Hex(input.secret, payload);
  return {
    format: or3ChatAssertionFormat,
    assertion: `${payload}.${signature}`,
  };
};

/**
 * Purpose:
 * Validates a compact `or3-chat-assertion-v1` proof and returns its normalized
 * claims when the signature and request binding are valid.
 */
export const validateOr3ChatSessionProof = async (
  proofInput: unknown,
  options: ValidateOr3ChatSessionProofOptions,
): Promise<Or3ChatAssertionClaims> => {
  const proof = or3ChatSessionProofSchema.parse(proofInput);
  const [payloadPart, signaturePart] = proof.assertion.trim().split(".", 2);
  if (payloadPart === undefined || signaturePart === undefined) {
    throw new Error("invalid or3-chat assertion format");
  }

  const expectedSignature = await hmacSha256Hex(options.secret, payloadPart);
  const expectedSignatureBytes = hexToBytes(expectedSignature);
  const providedSignatureBytes = hexToBytes(signaturePart);
  const signaturesMatch =
    expectedSignatureBytes !== null &&
    expectedSignatureBytes.length === providedSignatureBytes?.length &&
    nacl.verify(expectedSignatureBytes, providedSignatureBytes);
  if (!signaturesMatch) {
    throw new Error("invalid or3-chat assertion signature");
  }

  const claims = or3ChatAssertionClaimsSchema.parse(JSON.parse(decodeBase64Url(payloadPart)) as unknown);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp <= nowSeconds) {
    throw new Error("or3-chat assertion expired");
  }
  if (claims.iss !== (options.issuer ?? DEFAULT_ISSUER)) {
    throw new Error("unexpected or3-chat assertion issuer");
  }
  if (!matchesAudience(claims.aud, options.audience ?? DEFAULT_AUDIENCE)) {
    throw new Error("unexpected or3-chat assertion audience");
  }

  return claims;
};

/**
 * Purpose:
 * `SessionProofValidator` implementation for the single trusted `or3-chat`
 * exchange path.
 */
export class Or3ChatSessionProofValidator implements SessionProofValidator {
  public constructor(private readonly options: Or3ChatSessionProofValidatorOptions) {}

  public async validateSessionProof(input: {
    provider: string;
    session_proof: Record<string, unknown>;
    workspace_hint?: string;
  }): Promise<{ user_id: string; workspace_id: string; scopes: string[] }> {
    if (input.provider !== or3ChatSessionProofProvider) {
      throw new Error(`unsupported session proof provider: ${input.provider}`);
    }

    const claims = await validateOr3ChatSessionProof(input.session_proof, this.options);
    if (input.workspace_hint !== undefined && claims.workspace_id !== input.workspace_hint) {
      throw new Error("workspace mismatch");
    }

    return {
      user_id: claims.subject ?? claims.sub ?? "",
      workspace_id: claims.workspace_id,
      scopes: [...claims.scopes],
    };
  }
}

const matchesAudience = (
  value: string | readonly string[],
  expected: string,
): boolean => {
  if (typeof value === "string") {
    return value === expected;
  }
  return value.includes(expected);
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
