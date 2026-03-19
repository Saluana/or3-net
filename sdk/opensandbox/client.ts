import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
  type CommandExecution,
  type ExecutionHandlers,
  type RunCommandOpts,
} from "@alibaba-group/opensandbox";

import {
  OpenSandboxRequestError,
  type OpenSandboxClient,
  type OpenSandboxClientConfig,
  type OpenSandboxCommandOptions,
  type OpenSandboxConnection,
  type OpenSandboxCreateRequest,
  type OpenSandboxDirectoryInput,
  type OpenSandboxExecutionHandlers,
  type OpenSandboxInstanceInfo,
  type OpenSandboxListRequest,
  type OpenSandboxWriteFileInput,
} from "./types.ts";

export class SdkOpenSandboxClient implements OpenSandboxClient {
  public constructor(public readonly config: OpenSandboxClientConfig) {}

  public async create(input: OpenSandboxCreateRequest): Promise<OpenSandboxConnection> {
    const connectionConfig = this.createConnectionConfig();
    try {
      const sandbox = await Sandbox.create({
        connectionConfig,
        image: input.image ?? this.config.defaultImage ?? "ubuntu",
        timeoutSeconds: input.timeout_seconds ?? this.config.defaultTimeoutSeconds ?? 600,
        ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.resource === undefined ? {} : { resource: input.resource }),
        skipHealthCheck: input.skip_health_check ?? false,
        ...((input.ready_timeout_seconds ?? this.config.defaultReadyTimeoutSeconds) === undefined
          ? {}
          : { readyTimeoutSeconds: input.ready_timeout_seconds ?? this.config.defaultReadyTimeoutSeconds }),
        ...(input.health_check_polling_interval === undefined
          ? {}
          : { healthCheckPollingInterval: input.health_check_polling_interval }),
      });
      return new SdkOpenSandboxConnection(sandbox);
    } catch (error: unknown) {
      await connectionConfig.closeTransport().catch(() => undefined);
      throw mapOpenSandboxError(error);
    }
  }

  public async connect(instanceId: string): Promise<OpenSandboxConnection> {
    try {
      const sandbox = await Sandbox.connect({
        sandboxId: instanceId,
        connectionConfig: this.createConnectionConfig(),
        skipHealthCheck: true,
      });
      return new SdkOpenSandboxConnection(sandbox);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async list(input: OpenSandboxListRequest = {}): Promise<OpenSandboxInstanceInfo[]> {
    const manager = this.createManager();
    try {
      const result = await manager.listSandboxInfos({
        ...(input.states === undefined ? {} : { states: input.states }),
        ...(input.page_size === undefined ? {} : { pageSize: input.page_size }),
      });
      return result.items.map(mapSandboxInfo);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    } finally {
      await manager.close().catch(() => undefined);
    }
  }

  public async get(instanceId: string): Promise<OpenSandboxInstanceInfo> {
    const manager = this.createManager();
    try {
      return mapSandboxInfo(await manager.getSandboxInfo(instanceId));
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    } finally {
      await manager.close().catch(() => undefined);
    }
  }

  public async pause(instanceId: string): Promise<void> {
    const manager = this.createManager();
    try {
      await manager.pauseSandbox(instanceId);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    } finally {
      await manager.close().catch(() => undefined);
    }
  }

  public async resume(instanceId: string): Promise<OpenSandboxConnection> {
    try {
      const sandbox = await Sandbox.resume({
        sandboxId: instanceId,
        connectionConfig: this.createConnectionConfig(),
        skipHealthCheck: true,
      });
      return new SdkOpenSandboxConnection(sandbox);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async renew(instanceId: string, timeoutSeconds: number): Promise<void> {
    const sandbox = await this.connect(instanceId);
    try {
      await sandbox.renew(timeoutSeconds);
    } finally {
      await sandbox.close().catch(() => undefined);
    }
  }

  public async kill(instanceId: string): Promise<void> {
    const manager = this.createManager();
    try {
      await manager.killSandbox(instanceId);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    } finally {
      await manager.close().catch(() => undefined);
    }
  }

  private createConnectionConfig(): ConnectionConfig {
    return new ConnectionConfig({
      domain: this.config.domain,
      apiKey: this.config.apiKey,
      ...(this.config.protocol === undefined ? {} : { protocol: this.config.protocol }),
      ...(this.config.requestTimeoutSeconds === undefined
        ? {}
        : { requestTimeoutSeconds: this.config.requestTimeoutSeconds }),
      ...(this.config.useServerProxy === undefined ? {} : { useServerProxy: this.config.useServerProxy }),
    });
  }

  private createManager(): SandboxManager {
    return SandboxManager.create({ connectionConfig: this.createConnectionConfig() });
  }
}

class SdkOpenSandboxConnection implements OpenSandboxConnection {
  public readonly instance_id: string;

  public constructor(private sandbox: Sandbox) {
    this.instance_id = sandbox.id;
  }

  public async runCommand(
    command: string,
    options: OpenSandboxCommandOptions = {},
    handlers: OpenSandboxExecutionHandlers = {},
  ): Promise<{ execution_id?: string; exit_code: number; stdout: string; stderr: string; meta: Record<string, unknown> }> {
    try {
      const execution = await this.sandbox.commands.run(
        command,
        toRunCommandOpts(options),
        toExecutionHandlers(handlers),
      );
      return normalizeCommandExecution(execution);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async writeFiles(entries: OpenSandboxWriteFileInput[]): Promise<void> {
    try {
      await this.sandbox.files.writeFiles(entries.map((entry) => ({
        path: entry.path,
        data: entry.data,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      })));
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async readFile(path: string): Promise<string> {
    try {
      return await this.sandbox.files.readFile(path);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async createDirectories(paths: OpenSandboxDirectoryInput[]): Promise<void> {
    try {
      await this.sandbox.files.createDirectories(paths.map((entry) => ({
        path: entry.path,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      })));
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async getEndpoint(port: number): Promise<{ endpoint: string; url?: string }> {
    try {
      const endpoint = await this.sandbox.getEndpoint(port);
      const url = await this.sandbox.getEndpointUrl(port).catch(() => undefined);
      return { endpoint: endpoint.endpoint, ...(url === undefined ? {} : { url }) };
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async pause(): Promise<void> {
    try {
      await this.sandbox.pause();
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async resume(): Promise<OpenSandboxConnection> {
    try {
      const resumed = await this.sandbox.resume({ skipHealthCheck: true });
      await this.close().catch(() => undefined);
      this.sandbox = resumed;
      return this;
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async renew(timeoutSeconds: number): Promise<void> {
    try {
      await this.sandbox.renew(timeoutSeconds);
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async kill(): Promise<void> {
    try {
      await this.sandbox.kill();
    } catch (error: unknown) {
      throw mapOpenSandboxError(error);
    }
  }

  public async close(): Promise<void> {
    await this.sandbox.close().catch(() => undefined);
  }
}

export const resolveOpenSandboxClientConfig = (
  env: Record<string, string | undefined> = Bun.env,
): OpenSandboxClientConfig | null => {
  const apiKey = env["OR3_NET_OPENSANDBOX_API_KEY"]?.trim();
  const domain = env["OR3_NET_OPENSANDBOX_DOMAIN"]?.trim() ?? env["OR3_NET_OPENSANDBOX_BASE_URL"]?.trim();
  const hasAny = apiKey !== undefined || domain !== undefined;
  if (!hasAny) {
    return null;
  }
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OR3_NET_OPENSANDBOX_API_KEY is required when OpenSandbox is configured");
  }
  if (domain === undefined || domain === "") {
    throw new Error("OR3_NET_OPENSANDBOX_DOMAIN or OR3_NET_OPENSANDBOX_BASE_URL is required when OpenSandbox is configured");
  }

  const timeoutValue = env["OR3_NET_OPENSANDBOX_DEFAULT_TIMEOUT_SECONDS"]?.trim();
  const readyTimeoutValue = env["OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS"]?.trim();
  const requestTimeoutValue = env["OR3_NET_OPENSANDBOX_REQUEST_TIMEOUT_SECONDS"]?.trim();
  const parsedTimeout = timeoutValue === undefined || timeoutValue === "" ? undefined : Number(timeoutValue);
  const parsedReadyTimeout = readyTimeoutValue === undefined || readyTimeoutValue === "" ? undefined : Number(readyTimeoutValue);
  const parsedRequestTimeout =
    requestTimeoutValue === undefined || requestTimeoutValue === "" ? undefined : Number(requestTimeoutValue);
  const requestTimeoutSeconds =
    typeof parsedRequestTimeout === "number" && Number.isFinite(parsedRequestTimeout) ? parsedRequestTimeout : undefined;
  const defaultTimeoutSeconds =
    typeof parsedTimeout === "number" && Number.isFinite(parsedTimeout) ? parsedTimeout : undefined;
  const defaultReadyTimeoutSeconds =
    typeof parsedReadyTimeout === "number" && Number.isFinite(parsedReadyTimeout) ? parsedReadyTimeout : undefined;

  return {
    domain,
    apiKey,
    ...(env["OR3_NET_OPENSANDBOX_PROTOCOL"] === undefined
      ? {}
      : { protocol: env["OR3_NET_OPENSANDBOX_PROTOCOL"] === "https" ? "https" : "http" }),
    ...(requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds }),
    ...(defaultTimeoutSeconds === undefined ? {} : { defaultTimeoutSeconds }),
    ...(defaultReadyTimeoutSeconds === undefined ? {} : { defaultReadyTimeoutSeconds }),
    ...(env["OR3_NET_OPENSANDBOX_DEFAULT_IMAGE"] === undefined
      ? {}
      : { defaultImage: env["OR3_NET_OPENSANDBOX_DEFAULT_IMAGE"] }),
    ...(env["OR3_NET_OPENSANDBOX_USE_SERVER_PROXY"] === undefined
      ? {}
      : { useServerProxy: env["OR3_NET_OPENSANDBOX_USE_SERVER_PROXY"] === "true" }),
  };
};

interface SandboxInfoLike {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly createdAt?: unknown;
  readonly expiresAt?: unknown;
  readonly metadata?: unknown;
}

const mapSandboxInfo = (info: SandboxInfoLike): OpenSandboxInstanceInfo => ({
  id: String(info.id),
  status: resolveSandboxStatus(info.status) ?? "unknown",
  ...(info.createdAt instanceof Date ? { created_at: info.createdAt.toISOString() } : {}),
  ...(info.expiresAt instanceof Date ? { expires_at: info.expiresAt.toISOString() } : info.expiresAt === null ? { expires_at: null } : {}),
  ...(typeof info.metadata === "object" && info.metadata !== null ? { metadata: info.metadata as Record<string, unknown> } : {}),
});

const toRunCommandOpts = (options: OpenSandboxCommandOptions): RunCommandOpts => ({
  ...(options.cwd === undefined ? {} : { workingDirectory: options.cwd }),
  ...(options.timeout_ms === undefined ? {} : { timeoutSeconds: options.timeout_ms / 1000 }),
  ...(options.background === undefined ? {} : { background: options.background }),
  ...(options.env === undefined ? {} : { envs: options.env }),
});

const toExecutionHandlers = (handlers: OpenSandboxExecutionHandlers): ExecutionHandlers => {
  const { onStdout, onStderr, onResult, onError } = handlers;
  return {
    ...(onStdout === undefined
    ? {}
    : { onStdout: (message: { text: string }) => onStdout({ text: message.text }) }),
    ...(onStderr === undefined
    ? {}
    : { onStderr: (message: { text: string }) => onStderr({ text: message.text }) }),
    ...(onResult === undefined
    ? {}
    : { onResult: (result: unknown) => onResult(asRecord(result)) }),
    ...(onError === undefined
    ? {}
    : { onError: (error: unknown) => onError(asRecord(error)) }),
  };
};

const normalizeCommandExecution = (execution: CommandExecution): {
  execution_id?: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  meta: Record<string, unknown>;
} => {
  const stdout = Array.isArray(execution.logs.stdout)
    ? execution.logs.stdout.map((entry: { text?: string }) => entry.text ?? "").join("")
    : "";
  const stderr = Array.isArray(execution.logs.stderr)
    ? execution.logs.stderr.map((entry: { text?: string }) => entry.text ?? "").join("")
    : "";
  const resultRecord = Array.isArray(execution.result) ? execution.result.at(-1) : undefined;
  const exitCode =
    getNumericProperty(resultRecord, "exit_code") ??
    getNumericProperty(resultRecord, "exitCode") ??
    (execution.error === undefined ? 0 : 1);

  return {
    ...(typeof execution.id === "string" ? { execution_id: execution.id } : {}),
    exit_code: exitCode,
    stdout,
    stderr,
    meta: {
      ...(resultRecord === undefined ? {} : sanitizeRecord(resultRecord as unknown as Record<string, unknown>)),
      ...(execution.error === undefined
        ? {}
        : { error: sanitizeRecord(execution.error as unknown as Record<string, unknown>) }),
    },
  };
};

const sanitizeRecord = (value: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry instanceof Date) {
      result[key] = entry.toISOString();
      continue;
    }
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      result[key] = entry;
      continue;
    }
    if (typeof entry === "object") {
      result[key] = entry;
    }
  }
  return result;
};

const mapOpenSandboxError = (error: unknown): OpenSandboxRequestError => {
  if (error instanceof OpenSandboxRequestError) {
    return error;
  }
  if (error instanceof Error) {
    const providerError = getObjectProperty(error, "error");
    const status = getNumericProperty(error, "status") ?? getNumericProperty(providerError, "status") ?? 500;
    const retryAfterSeconds = getNumericProperty(error, "retryAfter") ?? getNumericProperty(error, "retryAfterSeconds");
    const providerCode = getStringProperty(providerError, "code") ?? getStringProperty(error, "code");
    const providerMessage = getStringProperty(providerError, "message") ?? error.message;
    return new OpenSandboxRequestError(providerMessage, status, {
      ...(providerCode === undefined ? {} : { code: providerCode }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: retryAfterSeconds * 1000 }),
      ...(providerError === undefined ? {} : { details: { provider: providerError } }),
      cause: error,
    });
  }

  return new OpenSandboxRequestError("OpenSandbox request failed", 500, {
    details: { error },
  });
};

const getNumericProperty = (value: unknown, key: string): number | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
};

const getStringProperty = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() !== "" ? property : undefined;
};

const getObjectProperty = (value: unknown, key: string): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "object" && property !== null ? property as Record<string, unknown> : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const resolveSandboxStatus = (status: unknown): string | undefined => {
  if (typeof status === "string") {
    return status;
  }
  if (typeof status === "object" && status !== null && "state" in status) {
    const state = (status as Record<string, unknown>)["state"];
    return typeof state === "string" ? state : undefined;
  }
  return undefined;
};
