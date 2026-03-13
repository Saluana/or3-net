import { z } from "zod";
import { jsonObjectSchema, nonEmptyStringSchema } from "../../src/contracts/shared.ts";

export interface InternTurnRequest {
  readonly sessionKey: string;
  readonly message: string;
  readonly allowedTools?: string[];
  readonly meta?: Record<string, unknown>;
  readonly profileName?: string;
}

export interface InternTurnResponse {
  readonly job_id: string;
  readonly status: string;
  readonly final_text?: string;
  readonly error?: string;
}

export interface InternSubagentRequest {
  readonly parentSessionKey: string;
  readonly task: string;
  readonly promptSnapshot: Record<string, unknown>[];
  readonly allowedTools?: string[];
  readonly timeoutSeconds?: number;
  readonly meta?: Record<string, unknown>;
  readonly profileName?: string;
  readonly channel?: string;
  readonly replyTo?: string;
}

export interface InternSubagentResponse {
  readonly job_id: string;
  readonly child_session_key: string;
  readonly status: string;
}

export interface InternJobEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface InternAbortResponse {
  readonly ok: boolean;
  readonly job_id: string;
  readonly status?: string;
}

export interface InternClient {
  submitTurn(request: InternTurnRequest): Promise<InternTurnResponse>;
  submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent>;
  spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse>;
  streamJob(jobId: string): AsyncIterable<InternJobEvent>;
  abortJob(jobId: string): Promise<InternAbortResponse>;
}

export const internTurnRequestSchema = z.object({
  session_key: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  allowed_tools: z.array(nonEmptyStringSchema).optional(),
  meta: jsonObjectSchema.optional(),
  profile_name: nonEmptyStringSchema.optional(),
});

export const internTurnResponseSchema = z.object({
  job_id: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  final_text: z.string().optional(),
  error: z.string().optional(),
});

export const internJobEventSchema = z.object({
  event: nonEmptyStringSchema,
  data: jsonObjectSchema,
});

export const internAbortResponseSchema = z.object({
  ok: z.boolean(),
  job_id: nonEmptyStringSchema,
  status: nonEmptyStringSchema.optional(),
});