import { Buffer } from "node:buffer";

import type {
  RuntimeAdapter,
  RuntimeAdapterHealth,
  RuntimeAdapterManifest,
  RuntimeAdapterSessionHandle,
  RuntimeCopyInInput,
  RuntimeCopyOutInput,
  RuntimeExecutionHandle,
  RuntimeExecutionRequest,
  RuntimeFileTransferResult,
  RuntimeGetLogsInput,
  RuntimeLogsResult,
  RuntimeNodeDescriptor,
  RuntimeSessionCreateInput,
} from "../../contracts/runtime/index.ts";
import { RuntimeCapabilitySet, RuntimeError } from "../../contracts/runtime/index.ts";
import type { JsonValue } from "../../contracts/shared.ts";
import { createId } from "../../lib/ids.ts";
import { isProviderRequestErrorLike, type OpenSandboxClient } from "../../../sdk/opensandbox/types.ts";

export interface OpenSandboxRuntimeAdapterOptions {
  readonly client: OpenSandboxClient;
}

const manifest: RuntimeAdapterManifest = {
  adapter_id: "opensandbox",
  display_name: "OpenSandbox",
  version: "1.0.0",
  adapter_kind: "sandbox",
  isolation_class: "sandbox",
  trust_tier: "development",
  locality: "remote",
  capabilities: RuntimeCapabilitySet.fromValues([
    "exec",
    "stop",
    "copy-in",
    "copy-out",
    "file-browse",
    "file-rw",
    "workspace-write",
    "service-expose",
  ]),
  supported_presets: [],
  session_modes: ["ephemeral"],
};

export class OpenSandboxRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest = manifest;

  public constructor(private readonly options: OpenSandboxRuntimeAdapterOptions) {}

  public async health(): Promise<RuntimeAdapterHealth> {
    try {
      await this.options.client.list({ page_size: 1 });
      return { status: "healthy", checked_at: new Date().toISOString() };
    } catch {
      return { status: "unavailable", checked_at: new Date().toISOString() };
    }
  }

  public async listNodes(): Promise<RuntimeNodeDescriptor[]> {
    return [
      {
        node_id: "opensandbox-runtime",
        runtime_id: this.manifest.adapter_id,
        health: await this.health(),
        capabilities: this.manifest.capabilities,
        resource_limits: {},
        locality: this.manifest.locality,
      },
    ];
  }

  public async createSession(input: { workspace_id: string; session_id: string; config: RuntimeSessionCreateInput }): Promise<RuntimeAdapterSessionHandle> {
    try {
      const connection = await this.options.client.create({
        workspace_id: input.workspace_id,
        ...(this.options.client.config.defaultImage === undefined ? {} : { image: this.options.client.config.defaultImage }),
        timeout_seconds:
          this.options.client.config.defaultTimeoutSeconds ??
          Math.max(1, Math.round((input.config.timeout_rules.soft_ms ?? 60_000) / 1000)),
        metadata: {
          or3_workspace_id: input.workspace_id,
          or3_role: "runtime",
          or3_session_id: input.session_id,
        },
        skip_health_check: false,
        ...(this.options.client.config.defaultReadyTimeoutSeconds === undefined
          ? {}
          : { ready_timeout_seconds: this.options.client.config.defaultReadyTimeoutSeconds }),
        entrypoint: ["tail", "-f", "/dev/null"],
      });
      await connection.close();
      return {
        ref: connection.instance_id,
        adapter_id: this.manifest.adapter_id,
        status: "ready",
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      throw mapOpenSandboxRuntimeError(error, "adapter_unavailable");
    }
  }

  public async getSession(input: { workspace_id: string; session_ref: string }): Promise<RuntimeAdapterSessionHandle | null> {
    void input.workspace_id;
    try {
      const info = await this.options.client.get(input.session_ref);
      return {
        ref: info.id,
        adapter_id: this.manifest.adapter_id,
        status: mapRuntimeSessionState(info.status),
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      if (isMissingProviderError(error)) {
        return null;
      }
      throw mapOpenSandboxRuntimeError(error, "adapter_internal");
    }
  }

  public async destroySession(input: { workspace_id: string; session_ref: string }): Promise<{ destroyed: boolean; message?: string }> {
    void input.workspace_id;
    try {
      await this.options.client.kill(input.session_ref);
      return { destroyed: true };
    } catch (error: unknown) {
      if (isMissingProviderError(error)) {
        return { destroyed: true, message: "session already absent" };
      }
      throw mapOpenSandboxRuntimeError(error, "adapter_internal");
    }
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    const executionId = createId("rtexec");
    return Promise.resolve({
      execution_id: executionId,
      result: this.execResult(input.session_ref, input.request),
      abort: () => Promise.resolve({ acknowledged: false, message: "OpenSandbox foreground exec abort is not implemented" }),
    });
  }

  public async copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    let connection: Awaited<ReturnType<OpenSandboxClient["connect"]>> | null = null;
    try {
      connection = await this.options.client.connect(input.session_ref);
      const content = resolveContent(input.content_text, input.content_base64);
      const parentDir = input.destination_path.split("/").slice(0, -1).join("/");
      if (parentDir !== "") {
        await connection.createDirectories([{ path: parentDir }]);
      }
      await connection.writeFiles([{ path: input.destination_path, data: content }]);
      return { path: input.destination_path, bytes_transferred: Buffer.byteLength(content) };
    } catch (error: unknown) {
      throw mapOpenSandboxRuntimeError(error, "copy_failed");
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  public async copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    let connection: Awaited<ReturnType<OpenSandboxClient["connect"]>> | null = null;
    try {
      connection = await this.options.client.connect(input.session_ref);
      const content = await connection.readFile(input.source_path);
      if (input.encoding === "base64") {
        return {
          path: input.source_path,
          bytes_transferred: Buffer.byteLength(content),
          encoding: "base64",
          content_base64: Buffer.from(content, "utf8").toString("base64"),
        };
      }
      return {
        path: input.source_path,
        bytes_transferred: Buffer.byteLength(content),
        encoding: "text",
        content_text: content,
      };
    } catch (error: unknown) {
      throw mapOpenSandboxRuntimeError(error, "copy_failed");
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input.workspace_id;
    void input;
    return Promise.resolve({ chunks: [] });
  }

  public async stop(input: { workspace_id: string; session_ref: string }): Promise<{ stopped: boolean; status: "stopped" }> {
    void input.workspace_id;
    try {
      await this.options.client.pause(input.session_ref);
      return { stopped: true, status: "stopped" };
    } catch (error: unknown) {
      throw mapOpenSandboxRuntimeError(error, "adapter_internal");
    }
  }

  public getWorkspaceStageTransportCapabilities(): { archive: boolean; file_api: boolean } {
    return { archive: false, file_api: true };
  }

  private async execResult(
    sessionRef: string,
    request: RuntimeExecutionRequest,
  ): Promise<{ exit_code: number; stdout: string; stderr: string; artifacts: []; meta: Record<string, JsonValue> }> {
    let connection: Awaited<ReturnType<OpenSandboxClient["connect"]>> | null = null;
    try {
      connection = await this.options.client.connect(sessionRef);
      const command = [request.command, ...request.args].map(shellQuote).join(" ");
      const result = await connection.runCommand(command, {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.timeout_ms === undefined ? {} : { timeout_ms: request.timeout_ms }),
        ...(Object.keys(request.env).length === 0 ? {} : { env: request.env }),
      });
      return {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        artifacts: [],
        meta: toJsonRecord(result.meta),
      };
    } catch (error: unknown) {
      throw mapOpenSandboxRuntimeError(error, "exec_failed");
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
}

const resolveContent = (contentText?: string, contentBase64?: string): string => {
  if (contentText !== undefined) {
    return contentText;
  }
  if (contentBase64 !== undefined) {
    return Buffer.from(contentBase64, "base64").toString("utf8");
  }
  return "";
};

const shellQuote = (value: string): string => {
  if (value === "") {
    return "''";
  }
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
};

const toJsonRecord = (input: Record<string, unknown>): Record<string, JsonValue> => {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const jsonValue = toJsonValue(value);
    if (jsonValue !== undefined) {
      output[key] = jsonValue;
    }
  }
  return output;
};

const toJsonValue = (value: unknown): JsonValue | undefined => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry) ?? null);
  }
  if (typeof value === "object") {
    return toJsonRecord(value as Record<string, unknown>);
  }
  return undefined;
};

const mapRuntimeSessionState = (status: string): RuntimeAdapterSessionHandle["status"] => {
  const normalized = status.toLowerCase();
  if (normalized.includes("running") || normalized.includes("ready")) {
    return "ready";
  }
  if (normalized.includes("pending") || normalized.includes("creating")) {
    return "creating";
  }
  if (normalized.includes("paused") || normalized.includes("stopped")) {
    return "stopped";
  }
  if (normalized.includes("terminated") || normalized.includes("destroyed") || normalized.includes("failed")) {
    return "destroyed";
  }
  return "ready";
};

const isMissingProviderError = (error: unknown): boolean =>
  isProviderRequestErrorLike(error) && (error.status === 404 || error.code === "not_found");

const mapOpenSandboxRuntimeError = (error: unknown, code: RuntimeError["code"]): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (error instanceof Error) {
    const providerError = isProviderRequestErrorLike(error) ? error : undefined;
    return new RuntimeError(code, error.message, {
      retriable: providerError?.status === 429 || providerError?.status === 503,
      ...(providerError?.details === undefined ? {} : { details: providerError.details }),
      cause: error,
    });
  }
  return new RuntimeError(code, "OpenSandbox runtime request failed", { details: { error } });
};
