/**
 * @module sdk/sandbox/client
 *
 * Purpose:
 * HTTP implementation of the sandbox SDK. Wraps sandbox lifecycle, execution,
 * filesystem, tunnel, and runtime endpoints behind a typed client.
 *
 * Constraints:
 * - Uses bearer-token auth for every request
 * - Stream parsing assumes SSE-style framing for exec streams
 */
import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  CreateTunnelSignedUrlRequest,
  SandboxClient,
  SandboxErrorResponse,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileContent,
  SandboxInfo,
  SandboxRequestContext,
  RuntimeCapacity,
  RuntimeHealth,
  RuntimeInfo,
  SandboxQuota,
  SandboxTunnel,
  SandboxTunnelSignedUrl,
  SandboxWriteFileRequest,
} from "./types.ts";
import { SandboxRequestError } from "./types.ts";

/** Purpose: Internal request options shared by the sandbox HTTP client methods. */
interface SandboxRequestInit {
  readonly method: string;
  readonly body?: unknown;
  readonly rawBody?: ArrayBuffer | Blob | FormData | string | Uint8Array | URLSearchParams;
  readonly headers?: Record<string, string>;
  readonly requestContext?: SandboxRequestContext | undefined;
}

/**
 * Purpose:
 * Talks to the sandbox HTTP API using a static bearer token.
 *
 * Behavior:
 * Sends JSON by default, supports raw byte uploads for archive import, and
 * normalizes failed responses into `SandboxRequestError`.
 *
 * @example
 * ```ts
 * const client = new HttpSandboxClient({
 *   baseUrl: 'http://127.0.0.1:8080',
 *   token: process.env.SANDBOX_TOKEN!,
 * });
 * ```
 */
export class HttpSandboxClient implements SandboxClient {
  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  /** Purpose: Creates a sandbox instance. */
  public async create(request: CreateSandboxRequest, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>("/v1/sandboxes", { method: "POST", body: request, requestContext });
  }

  /** Purpose: Lists visible sandbox instances. */
  public async list(requestContext?: SandboxRequestContext): Promise<SandboxInfo[]> {
    return this.requestJson<SandboxInfo[]>("/v1/sandboxes", { method: "GET", requestContext });
  }

  /** Purpose: Fetches a single sandbox descriptor. */
  public async get(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}`, { method: "GET", requestContext });
  }

  /** Purpose: Deletes a sandbox instance. */
  public async delete(sandboxId: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}`, { method: "DELETE", requestContext });
  }

  /** Purpose: Starts a sandbox instance. */
  public async start(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/start`, { method: "POST", requestContext });
  }

  /** Purpose: Stops a sandbox instance. */
  public async stop(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/stop`, { method: "POST", requestContext });
  }

  /** Purpose: Suspends a sandbox instance. */
  public async suspend(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/suspend`, { method: "POST", requestContext });
  }

  /** Purpose: Resumes a suspended sandbox instance. */
  public async resume(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/resume`, { method: "POST", requestContext });
  }

  /** Purpose: Executes a command in a sandbox and waits for the final result. */
  public async exec(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): Promise<SandboxExecResult> {
    return this.requestJson<SandboxExecResult>(`/v1/sandboxes/${sandboxId}/exec`, { method: "POST", body: request, requestContext });
  }

  /** Purpose: Executes a command in a sandbox and yields streamed exec events. */
  public async *execStream(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): AsyncIterable<SandboxExecEvent> {
    const response = await this.request(`/v1/sandboxes/${sandboxId}/exec?stream=1`, {
      method: "POST",
      body: request,
      headers: { Accept: "text/event-stream" },
      requestContext,
    });
    if (response.body === null) {
      throw new Error("Sandbox stream response missing body");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const value of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event !== null) {
          yield event;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const event = parseSseFrame(buffer);
      if (event !== null) {
        yield event;
      }
    }
  }

  /** Purpose: Reads a file from a sandbox filesystem. */
  public async readFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<SandboxFileContent> {
    return this.requestJson<SandboxFileContent>(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, {
      method: "GET",
		requestContext,
    });
  }

  /** Purpose: Writes a file into a sandbox filesystem. */
  public async writeFile(sandboxId: string, request: SandboxWriteFileRequest, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(request.path)}`, {
      method: "PUT",
      body: { content: request.content },
		requestContext,
    });
  }

  /** Purpose: Deletes a file from a sandbox filesystem. */
  public async deleteFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, { method: "DELETE", requestContext });
  }

  /** Purpose: Creates a directory within a sandbox filesystem. */
  public async mkdir(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/mkdir`, {
      method: "POST",
      body: { path },
		requestContext,
    });
  }

  /** Purpose: Uploads a workspace archive into a sandbox. */
  public async importWorkspaceArchive(sandboxId: string, archive: Uint8Array, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/workspace-import`, {
      method: "POST",
      rawBody: archive,
      headers: { "Content-Type": "application/gzip" },
      requestContext,
    });
  }

  /** Purpose: Exports selected workspace content from a sandbox as bytes. */
  public async exportWorkspaceArchive(
    sandboxId: string,
    request: { paths?: string[] } = {},
    requestContext?: SandboxRequestContext,
  ): Promise<Uint8Array> {
    return this.requestBytes(`/v1/sandboxes/${sandboxId}/workspace-export`, {
      method: "POST",
      body: request,
      requestContext,
    });
  }

  /** Purpose: Creates a new tunnel for a sandbox service port. */
  public async createTunnel(sandboxId: string, request: CreateTunnelRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnel> {
    return this.requestJson<SandboxTunnel>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "POST", body: request, requestContext });
  }

  /** Purpose: Lists tunnels attached to a sandbox. */
  public async listTunnels(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxTunnel[]> {
    return this.requestJson<SandboxTunnel[]>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "GET", requestContext });
  }

  /** Purpose: Revokes an existing tunnel. */
  public async revokeTunnel(tunnelId: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/tunnels/${tunnelId}`, { method: "DELETE", requestContext });
  }

  /** Purpose: Mints a signed URL for a private tunnel. */
  public async createSignedTunnelUrl(tunnelId: string, request: CreateTunnelSignedUrlRequest = {}, requestContext?: SandboxRequestContext): Promise<SandboxTunnelSignedUrl> {
    return this.requestJson<SandboxTunnelSignedUrl>(`/v1/tunnels/${tunnelId}/signed-url`, { method: "POST", body: request, requestContext });
  }

  /** Purpose: Fetches general runtime information from the sandbox service. */
  public async runtimeInfo(requestContext?: SandboxRequestContext): Promise<RuntimeInfo> {
    return this.requestJson<RuntimeInfo>("/v1/runtime/info", { method: "GET", requestContext });
  }

  /** Purpose: Fetches runtime health from the sandbox service. */
  public async runtimeHealth(requestContext?: SandboxRequestContext): Promise<RuntimeHealth> {
    return this.requestJson<RuntimeHealth>("/v1/runtime/health", { method: "GET", requestContext });
  }

  /** Purpose: Fetches runtime capacity from the sandbox service. */
  public async runtimeCapacity(requestContext?: SandboxRequestContext): Promise<RuntimeCapacity> {
    return this.requestJson<RuntimeCapacity>("/v1/runtime/capacity", { method: "GET", requestContext });
  }

  /** Purpose: Fetches the caller's sandbox quota information. */
  public async getQuota(requestContext?: SandboxRequestContext): Promise<SandboxQuota> {
    return this.requestJson<SandboxQuota>("/v1/quotas/me", { method: "GET", requestContext });
  }

  /** Purpose: Fetches raw Prometheus-style metrics text from the sandbox service. */
  public async getMetrics(requestContext?: SandboxRequestContext): Promise<string> {
    return await (await this.request("/metrics", { method: "GET", requestContext })).text();
  }

  private async request(path: string, init: SandboxRequestInit): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const hasRawBody = init.rawBody !== undefined;
    const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${this.options.token}`,
    ...(init.body === undefined || hasRawBody ? {} : { "Content-Type": "application/json" }),
    ...(init.headers ?? {}),
  };
  if (init.requestContext?.requestId !== undefined && init.requestContext.requestId.trim() !== "") {
    requestHeaders["X-Request-Id"] = init.requestContext.requestId;
  }
  if (init.requestContext?.workspaceId !== undefined && init.requestContext.workspaceId.trim() !== "") {
    requestHeaders["X-Workspace-Id"] = init.requestContext.workspaceId;
  }
    const response = await fetchImpl(new URL(path, this.options.baseUrl), {
      method: init.method,
      headers: requestHeaders,
    ...(hasRawBody ? { body: init.rawBody } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw await toSandboxRequestError(response, "Sandbox request failed");
    }
    return response;
  }

  private async requestJson<T>(path: string, init: SandboxRequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  private async requestBytes(path: string, init: SandboxRequestInit): Promise<Uint8Array> {
    const buffer = await (await this.request(path, init)).arrayBuffer();
    return new Uint8Array(buffer);
  }
}

const parseSseFrame = (frame: string): SandboxExecEvent | null => {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (event === null || dataLines.length === 0) {
    return null;
  }
  const rawData = dataLines.join("\n");
  if (event === "stdout" || event === "stderr") {
    return { event, data: { chunk: rawData } };
  }
  return { event, data: JSON.parse(rawData) as Record<string, unknown> };
};

const toSandboxRequestError = async (response: Response, prefix: string): Promise<SandboxRequestError> => {
  let payload: SandboxErrorResponse | undefined;
  try {
    payload = (await response.clone().json()) as SandboxErrorResponse;
  } catch {
    payload = undefined;
  }
  const retryAfterHeader = response.headers.get("Retry-After");
  const retryAfterMs = retryAfterHeader === null ? undefined : Number.parseInt(retryAfterHeader, 10) * 1_000;
  return new SandboxRequestError(
    payload?.error ?? `${prefix} with status ${String(response.status)}`,
    response.status,
    payload,
    Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
  );
};

const normalizeFilePath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);
