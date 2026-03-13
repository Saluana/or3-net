import { z } from "zod";

import { authTokenSchema } from "../core.ts";
import { nonEmptyStringSchema } from "../shared.ts";

export const exchangeSessionRequestSchema = z.object({
  provider: nonEmptyStringSchema,
  session_proof: z.record(z.string(), z.unknown()),
  workspace_id: nonEmptyStringSchema.optional(),
});

export const exchangeSessionResponseSchema = authTokenSchema;

export type ExchangeSessionRequest = z.infer<typeof exchangeSessionRequestSchema>;
export type ExchangeSessionResponse = z.infer<typeof exchangeSessionResponseSchema>;
