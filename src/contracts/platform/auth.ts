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

export type ExchangeSessionRequest = z.infer<typeof exchangeSessionRequestSchema>;
export type ExchangeSessionResponse = z.infer<typeof exchangeSessionResponseSchema>;
