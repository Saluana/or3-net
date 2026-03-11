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