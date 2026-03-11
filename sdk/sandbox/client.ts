import type {
  CreateSandboxRequest,
  CreateTunnelRequest,
  SandboxClient,
  SandboxExecEvent,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInfo,
  SandboxTunnel,
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

  public async get(sandboxId: string): Promise<SandboxInfo> {
    return this.requestJson<SandboxInfo>(`/v1/sandboxes/${sandboxId}`, { method: "GET" });
  }

  public async delete(sandboxId: string): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}`, { method: "DELETE" });
  }

  public async exec(sandboxId: string, request: SandboxExecRequest): Promise<SandboxExecResult> {
    return this.requestJson<SandboxExecResult>(`/v1/sandboxes/${sandboxId}/exec`, { method: "POST", body: request });
  }

  public async *execStream(sandboxId: string, request: SandboxExecRequest): AsyncIterable<SandboxExecEvent> {
    const response = await this.request(`/v1/sandboxes/${sandboxId}/exec`, {
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

  public async writeFile(sandboxId: string, request: SandboxWriteFileRequest): Promise<void> {
    await this.request(`/v1/sandboxes/${sandboxId}/files/write`, { method: "POST", body: request });
  }

  public async createTunnel(sandboxId: string, request: CreateTunnelRequest): Promise<SandboxTunnel> {
    return this.requestJson<SandboxTunnel>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "POST", body: request });
  }

  public async listTunnels(sandboxId: string): Promise<SandboxTunnel[]> {
    return this.requestJson<SandboxTunnel[]>(`/v1/sandboxes/${sandboxId}/tunnels`, { method: "GET" });
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
  return { event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
};
