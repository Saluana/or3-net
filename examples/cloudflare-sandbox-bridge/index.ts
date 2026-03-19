import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { handleCloudflareSandboxBridgeRequest, type BridgeSandbox, type CloudflareSandboxBridge } from "./handler.ts";
import { CloudflareSandboxRequestError } from "../../sdk/cloudflare-sandbox/types.ts";

type Env = {
  readonly Sandbox: unknown;
  readonly OR3_NET_BRIDGE_TOKEN: string;
  readonly OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const previewResponse = await proxyToSandbox(request, env as never);
    if (previewResponse !== null) {
      return previewResponse;
    }

    return await handleCloudflareSandboxBridgeRequest(new WorkerBridge(env), request);
  },
};

class WorkerBridge implements CloudflareSandboxBridge {
  public constructor(private readonly env: Env) {}

  public async createSandbox(input: {
    sandbox_id: string;
    workspace_id: string;
    cwd?: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
  }): Promise<BridgeSandbox> {
    const sandbox = this.resolveSandbox(input.sandbox_id);
    await sandbox.exec("true", {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    return new WorkerBridgeSandbox(this.env, input.sandbox_id, input.metadata);
  }

  public async getSandbox(id: string): Promise<BridgeSandbox | null> {
    return new WorkerBridgeSandbox(this.env, id);
  }

  public health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }> {
    return Promise.resolve({
      status: "healthy",
      preview_enabled: this.previewHostname !== undefined && !this.previewHostname.endsWith(".workers.dev"),
    });
  }

  public authenticate(request: Request): Promise<void> {
    const header = request.headers.get("Authorization");
    if (header !== `Bearer ${this.env.OR3_NET_BRIDGE_TOKEN}`) {
      return Promise.reject(new CloudflareSandboxRequestError("unauthorized", 401, { code: "unauthorized" }));
    }
    return Promise.resolve();
  }

  private resolveSandbox(id: string): any {
    return getSandbox((this.env as { Sandbox: unknown }).Sandbox as never, id, { normalizeId: true });
  }

  private get previewHostname(): string | undefined {
    const hostname = this.env.OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME?.trim();
    return hostname === undefined || hostname === "" ? undefined : hostname;
  }
}

class WorkerBridgeSandbox implements BridgeSandbox {
  private readonly sandbox: any;

  public constructor(
    private readonly env: Env,
    public readonly id: string,
    private readonly metadata?: Record<string, string>,
  ) {
    this.sandbox = getSandbox((env as { Sandbox: unknown }).Sandbox as never, id, { normalizeId: true });
  }

  public async exec(command: string, options?: { cwd?: string; timeout_ms?: number; env?: Record<string, string>; stream?: boolean }) {
    const result = await this.sandbox.exec(command, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.timeout_ms === undefined ? {} : { timeoutMs: options.timeout_ms }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.stream === undefined ? {} : { stream: options.stream }),
    });
    return {
      exit_code: typeof result.exitCode === "number" ? result.exitCode : 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      meta: { provider: "cloudflare-sandbox" },
    };
  }

  public async writeFile(path: string, data: string): Promise<void> {
    await this.sandbox.writeFile(path, data);
  }

  public async readFile(path: string): Promise<string> {
    const result = await this.sandbox.readFile(path);
    return typeof result?.content === "string" ? result.content : typeof result === "string" ? result : "";
  }

  public async mkdir(path: string): Promise<void> {
    await this.sandbox.mkdir(path, { recursive: true });
  }

  public async startProcess(command: string, options?: { cwd?: string; timeout_ms?: number; env?: Record<string, string>; process_id?: string }) {
    const process = await this.sandbox.startProcess(command, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.timeout_ms === undefined ? {} : { timeoutMs: options.timeout_ms }),
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.process_id === undefined ? {} : { processId: options.process_id }),
    });
    return {
      process_id: process.id,
      ...(typeof process.pid === "number" ? { pid: process.pid } : {}),
      command: process.command,
      status: process.status,
    };
  }

  public async getProcess(processId: string) {
    const process = await this.sandbox.getProcess(processId);
    if (process === null) {
      return null;
    }
    return {
      process_id: process.id,
      ...(typeof process.pid === "number" ? { pid: process.pid } : {}),
      command: process.command,
      status: process.status,
      ...(process.startTime instanceof Date ? { started_at: process.startTime.toISOString() } : {}),
      ...(process.endTime instanceof Date ? { finished_at: process.endTime.toISOString() } : {}),
      ...(typeof process.exitCode === "number" ? { exit_code: process.exitCode } : {}),
    };
  }

  public async getProcessLogs(processId: string) {
    const logs = await this.sandbox.getProcessLogs(processId);
    return {
      stdout: typeof logs?.stdout === "string" ? logs.stdout : "",
      stderr: typeof logs?.stderr === "string" ? logs.stderr : "",
      process_id: processId,
    };
  }

  public async killProcess(processId: string): Promise<void> {
    await this.sandbox.killProcess(processId);
  }

  public async waitForPort(processId: string, port: number, options?: { timeout_ms?: number }): Promise<void> {
    const process = await this.sandbox.getProcess(processId);
    if (process === null || typeof process.waitForPort !== "function") {
      throw new CloudflareSandboxRequestError(`process ${processId} is not available`, 404, { code: "not_found" });
    }
    await process.waitForPort(port, ...(options?.timeout_ms === undefined ? [] : [{ timeout: options.timeout_ms }]));
  }

  public async exposePort(port: number, options?: { name?: string }) {
    const hostname = this.env.OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME?.trim();
    if (hostname === undefined || hostname === "") {
      throw new CloudflareSandboxRequestError("preview hostname is not configured", 400, { code: "preview_unavailable" });
    }
    if (hostname.endsWith(".workers.dev")) {
      throw new CloudflareSandboxRequestError(".workers.dev does not support wildcard preview domains", 400, {
        code: "custom_domain_required",
      });
    }
    const exposed = await this.sandbox.exposePort(port, {
      hostname,
      ...(options?.name === undefined ? {} : { name: options.name }),
    });
    return {
      port: exposed.port,
      url: exposed.url,
      ...(options?.name === undefined ? {} : { name: options.name }),
    };
  }

  public async listExposedPorts() {
    const hostname = this.env.OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME?.trim();
    if (hostname === undefined || hostname === "") {
      return [];
    }
    const ports = await this.sandbox.getExposedPorts(hostname);
    return ports.map((port: { port: number; url: string; name?: string }) => ({
      port: port.port,
      url: port.url,
      ...(port.name === undefined ? {} : { name: port.name }),
    }));
  }

  public async unexposePort(port: number): Promise<void> {
    await this.sandbox.unexposePort(port);
  }

  public async pause(): Promise<void> {
    if (typeof this.sandbox.pause === "function") {
      await this.sandbox.pause();
    }
  }

  public async resume(): Promise<void> {
    if (typeof this.sandbox.resume === "function") {
      await this.sandbox.resume();
    }
  }

  public async delete(): Promise<void> {
    if (typeof this.sandbox.killAllProcesses === "function") {
      await this.sandbox.killAllProcesses();
    }
    const ports = await this.listExposedPorts();
    await Promise.all(ports.map((port: { port: number }) => this.unexposePort(port.port).catch(() => undefined)));
  }

  public async info() {
    return {
      id: this.id,
      status: "running",
      preview_enabled:
        this.env.OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME !== undefined &&
        !this.env.OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME.endsWith(".workers.dev"),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
    };
  }
}
