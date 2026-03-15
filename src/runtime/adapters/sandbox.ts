import { Buffer } from "node:buffer";

import type {
  RuntimeAdapter,
  RuntimeAdapterManifest,
  RuntimeAdapterHealth,
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
import { createId } from "../../lib/ids.ts";
import { WarmPoolManager } from "../../scheduler/warmpool.ts";
import type { SandboxClient, SandboxRequestError } from "../../../sdk/sandbox/index.ts";

export interface SandboxRuntimeAdapterOptions {
  readonly sandboxClient: SandboxClient;
  readonly warmPoolManager?: WarmPoolManager;
}

const manifest: RuntimeAdapterManifest = {
  adapter_id: "or3-sandbox",
  display_name: "OR3 Sandbox",
  version: "1.0.0",
  adapter_kind: "sandbox",
  isolation_class: "sandbox",
  trust_tier: "development",
  locality: "local",
  capabilities: RuntimeCapabilitySet.fromValues([
    "exec",
    "stop",
    "copy-in",
    "copy-out",
    "file-browse",
    "file-rw",
    "log-stream",
    "service-expose",
    "workspace-write",
  ]),
  supported_presets: [],
  session_modes: ["ephemeral"],
};

export class SandboxRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest = manifest;
  private readonly warmPoolManager: WarmPoolManager;

  public constructor(private readonly options: SandboxRuntimeAdapterOptions) {
    this.warmPoolManager = options.warmPoolManager ?? new WarmPoolManager(options.sandboxClient);
  }

  public async health(): Promise<RuntimeAdapterHealth> {
    try {
      const health = await this.options.sandboxClient.runtimeHealth();
      return {
        status: toRuntimeHealthStatus(health.status),
        checked_at: new Date().toISOString(),
      };
    } catch (error: unknown) {
      throw mapSandboxError(error, "adapter_unavailable");
    }
  }

  public async listNodes(): Promise<RuntimeNodeDescriptor[]> {
    let info: {
      cpu_cores?: number;
      memory_mb?: number;
      disk_mb?: number;
      max_concurrent_execs?: number;
    } = {};
    try {
      const runtimeInfo = await this.options.sandboxClient.runtimeInfo();
      info = {
        ...(typeof runtimeInfo["cpu_cores"] === "number" ? { cpu_cores: runtimeInfo["cpu_cores"] } : {}),
        ...(typeof runtimeInfo["memory_mb"] === "number" ? { memory_mb: runtimeInfo["memory_mb"] } : {}),
        ...(typeof runtimeInfo["disk_mb"] === "number" ? { disk_mb: runtimeInfo["disk_mb"] } : {}),
        ...(typeof runtimeInfo["max_concurrent_execs"] === "number" ? { max_concurrent_execs: runtimeInfo["max_concurrent_execs"] } : {}),
      };
    } catch {
      void 0;
    }
    const health = await this.health().catch(() => ({ status: "unknown" as const, checked_at: new Date().toISOString() }));
    const resourceLimits = {
      ...(typeof info.cpu_cores === "number" ? { cpu_cores: info.cpu_cores } : {}),
      ...(typeof info.memory_mb === "number" ? { memory_mb: info.memory_mb } : {}),
      ...(typeof info.disk_mb === "number" ? { disk_mb: info.disk_mb } : {}),
      ...(typeof info.max_concurrent_execs === "number" ? { max_concurrent_execs: info.max_concurrent_execs } : {}),
    };

    return [
      {
        node_id: "sandbox-runtime",
        runtime_id: this.manifest.adapter_id,
        health,
        capabilities: this.manifest.capabilities,
        resource_limits: resourceLimits,
        locality: this.manifest.locality,
      },
    ];
  }

  public async createSession(input: { workspace_id: string; session_id: string; config: RuntimeSessionCreateInput }): Promise<RuntimeAdapterSessionHandle> {
    void input.session_id;
    void input.config;
    try {
      const sandbox = await this.warmPoolManager.acquire(input.workspace_id);
      return {
        ref: sandbox.id,
        adapter_id: this.manifest.adapter_id,
        status: "ready",
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      throw mapSandboxError(error, "adapter_unavailable");
    }
  }

  public async listSessions(input: { workspace_id: string }): Promise<RuntimeAdapterSessionHandle[]> {
    try {
      const sandboxes = await this.options.sandboxClient.list();
      return sandboxes
        .filter((sandbox) => sandbox.workspace_id === input.workspace_id)
        .map((sandbox) => ({
          ref: sandbox.id,
          adapter_id: this.manifest.adapter_id,
          status: mapSandboxStatusToSessionState(sandbox.status),
          capabilities: this.manifest.capabilities,
        }));
    } catch (error: unknown) {
      throw mapSandboxError(error, "adapter_unavailable");
    }
  }

  public async getSession(input: { workspace_id: string; session_ref: string }): Promise<RuntimeAdapterSessionHandle | null> {
    void input.workspace_id;
    try {
      const sandbox = await this.options.sandboxClient.get(input.session_ref);
      return {
        ref: sandbox.id,
        adapter_id: this.manifest.adapter_id,
        status: mapSandboxStatusToSessionState(sandbox.status),
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      if (isSandboxRequestError(error) && error.status === 404) {
        return null;
      }
      throw mapSandboxError(error, "adapter_unavailable");
    }
  }

  public async destroySession(input: { workspace_id: string; session_ref: string }): Promise<{ destroyed: boolean; message?: string }> {
    void input.workspace_id;
    try {
      await this.options.sandboxClient.delete(input.session_ref);
      return { destroyed: true };
    } catch (error: unknown) {
      throw mapSandboxError(error, "adapter_internal");
    }
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    void input.workspace_id;
    const executionId = createId("rtexec");
    return Promise.resolve({
      execution_id: executionId,
      result: this.collectExecResult(input.session_ref, input.request),
      abort: () => Promise.resolve({ acknowledged: false, message: "sandbox exec abort is not supported" }),
    });
  }

  public async copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    try {
      const content = resolveCopyInContent(input);
      await this.options.sandboxClient.writeFile(input.session_ref, {
        path: input.destination_path,
        content,
      });
      return {
        path: input.destination_path,
        bytes_transferred: Buffer.byteLength(content),
      };
    } catch (error: unknown) {
      throw mapSandboxError(error, "copy_failed");
    }
  }

  public async copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    try {
      const file = await this.options.sandboxClient.readFile(input.session_ref, input.source_path);
      const contentText = file.content ?? (file.content_base64 === undefined ? "" : Buffer.from(file.content_base64, "base64").toString("utf8"));
      const bytes = Buffer.byteLength(contentText);
      if (input.encoding === "base64") {
        return {
          path: file.path,
          bytes_transferred: bytes,
          encoding: "base64",
          content_base64: Buffer.from(contentText, "utf8").toString("base64"),
        };
      }
      return {
        path: file.path,
        bytes_transferred: bytes,
        encoding: "text",
        content_text: contentText,
      };
    } catch (error: unknown) {
      throw mapSandboxError(error, "copy_failed");
    }
  }

  public getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input;
    return Promise.resolve({ chunks: [] });
  }

  public async stop(input: { workspace_id: string; session_ref: string }): Promise<{ stopped: boolean; status: "stopped" }> {
    void input.workspace_id;
    try {
      await this.options.sandboxClient.stop(input.session_ref);
      return { stopped: true, status: "stopped" };
    } catch (error: unknown) {
      throw mapSandboxError(error, "adapter_internal");
    }
  }

  public getWorkspaceStageTransportCapabilities(): { archive: boolean; file_api: boolean } {
    return { archive: true, file_api: true };
  }

  public async importWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    archive_bytes: Uint8Array;
  }): Promise<{ bytes_transferred: number }> {
    void input.workspace_id;
    try {
      await this.options.sandboxClient.importWorkspaceArchive(input.session_ref, input.archive_bytes);
      return { bytes_transferred: input.archive_bytes.byteLength };
    } catch (error: unknown) {
      throw mapSandboxError(error, "copy_failed");
    }
  }

  public async exportWorkspaceArchive(input: {
    workspace_id: string;
    session_ref: string;
    paths: string[];
  }): Promise<{ archive_bytes: Uint8Array; bytes_transferred: number }> {
    void input.workspace_id;
    try {
      const archiveBytes = await this.options.sandboxClient.exportWorkspaceArchive(input.session_ref, { paths: input.paths });
      return { archive_bytes: archiveBytes, bytes_transferred: archiveBytes.byteLength };
    } catch (error: unknown) {
      throw mapSandboxError(error, "copy_failed");
    }
  }

  private async collectExecResult(
    sessionRef: string,
    request: RuntimeExecutionRequest,
  ): Promise<{ exit_code: number; stdout: string; stderr: string; artifacts: []; meta: Record<string, never> }> {
    try {
      let stdoutChunks: string[] = [];
      let stderrChunks: string[] = [];
      let exitCode: number | null = null;
      for await (const event of this.options.sandboxClient.execStream(sessionRef, {
        command: [request.command, ...request.args],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      })) {
        if (event.event === "stdout" && typeof event.data["chunk"] === "string") {
          stdoutChunks.push(event.data["chunk"]);
        }
        if (event.event === "stderr" && typeof event.data["chunk"] === "string") {
          stderrChunks.push(event.data["chunk"]);
        }
        if (event.event === "result") {
          if (typeof event.data["stdout"] === "string") {
            stdoutChunks = [event.data["stdout"]];
          }
          if (typeof event.data["stderr"] === "string") {
            stderrChunks = [event.data["stderr"]];
          }
          if (typeof event.data["exit_code"] === "number") {
            exitCode = event.data["exit_code"];
          }
        }
      }
      if (exitCode === null) {
        throw new RuntimeError("exec_failed", "sandbox exec stream ended without an exit code");
      }
      return {
        exit_code: exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        artifacts: [],
        meta: {},
      };
    } catch (error: unknown) {
      throw mapSandboxError(error, "exec_failed");
    }
  }
}

const resolveCopyInContent = (input: RuntimeCopyInInput): string => {
  if (input.content_text !== undefined) {
    return input.content_text;
  }
  if (input.content_base64 !== undefined) {
    return Buffer.from(input.content_base64, "base64").toString("utf8");
  }
  throw new RuntimeError("copy_failed", "sandbox copy-in requires inline content", {
    details: { destination_path: input.destination_path },
  });
};

const toRuntimeHealthStatus = (status: string): RuntimeAdapterHealth["status"] => {
  switch (status) {
    case "healthy":
    case "ok":
      return "healthy";
    case "degraded":
      return "degraded";
    case "unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
};

const mapSandboxStatusToSessionState = (status: string): RuntimeAdapterSessionHandle["status"] => {
  switch (status) {
    case "running":
      return "ready";
    case "stopped":
      return "stopped";
    case "starting":
    case "created":
      return "creating";
    case "deleting":
      return "destroying";
    case "deleted":
      return "destroyed";
    default:
      return "failed";
  }
};

const isSandboxRequestError = (error: unknown): error is SandboxRequestError =>
  error instanceof Error && error.name === "SandboxRequestError";

const mapSandboxError = (error: unknown, fallbackCode: RuntimeError["code"]): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (isSandboxRequestError(error)) {
    return new RuntimeError(
      fallbackCode === "exec_failed" ? "exec_failed" : fallbackCode,
      error.message,
      {
        retriable: error.status >= 500,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        details: error.response === undefined ? {} : { status: error.status, response: error.response },
        cause: error,
      },
    );
  }
  return new RuntimeError(fallbackCode, error instanceof Error ? error.message : "sandbox adapter failed", {
    cause: error,
  });
};
