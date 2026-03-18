export interface ProviderRequestErrorLike {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface OpenSandboxClientConfig {
  readonly domain: string;
  readonly apiKey: string;
  readonly protocol?: "http" | "https";
  readonly requestTimeoutSeconds?: number;
  readonly useServerProxy?: boolean;
  readonly defaultImage?: string;
  readonly defaultTimeoutSeconds?: number | null;
}

export interface OpenSandboxCreateRequest {
  readonly workspace_id: string;
  readonly image?: string;
  readonly timeout_seconds?: number | null;
  readonly env?: Record<string, string>;
  readonly metadata?: Record<string, string>;
  readonly entrypoint?: string[];
  readonly resource?: {
    readonly cpu?: string;
    readonly memory?: string;
  };
  readonly skip_health_check?: boolean;
  readonly ready_timeout_seconds?: number;
  readonly health_check_polling_interval?: number;
}

export interface OpenSandboxListRequest {
  readonly states?: string[];
  readonly page_size?: number;
}

export interface OpenSandboxInstanceInfo {
  readonly id: string;
  readonly status: string;
  readonly created_at?: string;
  readonly expires_at?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface OpenSandboxCommandOptions {
  readonly cwd?: string;
  readonly timeout_ms?: number;
  readonly env?: Record<string, string>;
  readonly background?: boolean;
}

export interface OpenSandboxCommandResult {
  readonly execution_id?: string;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly meta: Record<string, unknown>;
}

export interface OpenSandboxExecutionHandlers {
  readonly onStdout?: (message: { readonly text: string }) => Promise<void> | void;
  readonly onStderr?: (message: { readonly text: string }) => Promise<void> | void;
  readonly onResult?: (result: Record<string, unknown>) => Promise<void> | void;
  readonly onError?: (error: Record<string, unknown>) => Promise<void> | void;
}

export interface OpenSandboxWriteFileInput {
  readonly path: string;
  readonly data: string;
  readonly mode?: number;
}

export interface OpenSandboxDirectoryInput {
  readonly path: string;
  readonly mode?: number;
}

export interface OpenSandboxConnection {
  readonly instance_id: string;
  runCommand(
    command: string,
    options?: OpenSandboxCommandOptions,
    handlers?: OpenSandboxExecutionHandlers,
  ): Promise<OpenSandboxCommandResult>;
  writeFiles(entries: OpenSandboxWriteFileInput[]): Promise<void>;
  readFile(path: string): Promise<string>;
  createDirectories(paths: OpenSandboxDirectoryInput[]): Promise<void>;
  getEndpoint(port: number): Promise<{ endpoint: string; url?: string }>;
  pause(): Promise<void>;
  resume(): Promise<OpenSandboxConnection>;
  renew(timeoutSeconds: number): Promise<void>;
  kill(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSandboxClient {
  readonly config: OpenSandboxClientConfig;
  create(input: OpenSandboxCreateRequest): Promise<OpenSandboxConnection>;
  connect(instanceId: string): Promise<OpenSandboxConnection>;
  list(input?: OpenSandboxListRequest): Promise<OpenSandboxInstanceInfo[]>;
  get(instanceId: string): Promise<OpenSandboxInstanceInfo>;
  pause(instanceId: string): Promise<void>;
  resume(instanceId: string): Promise<OpenSandboxConnection>;
  renew(instanceId: string, timeoutSeconds: number): Promise<void>;
  kill(instanceId: string): Promise<void>;
}

export class OpenSandboxRequestError extends Error implements ProviderRequestErrorLike {
  public override readonly name = "OpenSandboxRequestError";

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

export const isOpenSandboxRequestError = (error: unknown): error is OpenSandboxRequestError =>
  error instanceof Error && error.name === "OpenSandboxRequestError" && typeof (error as OpenSandboxRequestError).status === "number";
