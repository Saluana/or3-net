import { createId } from "../lib/ids.ts";
import { createErrorEnvelope, type CreateErrorEnvelopeInput } from "../contracts/platform/compat.ts";

export const resolveRequestId = (headerValue: string | null): string => {
  const normalized = headerValue?.trim();
  if (normalized !== undefined && normalized !== "") {
    return normalized;
  }
  return createId("req");
};

export const errorResponse = (input: CreateErrorEnvelopeInput): Response => {
  const envelope = createErrorEnvelope(input);
  return Response.json(envelope, {
    status: input.status,
    headers: {
      "X-Request-Id": envelope.request_id,
      ...(envelope.retry_after_ms === undefined
        ? {}
        : { "Retry-After": String(Math.ceil(envelope.retry_after_ms / 1000)) }),
    },
  });
};
