
/**
 * @module src/contracts/platform/auth
 *
 * Purpose:
 * Auth request and response contracts for exchanging upstream session proof into
 * OR3 workspace tokens.
 */
import { z } from "zod";

import { authTokenSchema } from "../core.ts";
import { nonEmptyStringSchema } from "../shared.ts";

/**
 * Purpose:
 * Stable host-assertion envelope used by `or3-chat` when exchanging an SSR-
 * resolved user session for an OR3 Net workspace token.
 */
export const or3ChatAssertionFormat = "or3-chat-assertion-v1" as const;

/** Purpose: Canonical `session_proof` payload for `provider = "or3-chat"`. */
export const or3ChatSessionProofSchema = z.object({
  format: z.literal(or3ChatAssertionFormat),
  assertion: nonEmptyStringSchema,
});

/**
 * Purpose:
 * Request payload used by auth exchange endpoints.
 *
 * Behavior:
 * Carries opaque provider proof plus an optional workspace hint when the caller
 * wants to target a specific workspace.
 */
export const exchangeSessionRequestSchema = z.object({
  provider: nonEmptyStringSchema,
  session_proof: z.record(z.string(), z.unknown()),
  workspace_id: nonEmptyStringSchema.optional(),
});

/** Purpose: Auth exchange response reusing the canonical auth-token contract. */
export const exchangeSessionResponseSchema = authTokenSchema;

export type Or3ChatSessionProof = z.infer<typeof or3ChatSessionProofSchema>;
export type ExchangeSessionRequest = z.infer<typeof exchangeSessionRequestSchema>;
export type ExchangeSessionResponse = z.infer<typeof exchangeSessionResponseSchema>;
