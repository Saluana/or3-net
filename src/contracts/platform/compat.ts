/**
 * @module src/contracts/platform/compat
 *
 * Purpose:
 * Compatibility helpers that normalize internal runtime state and transport
 * errors into the stable platform contract surface.
 *
 * Responsibilities:
 * - Build error envelopes from transport-specific failures
 * - Convert stored session rows into public platform session references
 * - Normalize legacy job stream events into platform stream events
 */
import type { StoredNetworkSession } from "../../db/index.ts";
import type { JobStreamEvent } from "../protocol.ts";
import { platformErrorCodes, type PlatformErrorCode } from "./error-codes.ts";
import type { ErrorEnvelope, PlatformSessionRef } from "./types.ts";
import type { PlatformStreamEvent } from "./stream-events.ts";
import { isRemoteExecutionError } from "../../nodes/transport.ts";
import { InternRequestError } from "../../../sdk/intern/types.ts";
import { isProviderRequestErrorLike as isOpenSandboxProviderRequestErrorLike } from "../../../sdk/opensandbox/types.ts";
import { isProviderRequestErrorLike as isCloudflareSandboxProviderRequestErrorLike } from "../../../sdk/cloudflare-sandbox/types.ts";

/**
 * Purpose:
 * Input required to build a platform error envelope.
 */
export interface CreateErrorEnvelopeInput {
  readonly error: string;
  readonly code?: PlatformErrorCode;
  readonly status: number;
  readonly request_id: string;
  readonly retry_after_ms?: number | undefined;
}

/**
 * Purpose:
 * Creates a normalized platform error envelope with a default code when the
 * caller omits one.
 */
export const createErrorEnvelope = (input: CreateErrorEnvelopeInput): ErrorEnvelope => ({
  error: input.error,
  code: input.code ?? defaultErrorCodeForStatus(input.status),
  status: input.status,
  request_id: input.request_id,
  ...(input.retry_after_ms === undefined ? {} : { retry_after_ms: input.retry_after_ms }),
});

/**
 * Purpose:
 * Maps a stored network-session row to the public `PlatformSessionRef` shape.
 */
export const toPlatformSessionRef = (session: StoredNetworkSession): PlatformSessionRef => ({
  workspace_id: session.workspace_id,
  client_kind: normalizeClientKind(session.client_kind),
  client_session_id: session.client_session_id ?? session.network_session_id,
  network_session_id: session.network_session_id,
  session_key: session.intern_session_key,
});

/**
 * Purpose:
 * Normalizes legacy node job-stream events into the platform event contract.
 *
 * Non-Goals:
 * - Does not preserve transport-specific fields that are not part of the public
 *   platform stream surface
 */
export const normalizeLegacyJobStreamEvent = (event: JobStreamEvent): PlatformStreamEvent => {
  switch (event.event) {
    case "job.accepted":
      return event;
    case "job.started":
      return {
        event: "job.started",
        data: {
          job_id: event.data.job_id,
        },
      };
    case "text.delta":
      return {
        event: "text.delta",
        data: { text: event.data.text },
      };
    case "tool.call":
      return {
        event: "tool.call",
        data: { name: event.data.name },
      };
    case "tool.result":
      return {
        event: "tool.result",
        data: { name: event.data.name, result: event.data.result },
      };
    case "job.completed":
      return {
        event: "job.completed",
        data: event.data,
      };
    case "job.aborted":
      return event;
    case "job.failed":
      return {
        event: "job.failed",
        data: event.data,
      };
  }
};

/**
 * Purpose:
 * Chooses the default platform error code for an HTTP status code.
 */
export const defaultErrorCodeForStatus = (status: number): PlatformErrorCode => {
  switch (status) {
    case 400:
      return platformErrorCodes.inputInvalidParameter;
    case 401:
      return platformErrorCodes.authTokenInvalid;
    case 403:
      return platformErrorCodes.authInsufficientScope;
    case 404:
      return platformErrorCodes.resourceNotFound;
    case 409:
      return platformErrorCodes.resourceConflict;
    case 429:
      return platformErrorCodes.rateLimitExceeded;
    case 503:
      return platformErrorCodes.serverUnavailable;
    default:
      return platformErrorCodes.serverInternal;
  }
};

/**
 * Purpose:
 * Converts errors from the intern SDK and remote execution path into the public
 * platform error envelope shape.
 */
export const normalizeInternError = (error: unknown, request_id: string): ErrorEnvelope => {
  if (error instanceof InternRequestError) {
    return createErrorEnvelope({
      error: error.message,
      status: error.status,
      request_id,
      ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
    });
  }
  if (isRemoteExecutionError(error)) {
    const status = error.code === "remote_execution_failed" ? 500 : 503;
    return createErrorEnvelope({
      error: error.message,
      status,
      request_id,
      code: status === 500 ? platformErrorCodes.serverInternal : platformErrorCodes.serverUnavailable,
    });
  }
  return createErrorEnvelope({
    error: error instanceof Error ? error.message : "Intern request failed",
    status: 500,
    request_id,
    code: platformErrorCodes.serverInternal,
  });
};

/**
 * Purpose:
 * Converts sandbox SDK request failures into the public platform error-envelope
 * shape.
 */
export const normalizeProviderRequestError = (error: unknown, request_id: string): ErrorEnvelope => {
  if (isKnownProviderRequestError(error)) {
    return createErrorEnvelope({
      error: error.message,
      status: error.status,
      request_id,
      code: providerCodeToPlatformErrorCode(error.code, error.status),
      ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
    });
  }
  return createErrorEnvelope({
    error: error instanceof Error ? error.message : "Provider request failed",
    status: 500,
    request_id,
    code: platformErrorCodes.serverInternal,
  });
};

const isKnownProviderRequestError = (error: unknown): error is {
  readonly message: string;
  readonly status: number;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
} => isOpenSandboxProviderRequestErrorLike(error) || isCloudflareSandboxProviderRequestErrorLike(error);

const normalizeClientKind = (value: string): PlatformSessionRef["client_kind"] => {
  switch (value) {
    case "chat":
    case "cli":
    case "sdk":
    case "console":
    case "legacy":
      return value;
    default:
      return "legacy";
  }
};

const providerCodeToPlatformErrorCode = (code: string | undefined, status: number): PlatformErrorCode => {
  switch (code) {
    case undefined:
      return defaultErrorCodeForStatus(status);
    case "invalid_argument":
    case "unauthorized":
      return platformErrorCodes.authTokenInvalid;
    case "forbidden":
      return platformErrorCodes.authInsufficientScope;
    case "not_found":
      return platformErrorCodes.resourceNotFound;
    case "already_exists":
    case "conflict":
      return platformErrorCodes.resourceConflict;
    case "invalid_request":
    case "payload_too_large":
      return platformErrorCodes.inputInvalidParameter;
    case "resource_exhausted":
    case "rate_limited":
      return platformErrorCodes.rateLimitExceeded;
    case "unavailable":
    case "bad_gateway":
      return platformErrorCodes.serverUnavailable;
    default:
      return defaultErrorCodeForStatus(status);
  }
};
