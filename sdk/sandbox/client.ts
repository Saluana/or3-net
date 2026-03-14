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

interface SandboxRequestInit {
  readonly method: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly requestContext?: SandboxRequestContext | undefined;
}

export class HttpSandboxClient implements SandboxClient {
  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  public async create(request: CreateSandboxRequest, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>("/v1/sandboxes", { method: "POST", body: request, requestContext });
  }

  public async list(requestContext?: SandboxRequestContext): Promise<SandboxInfo[]> {
    return this.requestJson<SandboxInfo[]>("/v1/sandboxes", { method: "GET", requestContext });
  }

  public async get(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}`, { method: "GET", requestContext });
  }

  public async delete(sandboxId: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}`, { method: "DELETE", requestContext });
  }

  public async start(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/start`, { method: "POST", requestContext });
  }

  public async stop(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/stop`, { method: "POST", requestContext });
  }

  public async suspend(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/suspend`, { method: "POST", requestContext });
  }

  public async resume(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/resume`, { method: "POST", requestContext });
  }

  public async exec(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): Promise<SandboxExecResult> {
    return this.requestJson<SandboxExecResult>(`/v1/sandboxes/${sandboxId}/exec`, { method: "POST", body: request, requestContext });
  }

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

  public async readFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<SandboxFileContent> {
    return this.requestJson<SandboxFileContent>(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, {
      method: "GET",
		requestContext,
    });
  }

  public async writeFile(sandboxId: string, request: SandboxWriteFileRequest, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(request.path)}`, {
      method: "PUT",
      body: { content: request.content },
		requestContext,
    });
  }

  public async deleteFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, { method: "DELETE", requestContext });
  }

  public async mkdir(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/mkdir`, {
      method: "POST",
      body: { path },
		requestContext,
    });
  }

  public async createTunnel(sandboxId: string, request: CreateTunnelRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnel> {
    return this.requestJson<SandboxTunnel>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "POST", body: request, requestContext });
  }

  public async listTunnels(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxTunnel[]> {
    return this.requestJson<SandboxTunnel[]>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "GET", requestContext });
  }

  public async revokeTunnel(tunnelId: string, requestContext?: SandboxRequestContext): Promise<void> {
    await this.request(`/v1/tunnels/${tunnelId}`, { method: "DELETE", requestContext });
  }

  public async createSignedTunnelUrl(tunnelId: string, request: CreateTunnelSignedUrlRequest = {}, requestContext?: SandboxRequestContext): Promise<SandboxTunnelSignedUrl> {
    return this.requestJson<SandboxTunnelSignedUrl>(`/v1/tunnels/${tunnelId}/signed-url`, { method: "POST", body: request, requestContext });
  }

  public async runtimeInfo(requestContext?: SandboxRequestContext): Promise<RuntimeInfo> {
    return this.requestJson<RuntimeInfo>("/v1/runtime/info", { method: "GET", requestContext });
  }

  public async runtimeHealth(requestContext?: SandboxRequestContext): Promise<RuntimeHealth> {
    return this.requestJson<RuntimeHealth>("/v1/runtime/health", { method: "GET", requestContext });
  }

  public async runtimeCapacity(requestContext?: SandboxRequestContext): Promise<RuntimeCapacity> {
    return this.requestJson<RuntimeCapacity>("/v1/runtime/capacity", { method: "GET", requestContext });
  }

  public async getQuota(requestContext?: SandboxRequestContext): Promise<SandboxQuota> {
    return this.requestJson<SandboxQuota>("/v1/quotas/me", { method: "GET", requestContext });
  }

  public async getMetrics(requestContext?: SandboxRequestContext): Promise<string> {
    return await (await this.request("/metrics", { method: "GET", requestContext })).text();
  }

  private async request(path: string, init: SandboxRequestInit): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const requestHeaders: Record<string, string> = {
		Authorization: `Bearer ${this.options.token}`,
		...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
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
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw await toSandboxRequestError(response, "Sandbox request failed");
    }
    return response;
  }

  private async requestJson<T>(path: string, init: SandboxRequestInit): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
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
