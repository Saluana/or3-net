/**
 * @module src/runtime/adapters/local-container
 *
 * Purpose:
 * Runtime adapter that executes work inside a local Docker container.
 *
 * Constraints:
 * - Requires a working `docker` CLI on the host
 * - Supports only ephemeral sessions
 */
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

/** Purpose: Result returned by the low-level container command runner. */
export interface LocalContainerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Purpose: Abstraction over the command runner used to invoke Docker. */
export interface LocalContainerCommandRunner {
  run(args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<LocalContainerCommandResult>;
}

/** Purpose: Construction options for the local-container runtime adapter. */
export interface LocalContainerRuntimeAdapterOptions {
  readonly image?: string;
  readonly runner?: LocalContainerCommandRunner;
}

const manifest: RuntimeAdapterManifest = {
  adapter_id: "local-container",
  display_name: "Local Container",
  version: "1.0.0",
  adapter_kind: "local",
  isolation_class: "container",
  trust_tier: "development",
  locality: "local",
  capabilities: RuntimeCapabilitySet.fromValues(["exec", "stop", "copy-in", "copy-out", "file-rw", "workspace-write"]),
  supported_presets: [],
  session_modes: ["ephemeral"],
};

/**
 * Purpose:
 * Docker-backed runtime adapter for local development and simple isolated exec.
 */
export class LocalContainerRuntimeAdapter implements RuntimeAdapter {
  public readonly manifest = manifest;
  private readonly image: string;
  private readonly runner: LocalContainerCommandRunner;

  public constructor(options: LocalContainerRuntimeAdapterOptions = {}) {
    this.image = options.image ?? "alpine:3.19";
    this.runner = options.runner ?? new BunDockerCommandRunner();
  }

  public async health(): Promise<RuntimeAdapterHealth> {
    try {
      await this.runDocker(["info"]);
      return { status: "healthy", checked_at: new Date().toISOString() };
    } catch {
      return { status: "unavailable", checked_at: new Date().toISOString() };
    }
  }

  public listNodes(input: { workspace_id: string }): Promise<RuntimeNodeDescriptor[]> {
    void input;
    return Promise.resolve([
      {
        node_id: "docker-daemon",
        runtime_id: this.manifest.adapter_id,
        health: { status: "unknown", checked_at: new Date().toISOString() },
        capabilities: this.manifest.capabilities,
        resource_limits: {},
        locality: this.manifest.locality,
      },
    ]);
  }

  public async createSession(input: { workspace_id: string; session_id: string; config: RuntimeSessionCreateInput }): Promise<RuntimeAdapterSessionHandle> {
    void input;
    try {
      const created = await this.runDocker([
        "create",
        this.image,
        "sh",
        "-lc",
        "while true; do sleep 3600; done",
      ]);
      const containerId = created.stdout.trim();
      await this.runDocker(["start", containerId]);
      return {
        ref: containerId,
        adapter_id: this.manifest.adapter_id,
        status: "ready",
        capabilities: this.manifest.capabilities,
      };
    } catch (error: unknown) {
      throw mapDockerError(error, "adapter_unavailable");
    }
  }

  public async destroySession(input: { workspace_id: string; session_ref: string }): Promise<{ destroyed: boolean; message?: string }> {
    void input.workspace_id;
    await this.runDocker(["rm", "-f", input.session_ref]);
    return { destroyed: true };
  }

  public exec(input: { workspace_id: string; session_ref: string; request: RuntimeExecutionRequest }): Promise<RuntimeExecutionHandle> {
    void input.workspace_id;
    const executionId = createId("rtexec");
    return Promise.resolve({
      execution_id: executionId,
      result: this.execResult(input.session_ref, input.request),
      abort: () => Promise.resolve({ acknowledged: false, message: "docker exec abort is not supported" }),
    });
  }

  public async copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    const content = resolveContent(input.content_text, input.content_base64);
    const tempPath = `${Bun.env["TMPDIR"] ?? "/tmp"}/${createId("rtcopy")}.txt`;

    await Bun.write(tempPath, content);
    try {
      await this.runDocker(["cp", tempPath, `${input.session_ref}:${input.destination_path}`]);
      return { path: input.destination_path, bytes_transferred: Buffer.byteLength(content) };
    } finally {
      await Bun.file(tempPath).delete().catch(() => {
        return undefined;
      });
    }
  }

  public async copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult> {
    void input.workspace_id;
    if (input.destination_path !== undefined) {
      await this.runDocker(["cp", `${input.session_ref}:${input.source_path}`, input.destination_path]);
      return { path: input.destination_path, bytes_transferred: 0 };
    }

    const result = await this.runDocker(["exec", input.session_ref, "cat", input.source_path]);
    if (input.encoding === "base64") {
      return {
        path: input.source_path,
        bytes_transferred: Buffer.byteLength(result.stdout),
        encoding: "base64",
        content_base64: Buffer.from(result.stdout, "utf8").toString("base64"),
      };
    }
    return {
      path: input.source_path,
      bytes_transferred: Buffer.byteLength(result.stdout),
      encoding: "text",
      content_text: result.stdout,
    };
  }

  public async getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult> {
    void input.workspace_id;
    const limit = input.limit ?? 100;
    const result = await this.runDocker(["logs", "--tail", String(limit), input.session_ref]);
    return {
      chunks: result.stdout === "" ? [] : [{ stream: "stdout", message: result.stdout }],
    };
  }

  public async stop(input: { workspace_id: string; session_ref: string }): Promise<{ stopped: boolean; status: "stopped" }> {
    void input.workspace_id;
    await this.runDocker(["stop", input.session_ref]);
    return { stopped: true, status: "stopped" };
  }

  private async execResult(
    sessionRef: string,
    request: RuntimeExecutionRequest,
  ): Promise<{ exit_code: number; stdout: string; stderr: string; artifacts: []; meta: Record<string, never> }> {
    const envArgs = Object.entries(request.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const args = [
      "exec",
      ...envArgs,
      ...(request.cwd === undefined ? [] : ["-w", request.cwd]),
      sessionRef,
      request.command,
      ...request.args,
    ];
    const result = await this.runDocker(args, {
      ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
      ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    });
    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      artifacts: [],
      meta: {},
    };
  }

  private async runDocker(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<LocalContainerCommandResult> {
    try {
      return await this.runner.run(args, options);
    } catch (error: unknown) {
      throw mapDockerError(error, "adapter_internal");
    }
  }
}

class BunDockerCommandRunner implements LocalContainerCommandRunner {
  public async run(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<LocalContainerCommandResult> {
    const controller = new AbortController();
    const timeoutId =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(new Error("docker command timed out"));
          }, options.timeoutMs);
    try {
      const command = Bun.spawn(["docker", ...args], {
        stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(stderr || stdout || `docker ${args[0] ?? "command"} failed`);
      }
      return { stdout, stderr, exitCode };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new RuntimeError("exec_timeout", error instanceof Error ? error.message : "docker command timed out", {
          retriable: true,
          cause: error,
        });
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
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
  throw new RuntimeError("copy_failed", "copy-in requires inline content");
};

const mapDockerError = (error: unknown, fallbackCode: RuntimeError["code"]): RuntimeError => {
  if (error instanceof RuntimeError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "docker runtime failed";
  if (message.includes("Cannot connect to the Docker daemon") || message.includes("docker: command not found")) {
    return new RuntimeError("adapter_unavailable", message, { retriable: true, cause: error });
  }
  return new RuntimeError(fallbackCode, message, { cause: error });
};
