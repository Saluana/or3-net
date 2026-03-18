export interface ProviderRequestErrorLike {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface CloudflareSandboxClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly requestTimeoutMs?: number;
  readonly previewHostname?: string;
}

export interface CloudflareSandboxCreateRequest {
  readonly workspace_id: string;
  readonly sandbox_id: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, string>;
}

export interface CloudflareSandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly preview_enabled: boolean;
  readonly created_at?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CloudflareSandboxExecOptions {
  readonly cwd?: string;
  readonly timeout_ms?: number;
  readonly env?: Record<string, string>;
  readonly stream?: boolean;
}

export interface CloudflareSandboxExecResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly meta: Record<string, unknown>;
}

export interface CloudflareSandboxProcessInfo {
  readonly process_id: string;
  readonly pid?: number;
  readonly command: string;
  readonly status: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly exit_code?: number;
}

export interface CloudflareSandboxProcessStartOptions {
  readonly cwd?: string;
  readonly timeout_ms?: number;
  readonly env?: Record<string, string>;
  readonly process_id?: string;
}

export interface CloudflareSandboxProcessStartResult extends CloudflareSandboxProcessInfo {
  readonly process_id: string;
}

export interface CloudflareSandboxWaitForPortOptions {
  readonly timeout_ms?: number;
}

export interface CloudflareSandboxPortInfo {
  readonly port: number;
  readonly url: string;
  readonly name?: string;
}

export interface CloudflareSandboxConnection {
  readonly instance_id: string;
  exec(command: string, options?: CloudflareSandboxExecOptions): Promise<CloudflareSandboxExecResult>;
  writeFiles(entries: { readonly path: string; readonly data: string }[]): Promise<void>;
  readFile(path: string): Promise<string>;
  createDirectories(paths: { readonly path: string }[]): Promise<void>;
  startProcess(command: string, options?: CloudflareSandboxProcessStartOptions): Promise<CloudflareSandboxProcessStartResult>;
  getProcess(processId: string): Promise<CloudflareSandboxProcessInfo | null>;
  getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }>;
  killProcess(processId: string): Promise<void>;
  waitForPort(processId: string, port: number, options?: CloudflareSandboxWaitForPortOptions): Promise<void>;
  exposePort(port: number, options?: { readonly name?: string }): Promise<CloudflareSandboxPortInfo>;
  listExposedPorts(): Promise<CloudflareSandboxPortInfo[]>;
  unexposePort(port: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<CloudflareSandboxConnection>;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface CloudflareSandboxClient {
  readonly config: CloudflareSandboxClientConfig;
  create(input: CloudflareSandboxCreateRequest): Promise<CloudflareSandboxConnection>;
  connect(instanceId: string): Promise<CloudflareSandboxConnection>;
  get(instanceId: string): Promise<CloudflareSandboxInfo>;
  health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }>;
  pause(instanceId: string): Promise<void>;
  resume(instanceId: string): Promise<CloudflareSandboxConnection>;
  kill(instanceId: string): Promise<void>;
}

export class CloudflareSandboxRequestError extends Error implements ProviderRequestErrorLike {
  public override readonly name = "CloudflareSandboxRequestError";

  public constructor(
    message: string,
    public readonly status: number,
    options: {
      code?: string;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }

  public readonly code: string | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly details: Record<string, unknown> | undefined;
}

export const isProviderRequestErrorLike = (error: unknown): error is ProviderRequestErrorLike => {
  if (!(error instanceof Error)) {
    return false;
  }

  return typeof (error as Partial<ProviderRequestErrorLike>).status === "number";
};

export const isCloudflareSandboxRequestError = (error: unknown): error is CloudflareSandboxRequestError =>
  error instanceof Error &&
  error.name === "CloudflareSandboxRequestError" &&
  typeof (error as CloudflareSandboxRequestError).status === "number";
