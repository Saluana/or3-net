/**
 * @module sdk/sandbox/types
 *
 * Purpose:
 * Shared request, response, streaming, and error contracts for the sandbox SDK.
 *
 * Responsibilities:
 * - Define typed shapes for sandbox lifecycle, filesystem, exec, and tunnel APIs
 * - Provide runtime validation schemas for common payloads
 * - Describe the transport-neutral `SandboxClient` interface
 */
import { z } from "zod";
import { isoDateTimeSchema, jsonObjectSchema, nonEmptyStringSchema } from "../../src/contracts/shared.ts";

/** Purpose: Request-scoped metadata propagated as sandbox HTTP headers. */
export interface SandboxRequestContext {
  readonly requestId?: string;
  readonly workspaceId?: string;
}

/** Purpose: High-level sandbox status object returned by lifecycle APIs. */
export interface SandboxInfo {
  readonly id: string;
  readonly status: string;
  readonly workspace_id?: string;
  readonly runtime_backend?: string;
  readonly network_mode?: string;
}

/** Purpose: File read result returned by sandbox file APIs. */
export interface SandboxFileContent {
  readonly path: string;
  readonly content?: string;
  readonly content_base64?: string;
  readonly encoding?: string;
}

/** Purpose: Command execution request for a sandbox process. */
export interface SandboxExecRequest {
  readonly command: string[];
  readonly cwd?: string;
}

/** Purpose: Incremental event emitted by sandbox execution streams. */
export interface SandboxExecEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Purpose: Final execution result returned by non-streaming sandbox exec. */
export interface SandboxExecResult {
  readonly exit_code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: string;
}

/** Purpose: File write request for sandbox filesystem APIs. */
export interface SandboxWriteFileRequest {
  readonly path: string;
  readonly content: string;
}

/** Purpose: Optional path selection for workspace archive export. */
export interface SandboxWorkspaceExportRequest {
  readonly paths?: string[];
}

/** Purpose: Descriptor for an active sandbox tunnel. */
export interface SandboxTunnel {
  readonly id: string;
  readonly sandbox_id: string;
  readonly target_port: number;
  readonly endpoint: string;
  readonly access_token?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

/** Purpose: Request payload for creating a sandbox instance. */
export interface CreateSandboxRequest {
  readonly workspace_id?: string;
  readonly base_image_ref?: string;
  readonly start?: boolean;
  readonly allow_tunnels?: boolean;
  readonly network_mode?: string;
}

/** Purpose: Request payload for creating a sandbox tunnel. */
export interface CreateTunnelRequest {
  readonly target_port: number;
  readonly protocol?: string;
  readonly auth_mode?: string;
  readonly visibility?: string;
}

/** Purpose: Request payload for minting a signed tunnel URL. */
export interface CreateTunnelSignedUrlRequest {
  readonly path?: string;
  readonly ttl_seconds?: number;
}

/** Purpose: Signed URL result returned for a sandbox tunnel. */
export interface SandboxTunnelSignedUrl {
  readonly url: string;
  readonly expires_at: string;
  readonly capability_id?: string;
}

/** Purpose: Error payload shape returned by sandbox HTTP endpoints. */
export interface SandboxErrorResponse {
  readonly error: string;
  readonly code?: string;
  readonly status?: number;
}

/**
 * Purpose:
 * Rich error thrown by the sandbox SDK when an HTTP request fails.
 */
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

/** Purpose: Runtime health payload returned by the sandbox service. */
export interface RuntimeHealth {
  readonly status: string;
  readonly [key: string]: unknown;
}

/** Purpose: Opaque runtime info payload returned by the sandbox service. */
export type RuntimeInfo = Readonly<Record<string, unknown>>;

/** Purpose: Opaque runtime capacity payload returned by the sandbox service. */
export type RuntimeCapacity = Readonly<Record<string, unknown>>;

/** Purpose: Opaque quota payload returned by the sandbox service. */
export type SandboxQuota = Readonly<Record<string, unknown>>;

/**
 * Purpose:
 * Transport-neutral client interface for sandbox lifecycle, filesystem,
 * execution, tunnel, and runtime APIs.
 */
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

/** Purpose: Wire schema for sandbox creation requests. */
export const createSandboxRequestSchema = z.object({
  workspace_id: nonEmptyStringSchema.optional(),
  base_image_ref: nonEmptyStringSchema.optional(),
  start: z.boolean().optional(),
  allow_tunnels: z.boolean().optional(),
  network_mode: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for sandbox lifecycle responses. */
export const sandboxInfoSchema = z.object({
  id: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema.optional(),
  runtime_backend: nonEmptyStringSchema.optional(),
  network_mode: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for sandbox exec requests. */
export const sandboxExecRequestSchema = z.object({
  command: z.array(nonEmptyStringSchema).min(1),
  cwd: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for sandbox exec stream events. */
export const sandboxExecEventSchema = z.object({
  event: nonEmptyStringSchema,
  data: jsonObjectSchema,
});

/** Purpose: Wire schema for sandbox exec results. */
export const sandboxExecResultSchema = z.object({
  exit_code: z.number().int(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  status: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for sandbox tunnel descriptors. */
export const sandboxTunnelSchema = z.object({
  id: nonEmptyStringSchema,
  sandbox_id: nonEmptyStringSchema,
  target_port: z.number().int().positive(),
  endpoint: nonEmptyStringSchema,
  access_token: nonEmptyStringSchema.optional(),
  auth_mode: nonEmptyStringSchema.optional(),
  visibility: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for signed tunnel URL responses. */
export const sandboxTunnelSignedUrlSchema = z.object({
  url: nonEmptyStringSchema,
  expires_at: isoDateTimeSchema,
	capability_id: nonEmptyStringSchema.optional(),
});

/** Purpose: Wire schema for sandbox error responses. */
export const sandboxErrorResponseSchema = z.object({
  error: nonEmptyStringSchema,
  code: nonEmptyStringSchema,
  status: z.number().int().positive(),
});
