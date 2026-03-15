/**
 * @module sdk/intern/types
 *
 * Purpose:
 * Shared request, response, streaming, and error contracts for the Intern SDK.
 *
 * Responsibilities:
 * - Define the stable client-facing request/response shapes
 * - Provide lightweight runtime validation schemas for API payloads
 * - Establish the request-context headers the HTTP client can propagate
 */
import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema } from "../../src/contracts/shared.ts";
import { platformSessionRefSchema, type PlatformSessionRef } from "../../src/contracts/platform/types.ts";

/** Purpose: Request-scoped metadata propagated as Intern HTTP headers. */
export interface InternRequestContext {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly networkSessionId?: string;
}

/** Purpose: Input payload for a top-level Intern turn request. */
export interface InternTurnRequest {
  readonly sessionKey: string;
  readonly platformSessionRef?: PlatformSessionRef;
  readonly requestContext?: InternRequestContext;
  readonly message: string;
  readonly allowedTools?: string[];
  readonly meta?: Record<string, unknown>;
  readonly profileName?: string;
}

/** Purpose: Response returned after a turn is accepted or completed. */
export interface InternTurnResponse {
  readonly job_id: string;
  readonly status: string;
  readonly final_text?: string;
  readonly error?: string;
}

/** Purpose: Input payload for spawning a delegated Intern subagent. */
export interface InternSubagentRequest {
  readonly parentSessionKey: string;
  readonly task: string;
  readonly promptSnapshot: Record<string, unknown>[];
  readonly requestContext?: InternRequestContext;
  readonly allowedTools?: string[];
  readonly timeoutSeconds?: number;
  readonly meta?: Record<string, unknown>;
  readonly profileName?: string;
  readonly channel?: string;
  readonly replyTo?: string;
}

/** Purpose: Response returned after a subagent request is accepted. */
export interface InternSubagentResponse {
  readonly job_id: string;
  readonly child_session_key: string;
  readonly status: string;
}

/** Purpose: Incremental event emitted by Intern job streams. */
export interface InternJobEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Purpose: Response returned after an Intern job abort attempt. */
export interface InternAbortResponse {
  readonly ok: boolean;
  readonly job_id: string;
  readonly status?: string;
}

/** Purpose: Error payload shape returned by Intern HTTP endpoints. */
export interface InternErrorResponse {
  readonly error?: string;
  readonly code?: string;
  readonly status?: number;
}

/**
 * Purpose:
 * Rich error thrown by the Intern SDK when an HTTP request fails.
 *
 * Behavior:
 * Preserves response status, parsed error payload, and retry timing when the
 * server provides `Retry-After`.
 */
export class InternRequestError extends Error {
  public override readonly name = "InternRequestError";

  public constructor(
    message: string,
    public readonly status: number,
    public readonly response?: InternErrorResponse,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Purpose: Detects request failures that mean subagent support is unavailable. */
export const isInternSubagentsUnavailable = (error: unknown): error is InternRequestError =>
  error instanceof InternRequestError && (error.status === 404 || error.status === 503);

/**
 * Purpose:
 * Transport-neutral client interface for the Intern service.
 */
export interface InternClient {
  submitTurn(request: InternTurnRequest): Promise<InternTurnResponse>;
  submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent>;
  spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse>;
  streamJob(jobId: string): AsyncIterable<InternJobEvent>;
  abortJob(jobId: string): Promise<InternAbortResponse>;
}

/** Purpose: Wire schema for serialized turn requests. */
export const internTurnRequestSchema = z.object({
  session_key: nonEmptyStringSchema,
  platform_session_ref: platformSessionRefSchema.optional(),
  message: nonEmptyStringSchema,
  allowed_tools: z.array(nonEmptyStringSchema).optional(),
  meta: jsonObjectSchema.optional(),
  profile_name: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for turn responses. */
export const internTurnResponseSchema = z.object({
  job_id: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  final_text: z.string().optional(),
  error: z.string().optional(),
});

/** Purpose: Wire schema for streamed Intern job events. */
export const internJobEventSchema = z.object({
  event: nonEmptyStringSchema,
  data: jsonObjectSchema,
});

/** Purpose: Wire schema for job abort responses. */
export const internAbortResponseSchema = z.object({
  ok: z.boolean(),
  job_id: nonEmptyStringSchema,
  status: nonEmptyStringSchema.optional(),
});