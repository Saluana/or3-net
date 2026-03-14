import type { StoredNetworkSession } from "../../db/index.ts";
import type { JobStreamEvent } from "../protocol.ts";
import { platformErrorCodes, type PlatformErrorCode } from "./error-codes.ts";
import type { ErrorEnvelope, PlatformSessionRef } from "./types.ts";
import type { PlatformStreamEvent } from "./stream-events.ts";
import { isRemoteExecutionError } from "../../nodes/transport.ts";
import { InternRequestError } from "../../../sdk/intern/types.ts";
import { SandboxRequestError } from "../../../sdk/sandbox/types.ts";

export interface CreateErrorEnvelopeInput {
  readonly error: string;
  readonly code?: PlatformErrorCode;
  readonly status: number;
  readonly request_id: string;
  readonly retry_after_ms?: number | undefined;
}

export const createErrorEnvelope = (input: CreateErrorEnvelopeInput): ErrorEnvelope => ({
  error: input.error,
  code: input.code ?? defaultErrorCodeForStatus(input.status),
  status: input.status,
  request_id: input.request_id,
  ...(input.retry_after_ms === undefined ? {} : { retry_after_ms: input.retry_after_ms }),
});

export const toPlatformSessionRef = (session: StoredNetworkSession): PlatformSessionRef => ({
  workspace_id: session.workspace_id,
  client_kind: normalizeClientKind(session.client_kind),
  client_session_id: session.client_session_id ?? session.network_session_id,
  network_session_id: session.network_session_id,
  session_key: session.intern_session_key,
});

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

const defaultErrorCodeForStatus = (status: number): PlatformErrorCode => {
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

export const normalizeSandboxError = (error: unknown, request_id: string): ErrorEnvelope => {
  if (error instanceof SandboxRequestError) {
    return createErrorEnvelope({
      error: error.message,
      status: error.status,
      request_id,
      code: sandboxCodeToPlatformErrorCode(error.response?.code, error.status),
      ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
    });
  }
  return createErrorEnvelope({
    error: error instanceof Error ? error.message : "Sandbox request failed",
    status: 500,
    request_id,
    code: platformErrorCodes.serverInternal,
  });
};

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

const sandboxCodeToPlatformErrorCode = (code: string | undefined, status: number): PlatformErrorCode => {
  switch (code) {
    case undefined:
      return defaultErrorCodeForStatus(status);
    case "unauthorized":
      return platformErrorCodes.authTokenInvalid;
    case "forbidden":
      return platformErrorCodes.authInsufficientScope;
    case "not_found":
      return platformErrorCodes.resourceNotFound;
    case "conflict":
      return platformErrorCodes.resourceConflict;
    case "invalid_request":
    case "payload_too_large":
      return platformErrorCodes.inputInvalidParameter;
    case "rate_limited":
      return platformErrorCodes.rateLimitExceeded;
    case "bad_gateway":
      return platformErrorCodes.serverUnavailable;
    default:
      return defaultErrorCodeForStatus(status);
  }
};
