import type { StoredNetworkSession } from "../../db/index.ts";
import type { JobStreamEvent } from "../protocol.ts";
import { platformErrorCodes, type PlatformErrorCode } from "./error-codes.ts";
import type { ErrorEnvelope, PlatformSessionRef } from "./types.ts";
import type { PlatformStreamEvent } from "./stream-events.ts";

export interface CreateErrorEnvelopeInput {
  readonly error: string;
  readonly code?: PlatformErrorCode;
  readonly status: number;
  readonly request_id: string;
  readonly retry_after_ms?: number;
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
