import { z } from "zod";
import { isoDateTimeSchema, jsonObjectSchema, nonEmptyStringSchema } from "../../src/contracts/shared.ts";

export interface SandboxRequestContext {
  readonly requestId?: string;
  readonly workspaceId?: string;
}

export interface SandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly workspace_id?: string;
  readonly runtime_backend?: string;
  readonly network_mode?: string;
}

export interface SandboxFileContent {
  readonly path: string;
  readonly content?: string;
  readonly content_base64?: string;
  readonly encoding?: string;
}

export interface SandboxExecRequest {
  readonly command: string[];
  readonly cwd?: string;
}

export interface SandboxExecEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface SandboxExecResult {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: string;
}

export interface SandboxWriteFileRequest {
  readonly path: string;
  readonly content: string;
}

export interface SandboxWorkspaceExportRequest {
  readonly paths?: string[];
}

export interface SandboxTunnel {
  readonly id: string;
  readonly sandbox_id: string;
  readonly target_port: number;
  readonly endpoint: string;
  readonly access_token?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

export interface CreateSandboxRequest {
  readonly workspace_id?: string;
  readonly base_image_ref?: string;
  readonly start?: boolean;
  readonly allow_tunnels?: boolean;
  readonly network_mode?: string;
}

export interface CreateTunnelRequest {
  readonly target_port: number;
  readonly protocol?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

export interface CreateTunnelSignedUrlRequest {
  readonly path?: string;
  readonly ttl_seconds?: number;
}

export interface SandboxTunnelSignedUrl {
  readonly url: string;
  readonly expires_at: string;
  readonly capability_id?: string;
}

export interface SandboxErrorResponse {
  readonly error: string;
  readonly code?: string;
  readonly status?: number;
}

export class SandboxRequestError extends Error {
  public override readonly name = "SandboxRequestError";

  public constructor(
    message: string,
    public readonly status: number,
    public readonly response?: SandboxErrorResponse,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface RuntimeHealth {
  readonly status: string;
  readonly [key: string]: unknown;
}

export type RuntimeInfo = Readonly<Record<string, unknown>>;

export type RuntimeCapacity = Readonly<Record<string, unknown>>;

export type SandboxQuota = Readonly<Record<string, unknown>>;

export interface SandboxClient {
  create(request: CreateSandboxRequest, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  list(requestContext?: SandboxRequestContext): Promise<SandboxInfo[]>;
  get(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  delete(sandboxId: string, requestContext?: SandboxRequestContext): Promise<void>;
  start(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  stop(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  suspend(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  resume(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxInfo>;
  exec(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): Promise<SandboxExecResult>;
  execStream(sandboxId: string, request: SandboxExecRequest, requestContext?: SandboxRequestContext): AsyncIterable<SandboxExecEvent>;
  readFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<SandboxFileContent>;
  writeFile(sandboxId: string, request: SandboxWriteFileRequest, requestContext?: SandboxRequestContext): Promise<void>;
  deleteFile(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void>;
  mkdir(sandboxId: string, path: string, requestContext?: SandboxRequestContext): Promise<void>;
  importWorkspaceArchive(sandboxId: string, archive: Uint8Array, requestContext?: SandboxRequestContext): Promise<void>;
  exportWorkspaceArchive(sandboxId: string, request?: SandboxWorkspaceExportRequest, requestContext?: SandboxRequestContext): Promise<Uint8Array>;
  createTunnel(sandboxId: string, request: CreateTunnelRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnel>;
  listTunnels(sandboxId: string, requestContext?: SandboxRequestContext): Promise<SandboxTunnel[]>;
  revokeTunnel(tunnelId: string, requestContext?: SandboxRequestContext): Promise<void>;
  createSignedTunnelUrl(tunnelId: string, request?: CreateTunnelSignedUrlRequest, requestContext?: SandboxRequestContext): Promise<SandboxTunnelSignedUrl>;
  runtimeInfo(requestContext?: SandboxRequestContext): Promise<RuntimeInfo>;
  runtimeHealth(requestContext?: SandboxRequestContext): Promise<RuntimeHealth>;
  runtimeCapacity(requestContext?: SandboxRequestContext): Promise<RuntimeCapacity>;
  getQuota(requestContext?: SandboxRequestContext): Promise<SandboxQuota>;
  getMetrics(requestContext?: SandboxRequestContext): Promise<string>;
}

export const createSandboxRequestSchema = z.object({
  workspace_id: nonEmptyStringSchema.optional(),
  base_image_ref: nonEmptyStringSchema.optional(),
  start: z.boolean().optional(),
  allow_tunnels: z.boolean().optional(),
  network_mode: nonEmptyStringSchema.optional(),
});

export const sandboxInfoSchema = z.object({
  id: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema.optional(),
  runtime_backend: nonEmptyStringSchema.optional(),
  network_mode: nonEmptyStringSchema.optional(),
});

export const sandboxExecRequestSchema = z.object({
  command: z.array(nonEmptyStringSchema).min(1),
  cwd: nonEmptyStringSchema.optional(),
});

export const sandboxExecEventSchema = z.object({
  event: nonEmptyStringSchema,
  data: jsonObjectSchema,
});

export const sandboxExecResultSchema = z.object({
  exit_code: z.number().int(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  status: nonEmptyStringSchema.optional(),
});

export const sandboxTunnelSchema = z.object({
  id: nonEmptyStringSchema,
  sandbox_id: nonEmptyStringSchema,
  target_port: z.number().int().positive(),
  endpoint: nonEmptyStringSchema,
  access_token: nonEmptyStringSchema.optional(),
  auth_mode: nonEmptyStringSchema.optional(),
  visibility: nonEmptyStringSchema.optional(),
});

export const sandboxTunnelSignedUrlSchema = z.object({
  url: nonEmptyStringSchema,
  expires_at: isoDateTimeSchema,
	capability_id: nonEmptyStringSchema.optional(),
});

export const sandboxErrorResponseSchema = z.object({
  error: nonEmptyStringSchema,
  code: nonEmptyStringSchema,
  status: z.number().int().positive(),
});
