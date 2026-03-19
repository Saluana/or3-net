import type {
  CloudflareSandboxExecResult,
  CloudflareSandboxInfo,
  CloudflareSandboxPortInfo,
  CloudflareSandboxProcessInfo,
  CloudflareSandboxProcessStartResult,
} from "../../sdk/cloudflare-sandbox/types.ts";

export interface BridgeSandbox {
  readonly id: string;
  exec(command: string, options?: { cwd?: string; timeout_ms?: number; env?: Record<string, string>; stream?: boolean }): Promise<CloudflareSandboxExecResult>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  startProcess(command: string, options?: { cwd?: string; timeout_ms?: number; env?: Record<string, string>; process_id?: string }): Promise<CloudflareSandboxProcessStartResult>;
  getProcess(processId: string): Promise<CloudflareSandboxProcessInfo | null>;
  getProcessLogs(processId: string): Promise<{ stdout: string; stderr: string; process_id: string }>;
  killProcess(processId: string): Promise<void>;
  waitForPort(processId: string, port: number, options?: { timeout_ms?: number }): Promise<void>;
  exposePort(port: number, options?: { name?: string }): Promise<CloudflareSandboxPortInfo>;
  listExposedPorts(): Promise<CloudflareSandboxPortInfo[]>;
  unexposePort(port: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  delete(): Promise<void>;
  info(): Promise<CloudflareSandboxInfo>;
}

export interface CloudflareSandboxBridge {
  createSandbox(input: {
    sandbox_id: string;
    workspace_id: string;
    cwd?: string;
    env?: Record<string, string>;
    metadata?: Record<string, string>;
  }): Promise<BridgeSandbox>;
  getSandbox(id: string): Promise<BridgeSandbox | null>;
  health(): Promise<{ readonly status: "healthy" | "unavailable"; readonly preview_enabled: boolean }>;
  authenticate(request: Request): Promise<void>;
}

export const handleCloudflareSandboxBridgeRequest = async (
  bridge: CloudflareSandboxBridge,
  request: Request,
): Promise<Response> => {
  try {
    await bridge.authenticate(request);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/health" && method === "GET") {
      return json(200, { ok: true, result: await bridge.health() });
    }

    if (url.pathname === "/sandboxes" && method === "POST") {
      const body = await jsonBody(request);
      const cwd = optionalStringField(body, "cwd");
      const env = objectField(body, "env") as Record<string, string> | undefined;
      const metadata = objectField(body, "metadata") as Record<string, string> | undefined;
      const sandbox = await bridge.createSandbox({
        sandbox_id: stringField(body, "sandbox_id"),
        workspace_id: stringField(body, "workspace_id"),
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env }),
        ...(metadata === undefined ? {} : { metadata }),
      });
      return json(201, { ok: true, result: await sandbox.info() });
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sandboxes" || parts[1] === undefined) {
      return json(404, { ok: false, error: "Not found", status: 404, code: "not_found" });
    }

    const sandbox = await bridge.getSandbox(decodeURIComponent(parts[1]));
    if (sandbox === null) {
      return json(404, { ok: false, error: "Sandbox not found", status: 404, code: "not_found" });
    }

    if (parts.length === 2 && method === "GET") {
      return json(200, { ok: true, result: await sandbox.info() });
    }
    if (parts.length === 2 && method === "DELETE") {
      await sandbox.delete();
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "pause" && method === "POST") {
      await sandbox.pause();
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "resume" && method === "POST") {
      await sandbox.resume();
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "exec" && method === "POST") {
      const body = await jsonBody(request);
      const cwd = optionalStringField(body, "cwd");
      const timeoutMs = optionalNumberField(body, "timeout_ms");
      const env = objectField(body, "env") as Record<string, string> | undefined;
      const stream = optionalBooleanField(body, "stream");
      return json(200, {
        ok: true,
        result: await sandbox.exec(stringField(body, "command"), {
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
          ...(env === undefined ? {} : { env }),
          ...(stream === undefined ? {} : { stream }),
        }),
      });
    }
    if (parts[2] === "files" && method === "PUT") {
      const body = await jsonBody(request);
      const entries = arrayField(body, "entries").map((entry) => ({
        path: stringField(entry, "path"),
        data: stringField(entry, "data"),
      }));
      await Promise.all(entries.map((entry) => sandbox.writeFile(entry.path, entry.data)));
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "files" && parts[3] === "read" && method === "POST") {
      const body = await jsonBody(request);
      return json(200, { ok: true, result: await sandbox.readFile(stringField(body, "path")) });
    }
    if (parts[2] === "mkdir" && method === "POST") {
      const body = await jsonBody(request);
      const paths = arrayField(body, "paths").map((entry) => stringField(entry, "path"));
      await Promise.all(paths.map((path) => sandbox.mkdir(path)));
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "processes" && parts.length === 3 && method === "POST") {
      const body = await jsonBody(request);
      const cwd = optionalStringField(body, "cwd");
      const timeoutMs = optionalNumberField(body, "timeout_ms");
      const env = objectField(body, "env") as Record<string, string> | undefined;
      const processId = optionalStringField(body, "process_id");
      return json(200, {
        ok: true,
        result: await sandbox.startProcess(stringField(body, "command"), {
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
          ...(env === undefined ? {} : { env }),
          ...(processId === undefined ? {} : { process_id: processId }),
        }),
      });
    }
    if (parts[2] === "processes" && parts[3] !== undefined && parts.length === 4 && method === "GET") {
      return json(200, { ok: true, result: await sandbox.getProcess(decodeURIComponent(parts[3])) });
    }
    if (parts[2] === "processes" && parts[3] !== undefined && parts.length === 4 && method === "DELETE") {
      await sandbox.killProcess(decodeURIComponent(parts[3]));
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "processes" && parts[3] !== undefined && parts[4] === "logs" && method === "GET") {
      return json(200, { ok: true, result: await sandbox.getProcessLogs(decodeURIComponent(parts[3])) });
    }
    if (parts[2] === "processes" && parts[3] !== undefined && parts[4] === "wait-for-port" && method === "POST") {
      const body = await jsonBody(request);
      const timeoutMs = optionalNumberField(body, "timeout_ms");
      await sandbox.waitForPort(decodeURIComponent(parts[3]), numberField(body, "port"), {
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      });
      return json(200, { ok: true, result: null });
    }
    if (parts[2] === "ports" && parts.length === 3 && method === "GET") {
      return json(200, { ok: true, result: await sandbox.listExposedPorts() });
    }
    if (parts[2] === "ports" && parts[3] !== undefined && parts[4] === "expose" && method === "POST") {
      const body = await jsonBody(request);
      const name = optionalStringField(body, "name");
      return json(200, {
        ok: true,
        result: await sandbox.exposePort(Number.parseInt(parts[3], 10), {
          ...(name === undefined ? {} : { name }),
        }),
      });
    }
    if (parts[2] === "ports" && parts[3] !== undefined && parts[4] === "expose" && method === "DELETE") {
      await sandbox.unexposePort(Number.parseInt(parts[3], 10));
      return json(200, { ok: true, result: null });
    }

    return json(404, { ok: false, error: "Not found", status: 404, code: "not_found" });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

const jsonBody = async (request: Request): Promise<Record<string, unknown>> => {
  const text = await request.text();
  if (text === "") {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
};

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const errorResponse = (error: unknown): Response => {
  if (error instanceof Error && typeof (error as { status?: unknown }).status === "number") {
    const typed = error as Error & { status: number; code?: string; retryAfterMs?: number; details?: Record<string, unknown> };
    return new Response(
      JSON.stringify({
        ok: false,
        error: typed.message,
        status: typed.status,
        ...(typed.code === undefined ? {} : { code: typed.code }),
        ...(typed.retryAfterMs === undefined ? {} : { retry_after_ms: typed.retryAfterMs }),
        ...(typed.details === undefined ? {} : { details: typed.details }),
      }),
      {
        status: typed.status,
        headers: {
          "Content-Type": "application/json",
          ...(typed.retryAfterMs === undefined ? {} : { "Retry-After": String(Math.ceil(typed.retryAfterMs / 1000)) }),
        },
      },
    );
  }
  return json(500, { ok: false, error: error instanceof Error ? error.message : "Bridge request failed", status: 500, code: "server_internal" });
};

const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw Object.assign(new Error(`${key} is required`), { status: 400, code: "invalid_request" });
  }
  return field;
};

const optionalStringField = (value: Record<string, unknown>, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
};

const numberField = (value: Record<string, unknown>, key: string): number => {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw Object.assign(new Error(`${key} must be a number`), { status: 400, code: "invalid_request" });
  }
  return field;
};

const optionalNumberField = (value: Record<string, unknown>, key: string): number | undefined => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const optionalBooleanField = (value: Record<string, unknown>, key: string): boolean | undefined => {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
};

const objectField = (value: Record<string, unknown>, key: string): Record<string, unknown> | undefined => {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field) ? (field as Record<string, unknown>) : undefined;
};

const arrayField = (value: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw Object.assign(new Error(`${key} must be an array`), { status: 400, code: "invalid_request" });
  }
  return field.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw Object.assign(new Error(`${key} entries must be objects`), { status: 400, code: "invalid_request" });
    }
    return entry as Record<string, unknown>;
  });
};
