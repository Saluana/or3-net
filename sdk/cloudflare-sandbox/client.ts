import {
  CloudflareSandboxRequestError,
  type CloudflareSandboxClient,
  type CloudflareSandboxClientConfig,
  type CloudflareSandboxConnection,
  type CloudflareSandboxCreateRequest,
  type CloudflareSandboxExecOptions,
  type CloudflareSandboxExecResult,
  type CloudflareSandboxInfo,
  type CloudflareSandboxPortInfo,
  type CloudflareSandboxProcessInfo,
  type CloudflareSandboxProcessStartOptions,
  type CloudflareSandboxProcessStartResult,
  type CloudflareSandboxWaitForPortOptions,
} from "./types.ts";

interface BridgeSuccessEnvelope<T> {
  readonly ok: true;
  readonly result: T;
}

interface BridgeErrorEnvelope {
  readonly ok: false;
  readonly error: string;
  readonly code?: string;
  readonly status?: number;
  readonly retry_after_ms?: number;
  readonly details?: Record<string, unknown>;
}

export interface HttpCloudflareSandboxClientOptions extends CloudflareSandboxClientConfig {
  readonly fetch?: typeof fetch;
}

export class HttpCloudflareSandboxClient implements CloudflareSandboxClient {
  private readonly fetchImpl: typeof fetch;

  public constructor(public readonly config: HttpCloudflareSandboxClientOptions) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  public async create(input: CloudflareSandboxCreateRequest): Promise<CloudflareSandboxConnection> {
    const result = await this.request<CloudflareSandboxInfo>("POST", "/sandboxes", input);
    return new HttpCloudflareSandboxConnection(this, result.id);
  }

  public async connect(instanceId: string): Promise<CloudflareSandboxConnection> {
    await this.get(instanceId);
    return new HttpCloudflareSandboxConnection(this, instanceId);
  }

  public get(instanceId: string): Promise<CloudflareSandboxInfo> {
    return this.request("GET", `/sandboxes/${encodeURIComponent(instanceId)}`);
  }

  public health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }> {
    return this.request("GET", "/health");
  }

  public pause(instanceId: string): Promise<void> {
    return this.request("POST", `/sandboxes/${encodeURIComponent(instanceId)}/pause`);
  }

  public async resume(instanceId: string): Promise<CloudflareSandboxConnection> {
    await this.request("POST", `/sandboxes/${encodeURIComponent(instanceId)}/resume`);
    return new HttpCloudflareSandboxConnection(this, instanceId);
  }

  public kill(instanceId: string): Promise<void> {
    return this.request("DELETE", `/sandboxes/${encodeURIComponent(instanceId)}`);
  }

  public request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestBridge<T>({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      fetchImpl: this.fetchImpl,
      method,
      path,
      body,
      ...(this.config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.config.requestTimeoutMs }),
    });
  }
}

class HttpCloudflareSandboxConnection implements CloudflareSandboxConnection {
  public constructor(
    private readonly client: HttpCloudflareSandboxClient,
    public readonly instance_id: string,
  ) {}

  public exec(command: string, options: CloudflareSandboxExecOptions = {}): Promise<CloudflareSandboxExecResult> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/exec`, {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.stream === undefined ? {} : { stream: options.stream }),
    });
  }

  public writeFiles(entries: { readonly path: string; readonly data: string }[]): Promise<void> {
    return this.client.request("PUT", `/sandboxes/${encodeURIComponent(this.instance_id)}/files`, {
      entries,
    });
  }

  public readFile(path: string): Promise<string> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/files/read`, { path });
  }

  public createDirectories(paths: { readonly path: string }[]): Promise<void> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/mkdir`, { paths });
  }

  public startProcess(
    command: string,
    options: CloudflareSandboxProcessStartOptions = {},
  ): Promise<CloudflareSandboxProcessStartResult> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/processes`, {
      command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.process_id === undefined ? {} : { process_id: options.process_id }),
    });
  }

  public getProcess(processId: string): Promise<CloudflareSandboxProcessInfo | null> {
    return this.client.request("GET", `/sandboxes/${encodeURIComponent(this.instance_id)}/processes/${encodeURIComponent(processId)}`);
  }

  public getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }> {
    return this.client.request("GET", `/sandboxes/${encodeURIComponent(this.instance_id)}/processes/${encodeURIComponent(processId)}/logs`);
  }

  public killProcess(processId: string): Promise<void> {
    return this.client.request("DELETE", `/sandboxes/${encodeURIComponent(this.instance_id)}/processes/${encodeURIComponent(processId)}`);
  }

  public waitForPort(processId: string, port: number, options: CloudflareSandboxWaitForPortOptions = {}): Promise<void> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/processes/${encodeURIComponent(processId)}/wait-for-port`, {
      port,
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    });
  }

  public exposePort(port: number, options: { readonly name?: string } = {}): Promise<CloudflareSandboxPortInfo> {
    return this.client.request("POST", `/sandboxes/${encodeURIComponent(this.instance_id)}/ports/${String(port)}/expose`, {
      ...(options.name === undefined ? {} : { name: options.name }),
    });
  }

  public listExposedPorts(): Promise<CloudflareSandboxPortInfo[]> {
    return this.client.request("GET", `/sandboxes/${encodeURIComponent(this.instance_id)}/ports`);
  }

  public unexposePort(port: number): Promise<void> {
    return this.client.request("DELETE", `/sandboxes/${encodeURIComponent(this.instance_id)}/ports/${String(port)}/expose`);
  }

  public pause(): Promise<void> {
    return this.client.pause(this.instance_id);
  }

  public resume(): Promise<CloudflareSandboxConnection> {
    return this.client.resume(this.instance_id);
  }

  public kill(): Promise<void> {
    return this.client.kill(this.instance_id);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

export const resolveCloudflareSandboxClientConfig = (
  env: Record<string, string | undefined> = Bun.env,
): CloudflareSandboxClientConfig | null => {
  const token = env["OR3_NET_CLOUDFLARE_SANDBOX_TOKEN"]?.trim();
  const baseUrl = env["OR3_NET_CLOUDFLARE_SANDBOX_BASE_URL"]?.trim();
  const hasAny = token !== undefined || baseUrl !== undefined;
  if (!hasAny) {
    return null;
  }
  if (token === undefined || token === "") {
    throw new Error("OR3_NET_CLOUDFLARE_SANDBOX_TOKEN is required when Cloudflare Sandbox is configured");
  }
  if (baseUrl === undefined || baseUrl === "") {
    throw new Error("OR3_NET_CLOUDFLARE_SANDBOX_BASE_URL is required when Cloudflare Sandbox is configured");
  }
  const requestTimeoutValue = env["OR3_NET_CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS"]?.trim();
  const parsedRequestTimeout =
    requestTimeoutValue === undefined || requestTimeoutValue === "" ? undefined : Number(requestTimeoutValue);
  return {
    baseUrl,
    token,
    ...(typeof parsedRequestTimeout === "number" && Number.isFinite(parsedRequestTimeout)
      ? { requestTimeoutMs: parsedRequestTimeout }
      : {}),
    ...(env["OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME"] === undefined
      ? {}
      : { previewHostname: env["OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME"] }),
  };
};

const requestBridge = async <T>(input: {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl: typeof fetch;
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}): Promise<T> => {
  const controller = new AbortController();
  const timeoutHandle =
    input.requestTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort("request timeout");
        }, input.requestTimeoutMs);

  try {
    const response = await input.fetchImpl(new URL(input.path, ensureTrailingSlash(input.baseUrl)).toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    });

    const payload = await parseJson(response);
    if (!response.ok) {
      throw toCloudflareSandboxRequestError(payload, response.status, response.headers);
    }
    if (payload !== null && isBridgeErrorEnvelope(payload)) {
      throw toCloudflareSandboxRequestError(payload, payload.status ?? response.status, response.headers);
    }
    if (payload !== null && isBridgeSuccessEnvelope<T>(payload)) {
      return payload.result;
    }
    return payload as T;
  } catch (error: unknown) {
    if (error instanceof CloudflareSandboxRequestError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new CloudflareSandboxRequestError("Cloudflare Sandbox request timed out", 504, {
        code: "timeout",
        cause: error,
      });
    }
    throw new CloudflareSandboxRequestError(
      error instanceof Error ? error.message : "Cloudflare Sandbox request failed",
      502,
      { code: "bad_gateway", cause: error },
    );
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
};

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: text } satisfies BridgeErrorEnvelope;
  }
};

const toCloudflareSandboxRequestError = (
  payload: unknown,
  fallbackStatus: number,
  headers: Headers,
): CloudflareSandboxRequestError => {
  if (isBridgeErrorEnvelope(payload)) {
    const retryAfterMs = payload.retry_after_ms ?? parseRetryAfter(headers);
    return new CloudflareSandboxRequestError(payload.error, payload.status ?? fallbackStatus, {
      ...(payload.code === undefined ? {} : { code: payload.code }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(payload.details === undefined ? {} : { details: payload.details }),
    });
  }
  const retryAfterMs = parseRetryAfter(headers);
  return new CloudflareSandboxRequestError("Cloudflare Sandbox request failed", fallbackStatus, {
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
};

const parseRetryAfter = (headers: Headers): number | undefined => {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter === null) {
    return undefined;
  }
  const numeric = Number(retryAfter);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return numeric * 1000;
};

const isBridgeSuccessEnvelope = <T>(value: unknown): value is BridgeSuccessEnvelope<T> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as Partial<BridgeSuccessEnvelope<T>>).ok === true;
};

const isBridgeErrorEnvelope = (value: unknown): value is BridgeErrorEnvelope => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (value as Partial<BridgeErrorEnvelope>).ok === false && typeof (value as Partial<BridgeErrorEnvelope>).error === "string";
};

const ensureTrailingSlash = (value: string): string => (value.endsWith("/") ? value : `${value}/`);
