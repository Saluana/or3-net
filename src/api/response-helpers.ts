/**
 * @module src/api/response-helpers
 *
 * Purpose:
 * Centralizes common HTTP response helpers so all API handlers emit consistent
 * request ids and platform error envelopes.
 */
import { createId } from "../lib/ids.ts";
import { createErrorEnvelope, type CreateErrorEnvelopeInput } from "../contracts/platform/compat.ts";

/**
 * Purpose:
 * Resolves the request id that should be attached to logs and error responses.
 *
 * Behavior:
 * Reuses a caller-supplied id when present, otherwise creates a new OR3-style
 * request identifier.
 */
export const resolveRequestId = (headerValue: string | null): string => {
  const normalized = headerValue?.trim();
  if (normalized !== undefined && normalized !== "") {
    return normalized;
  }
  return createId("req");
};

/**
 * Purpose:
 * Serializes a platform error envelope into an HTTP `Response`.
 *
 * Behavior:
 * Always includes `X-Request-Id` and maps retry timing to an HTTP
 * `Retry-After` header when the envelope carries retry metadata.
 */
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
