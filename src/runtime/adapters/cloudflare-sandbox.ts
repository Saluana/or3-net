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
import type { CloudflareSandboxClient } from "../../../sdk/cloudflare-sandbox/types.ts";
import { isProviderRequestErrorLike } from "../../../sdk/cloudflare-sandbox/types.ts";

export interface CloudflareSandboxRuntimeAdapterOptions {
  readonly client: CloudflareSandboxClient;
}

const manifest: RuntimeAdapterManifest = {
  adapter_id: "cloudflare-sandbox",
  display_name: "Cloudflare Sandbox",
  version: "1.0.0",
  adapter_kind: "cloudflare",
  isolation_class: "sandbox",
  trust_tier: "production",
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

export class CloudflareSandboxRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest = manifest;

  public constructor(private readonly options: CloudflareSandboxRuntimeAdapterOptions) {}

  public async health(): Promise<RuntimeAdapterHealth> {
    try {
      const health = await this.options.client.health();
      return { status: health.status, checked_at: new Date().toISOString() };
    } catch {
      return { status: "unavailable", checked_at: new Date().toISOString() };
    }
  }

  public async listNodes(): Promise<RuntimeNodeDescriptor[]> {
    return [
      {
        node_id: "cloudflare-sandbox-runtime",
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
      const sandboxId = buildRuntimeSandboxId(input.workspace_id, input.session_id);
      const connection = await this.options.client.create({
        workspace_id: input.workspace_id,
        sandbox_id: sandboxId,
        cwd: "/workspace",
        metadata: {
          or3_workspace_id: input.workspace_id,
          or3_role: "runtime",
          or3_session_id: input.session_id,
        },
      });
      await connection.close().catch(() => undefined);
      return {
        ref: connection.instance_id,
        adapter_id: this.manifest.adapter_id,
        status: "ready",
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      throw mapCloudflareRuntimeError(error, "adapter_unavailable");
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
      throw mapCloudflareRuntimeError(error, "adapter_internal");
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
      throw mapCloudflareRuntimeError(error, "adapter_internal");
    }
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    const executionId = createId("rtexec");
    return Promise.resolve({
      execution_id: executionId,
      result: this.execResult(input.session_ref, input.request),
      abort: () => Promise.resolve({ acknowledged: false, message: "Cloudflare foreground exec abort is not implemented" }),
    });
  }

  public async copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    let connection: Awaited<ReturnType<CloudflareSandboxClient["connect"]>> | null = null;
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
      throw mapCloudflareRuntimeError(error, "copy_failed");
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  public async copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    let connection: Awaited<ReturnType<CloudflareSandboxClient["connect"]>> | null = null;
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
      throw mapCloudflareRuntimeError(error, "copy_failed");
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
      throw mapCloudflareRuntimeError(error, "adapter_internal");
    }
  }

  public getWorkspaceStageTransportCapabilities(): { archive: boolean; file_api: boolean } {
    return { archive: false, file_api: true };
  }

  private async execResult(
    sessionRef: string,
    request: RuntimeExecutionRequest,
  ): Promise<{ exit_code: number; stdout: string; stderr: string; artifacts: []; meta: Record<string, JsonValue> }> {
    let connection: Awaited<ReturnType<CloudflareSandboxClient["connect"]>> | null = null;
    try {
      connection = await this.options.client.connect(sessionRef);
      const command = [request.command, ...request.args].map(shellQuote).join(" ");
      const result = await connection.exec(command, {
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
      throw mapCloudflareRuntimeError(error, "exec_failed");
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
}

const buildRuntimeSandboxId = (workspaceId: string, sessionId: string): string =>
  `or3-rt-${workspaceId}-${sessionId}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

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

const toJsonValue = (input: unknown): JsonValue | undefined => {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((entry) => toJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (typeof input === "object") {
    return toJsonRecord(input as Record<string, unknown>);
  }

  return undefined;
};

const isMissingProviderError = (error: unknown): boolean =>
  isProviderRequestErrorLike(error) && error.status === 404;

const mapCloudflareRuntimeError = (error: unknown, code: RuntimeError["code"]): RuntimeError => {
  if (isProviderRequestErrorLike(error)) {
    return new RuntimeError(code, error.message, {
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      details: {
        provider: "cloudflare-sandbox",
        provider_status: error.status,
        ...(error.code === undefined ? {} : { provider_code: error.code }),
        ...(error.details === undefined ? {} : { provider_details: error.details }),
      },
      cause: error,
    });
  }
  return new RuntimeError(code, error instanceof Error ? error.message : "Cloudflare Sandbox runtime failed", {
    details: { provider: "cloudflare-sandbox" },
    cause: error,
  });
};

const mapRuntimeSessionState = (status: string): RuntimeAdapterSessionHandle["status"] => {
  switch (status) {
    case "running":
    case "ready":
      return "ready";
    case "paused":
    case "sleeping":
      return "stopped";
    case "starting":
    case "booting":
      return "creating";
    case "failed":
    case "error":
      return "failed";
    default:
      return "ready";
  }
};