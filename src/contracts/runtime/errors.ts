/**
 * @module src/contracts/runtime/errors
 *
 * Purpose:
 * Canonical runtime error vocabulary and conversion helpers between runtime and
 * public platform error envelopes.
 *
 * Constraints:
 * - Runtime error codes stay more specific than public platform codes
 * - Mapping to HTTP-facing errors is centralized here to avoid drift
 */
import { z } from "zod";

import { platformErrorCodes } from "../platform/error-codes.ts";
import type { ErrorEnvelope } from "../platform/types.ts";
import { jsonObjectSchema, nonEmptyStringSchema, nonNegativeIntegerSchema } from "../shared.ts";

/** Purpose: Stable runtime error-code literals used across adapters. */
export const runtimeErrorCodeValues = [
  "unsupported_capability",
  "policy_denied",
  "adapter_unavailable",
  "session_not_found",
  "session_destroyed",
  "exec_failed",
  "exec_timeout",
  "copy_failed",
  "log_unavailable",
  "stale_host_write_conflict",
  "unsupported_staging_transport",
  "workspace_root_missing",
  "read_only_commit_denied",
  "adapter_internal",
] as const;

export const runtimeErrorCodeSchema = z.enum(runtimeErrorCodeValues);

/** Purpose: Structured runtime error payload safe for storage and transport. */
export const runtimeErrorEnvelopeSchema = z.object({
  code: runtimeErrorCodeSchema,
  message: nonEmptyStringSchema,
  retriable: z.boolean().default(false),
  details: jsonObjectSchema.default({}),
  retry_after_ms: nonNegativeIntegerSchema.optional(),
});

export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;
export type RuntimeErrorEnvelope = z.infer<typeof runtimeErrorEnvelopeSchema>;

const runtimeErrorCodeToPlatformCode: Record<RuntimeErrorCode, (typeof platformErrorCodes)[keyof typeof platformErrorCodes]> = {
  unsupported_capability: platformErrorCodes.runtimeUnsupportedCapability,
  policy_denied: platformErrorCodes.runtimePolicyDenied,
  adapter_unavailable: platformErrorCodes.runtimeAdapterUnavailable,
  session_not_found: platformErrorCodes.runtimeSessionNotFound,
  session_destroyed: platformErrorCodes.resourceConflict,
  exec_failed: platformErrorCodes.runtimeExecFailed,
  exec_timeout: platformErrorCodes.runtimeExecTimeout,
  copy_failed: platformErrorCodes.serverInternal,
  log_unavailable: platformErrorCodes.serverUnavailable,
  stale_host_write_conflict: platformErrorCodes.resourceConflict,
  unsupported_staging_transport: platformErrorCodes.inputInvalidParameter,
  workspace_root_missing: platformErrorCodes.inputInvalidParameter,
  read_only_commit_denied: platformErrorCodes.runtimePolicyDenied,
  adapter_internal: platformErrorCodes.serverInternal,
};

const runtimeErrorCodeToStatus: Record<RuntimeErrorCode, number> = {
  unsupported_capability: 400,
  policy_denied: 403,
  adapter_unavailable: 503,
  session_not_found: 404,
  session_destroyed: 409,
  exec_failed: 500,
  exec_timeout: 504,
  copy_failed: 500,
  log_unavailable: 503,
  stale_host_write_conflict: 409,
  unsupported_staging_transport: 400,
  workspace_root_missing: 400,
  read_only_commit_denied: 403,
  adapter_internal: 500,
};

/**
 * Purpose:
 * Rich runtime error class that preserves retriable metadata and optional cause.
 */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retriable: boolean;
  readonly details: Record<string, unknown>;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: {
      retriable?: boolean;
      details?: Record<string, unknown>;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
    this.retriable = options.retriable ?? false;
    this.details = options.details ?? {};
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * Purpose:
   * Converts the runtime error instance into the canonical envelope shape.
   */
  toEnvelope(): RuntimeErrorEnvelope {
    return runtimeErrorEnvelopeSchema.parse({
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      details: this.details,
      retry_after_ms: this.retryAfterMs,
    });
  }
}

/**
 * Purpose:
 * Converts a runtime error into the public API error-envelope shape.
 */
export const runtimeErrorToApiEnvelope = (
  error: RuntimeError | RuntimeErrorEnvelope,
  requestId: string,
): ErrorEnvelope => {
  const envelope = error instanceof RuntimeError ? error.toEnvelope() : runtimeErrorEnvelopeSchema.parse(error);

  return {
    error: envelope.message,
    code: runtimeErrorCodeToPlatformCode[envelope.code],
    status: runtimeErrorCodeToStatus[envelope.code],
    request_id: nonEmptyStringSchema.parse(requestId),
    retry_after_ms: envelope.retry_after_ms,
  };
};
