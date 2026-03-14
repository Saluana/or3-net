import type {
  InternAbortResponse,
  InternClient,
  InternErrorResponse,
  InternJobEvent,
  InternSubagentRequest,
  InternSubagentResponse,
  InternTurnRequest,
  InternTurnResponse,
} from "./types.ts";
import { InternRequestError } from "./types.ts";
import { encodeBase64Url, hmacSha256Hex } from "../../src/lib/crypto.ts";

interface InternClientOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetch?: typeof fetch;
}

interface ServiceTokenClaims {
  readonly iat: number;
  readonly nonce: string;
}

export class HttpInternClient implements InternClient {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: InternClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  public async submitTurn(request: InternTurnRequest): Promise<InternTurnResponse> {
    const response = await this.fetchImpl(new URL("/internal/v1/turns", this.options.baseUrl), {
      method: "POST",
      headers: await this.createHeaders({}, request.requestContext),
      body: JSON.stringify(serializeTurnRequest(request)),
    });
    return parseJsonResponse<InternTurnResponse>(response);
  }

  public async *submitTurnStream(request: InternTurnRequest): AsyncIterable<InternJobEvent> {
    const response = await this.fetchImpl(new URL("/internal/v1/turns", this.options.baseUrl), {
      method: "POST",
      headers: await this.createHeaders({ Accept: "text/event-stream" }, request.requestContext),
      body: JSON.stringify(serializeTurnRequest(request)),
    });
    yield* parseEventStream(response);
  }

  public async spawnSubagent(request: InternSubagentRequest): Promise<InternSubagentResponse> {
    const response = await this.fetchImpl(new URL("/internal/v1/subagents", this.options.baseUrl), {
      method: "POST",
      headers: await this.createHeaders({}, request.requestContext),
      body: JSON.stringify(serializeSubagentRequest(request)),
    });
    return parseJsonResponse<InternSubagentResponse>(response);
  }

  public async *streamJob(jobId: string): AsyncIterable<InternJobEvent> {
    const response = await this.fetchImpl(new URL(`/internal/v1/jobs/${jobId}/stream`, this.options.baseUrl), {
      method: "GET",
      headers: await this.createHeaders({ Accept: "text/event-stream" }),
    });
    yield* parseEventStream(response);
  }

  public async abortJob(jobId: string): Promise<InternAbortResponse> {
    const response = await this.fetchImpl(new URL(`/internal/v1/jobs/${jobId}/abort`, this.options.baseUrl), {
      method: "POST",
      headers: await this.createHeaders(),
    });
    return parseJsonResponse<InternAbortResponse>(response);
  }

  private async createHeaders(extra: Record<string, string> = {}, requestContext?: InternTurnRequest["requestContext"]): Promise<Headers> {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${await issueServiceBearerToken(this.options.secret)}`);
    headers.set("Content-Type", "application/json");
    if (requestContext?.requestId !== undefined && requestContext.requestId.trim() !== "") {
      headers.set("X-Request-Id", requestContext.requestId);
    }
    if (requestContext?.workspaceId !== undefined && requestContext.workspaceId.trim() !== "") {
      headers.set("X-Workspace-Id", requestContext.workspaceId);
    }
    if (requestContext?.networkSessionId !== undefined && requestContext.networkSessionId.trim() !== "") {
      headers.set("X-Network-Session-Id", requestContext.networkSessionId);
    }
    return headers;
  }
}

const issueServiceBearerToken = async (secret: string, now = new Date()): Promise<string> => {
  const claims: ServiceTokenClaims = {
    iat: Math.floor(now.getTime() / 1000),
    nonce: crypto.randomUUID().replaceAll("-", ""),
  };
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = await hmacSha256Hex(secret, payload);
  return `${payload}.${signature}`;
};

const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw await toInternRequestError(response, "Intern request failed");
  }
  return (await response.json()) as T;
};

const parseEventStream = async function* (response: Response): AsyncIterable<InternJobEvent> {
  if (!response.ok) {
    throw await toInternRequestError(response, "Intern stream failed");
  }
  if (response.body === null) {
    throw new Error("Intern stream response missing body");
  }

  const body = response.body as ReadableStream<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const value of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseEventFrame(frame);
      if (event !== null) {
        yield event;
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim() !== "") {
    const event = parseEventFrame(buffer);
    if (event !== null) {
      yield event;
    }
  }
};

const parseEventFrame = (frame: string): InternJobEvent | null => {
  const lines = frame.split("\n");
  let eventType: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (eventType === null || dataLines.length === 0) {
    return null;
  }

  return {
    event: eventType,
    data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>,
  };
};

const serializeTurnRequest = (request: InternTurnRequest): Record<string, unknown> => ({
  session_key: request.sessionKey,
  ...(request.platformSessionRef === undefined ? {} : { platform_session_ref: request.platformSessionRef }),
  message: request.message,
  ...(request.allowedTools === undefined ? {} : { allowed_tools: request.allowedTools }),
  ...(request.meta === undefined ? {} : { meta: request.meta }),
  ...(request.profileName === undefined ? {} : { profile_name: request.profileName }),
});

const serializeSubagentRequest = (request: InternSubagentRequest): Record<string, unknown> => ({
  parent_session_key: request.parentSessionKey,
  task: request.task,
  prompt_snapshot: request.promptSnapshot,
  ...(request.allowedTools === undefined ? {} : { allowed_tools: request.allowedTools }),
  ...(request.timeoutSeconds === undefined ? {} : { timeout_seconds: request.timeoutSeconds }),
  ...(request.meta === undefined ? {} : { meta: request.meta }),
  ...(request.profileName === undefined ? {} : { profile_name: request.profileName }),
  ...(request.channel === undefined ? {} : { channel: request.channel }),
  ...(request.replyTo === undefined ? {} : { reply_to: request.replyTo }),
});

const toInternRequestError = async (response: Response, prefix: string): Promise<InternRequestError> => {
  let payload: InternErrorResponse | undefined;
  try {
    payload = (await response.clone().json()) as InternErrorResponse;
  } catch {
    payload = undefined;
  }
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfterMs = retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10) * 1_000;
  return new InternRequestError(
    payload?.error ?? `${prefix} with status ${String(response.status)}`,
    response.status,
    payload,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  );
};
