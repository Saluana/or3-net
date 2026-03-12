import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  CreateTunnelSignedUrlRequest,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileContent,
  SandboxInfo,
  RuntimeCapacity,
  RuntimeHealth,
  RuntimeInfo,
  SandboxQuota,
  SandboxTunnel,
  SandboxTunnelSignedUrl,
  SandboxWriteFileRequest,
} from "./types.ts";

export class HttpSandboxClient implements SandboxClient {
  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  public async create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>("/v1/sandboxes", { method: "POST", body: request });
  }

  public async list(): Promise<SandboxInfo[]> {
    return this.requestJson<SandboxInfo[]>("/v1/sandboxes", { method: "GET" });
  }

  public async get(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}`, { method: "GET" });
  }

  public async delete(sandboxId: string): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}`, { method: "DELETE" });
  }

  public async start(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/start`, { method: "POST" });
  }

  public async stop(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/stop`, { method: "POST" });
  }

  public async suspend(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/suspend`, { method: "POST" });
  }

  public async resume(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}/resume`, { method: "POST" });
  }

  public async exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    return this.requestJson<SandboxExecResult>(`/v1/sandboxes/${sandboxId}/exec`, { method: "POST", body: request });
  }

  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    const response = await this.request(`/v1/sandboxes/${sandboxId}/exec?stream=1`, {
      method: "POST",
      body: request,
      headers: { Accept: "text/event-stream" },
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

  public async readFile(sandboxId: string, path: string): Promise<SandboxFileContent> {
    return this.requestJson<SandboxFileContent>(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, {
      method: "GET",
    });
  }

  public async writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(request.path)}`, {
      method: "PUT",
      body: { content: request.content },
    });
  }

  public async deleteFile(sandboxId: string, path: string): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files${normalizeFilePath(path)}`, { method: "DELETE" });
  }

  public async mkdir(sandboxId: string, path: string): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/mkdir`, {
      method: "POST",
      body: { path },
    });
  }

  public async createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    return this.requestJson<SandboxTunnel>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "POST", body: request });
  }

  public async listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    return this.requestJson<SandboxTunnel[]>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "GET" });
  }

  public async revokeTunnel(tunnelId: string): Promise<void> {
    await this.request(`/v1/tunnels/${tunnelId}`, { method: "DELETE" });
  }

  public async createSignedTunnelUrl(tunnelId: string, request: CreateTunnelSignedUrlRequest = {}): Promise<SandboxTunnelSignedUrl> {
    return this.requestJson<SandboxTunnelSignedUrl>(`/v1/tunnels/${tunnelId}/signed-url`, { method: "POST", body: request });
  }

  public async runtimeInfo(): Promise<RuntimeInfo> {
    return this.requestJson<RuntimeInfo>("/v1/runtime/info", { method: "GET" });
  }

  public async runtimeHealth(): Promise<RuntimeHealth> {
    return this.requestJson<RuntimeHealth>("/v1/runtime/health", { method: "GET" });
  }

  public async runtimeCapacity(): Promise<RuntimeCapacity> {
    return this.requestJson<RuntimeCapacity>("/v1/runtime/capacity", { method: "GET" });
  }

  public async getQuota(): Promise<SandboxQuota> {
    return this.requestJson<SandboxQuota>("/v1/quotas/me", { method: "GET" });
  }

  public async getMetrics(): Promise<string> {
    return await (await this.request("/metrics", { method: "GET" })).text();
  }

  private async request(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(new URL(path, this.options.baseUrl), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw new Error(`Sandbox request failed with status ${String(response.status)}`);
    }
    return response;
  }

  private async requestJson<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
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

const normalizeFilePath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);
