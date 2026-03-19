/**
 * @module src/api/app
 *
 * Purpose:
 * Main HTTP application surface for OR3 Net. This module maps incoming requests
 * to auth, job, runtime, preview, node, and workspace services while enforcing
 * consistent platform-style error handling.
 *
 * Responsibilities:
 * - Register and dispatch all first-party API routes
 * - Translate service errors into stable platform envelopes
 * - Keep request parsing, auth, and response shaping in one place
 *
 * Non-responsibilities:
 * - Does not construct service implementations
 * - Does not perform transport-level server startup
 */
import { z } from "zod";

import type { AuthService } from "../auth/service.ts";
import type { AgentService } from "../agents/index.ts";
import { agentSchema, previewDescriptorSchema, previewLaunchRequestSchema } from "../contracts/index.ts";
import { exchangeSessionRequestSchema } from "../contracts/platform/auth.ts";
import { platformErrorCodes, type PlatformErrorCode } from "../contracts/platform/error-codes.ts";
import type { AuditContext } from "../contracts/platform/types.ts";
import { defaultErrorCodeForStatus, normalizeInternError, normalizeProviderRequestError } from "../contracts/platform/compat.ts";
import type { WorkspacePrincipal } from "../auth/tokens.ts";
import { consoleEntryPath, renderConsoleHtml } from "../console/index.ts";
import type { LocalJobService } from "../execution/local-jobs.ts";
import { createJobRequestSchema } from "../execution/local-jobs.ts";
import type { NodeExecutionAdapter, ProviderRequestContext } from "../nodes/execution-adapter.ts";
import type { NodeRegistryService } from "../nodes/index.ts";
import { enrollNodeRequestSchema, issueNodeBootstrapTokenRequestSchema, redeemNodeBootstrapTokenRequestSchema } from "../nodes/index.ts";
import { PreviewStateError, type PreviewService } from "../previews/service.ts";
import { errorResponse, resolveRequestId } from "./response-helpers.ts";
import type { InMemoryWorkspaceFileService } from "../workspace/files.ts";
import type { ControlPlaneDatabase } from "../db/index.ts";
import type { StoredIdempotencyRecord } from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { RuntimeRegistry, RuntimeSessionService } from "../runtime/index.ts";
import type { RuntimeAdapter, RuntimeDescriptor, RuntimeSessionState } from "../contracts/runtime/index.ts";
import {
  RuntimeError,
  runtimeCopyInInputSchema,
  runtimeCopyOutInputSchema,
  runtimeErrorToApiEnvelope,
  runtimeExecutionRequestSchema,
  runtimePtyCloseInputSchema,
  runtimePtyStreamInputSchema,
  runtimePtyOpenInputSchema,
  runtimePtyResizeInputSchema,
  runtimePtyWriteInputSchema,
  runtimeSessionCreateInputSchema,
  runtimeSessionStateSchema,
} from "../contracts/runtime/index.ts";
import { InternRequestError } from "../../sdk/intern/types.ts";
import { isProviderRequestErrorLike as isOpenSandboxProviderRequestErrorLike } from "../../sdk/opensandbox/types.ts";
import { isProviderRequestErrorLike as isCloudflareSandboxProviderRequestErrorLike } from "../../sdk/cloudflare-sandbox/types.ts";

const DEFAULT_PUBLIC_BASE_URL = "http://localhost";
const DEFAULT_TRUSTED_REQUEST_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "or3.test"]);
const MAX_AUTH_EXCHANGE_BODY_BYTES = 128 * 1024;
const MAX_CREATE_JOB_BODY_BYTES = 256 * 1024;
const MAX_API_KEY_BODY_BYTES = 32 * 1024;
const MAX_AGENT_BODY_BYTES = 256 * 1024;
const MAX_NODE_ENROLL_BODY_BYTES = 256 * 1024;
const MAX_NODE_BOOTSTRAP_BODY_BYTES = 64 * 1024;
const MAX_RUNTIME_SESSION_CREATE_BODY_BYTES = 128 * 1024;
const MAX_RUNTIME_EXEC_BODY_BYTES = 256 * 1024;
const MAX_RUNTIME_COPY_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_PTY_BODY_BYTES = 64 * 1024;
const MAX_PREVIEW_BODY_BYTES = 128 * 1024;
const MAX_PREVIEW_LAUNCH_BODY_BYTES = 16 * 1024;
const MAX_LIST_QUERY_LIMIT = 100;
const MAX_RUNTIME_LOG_LIMIT = 500;
const MAX_SESSION_EVENT_LIMIT = 200;
const NO_STORE_CACHE_CONTROL = "no-store";

const isKnownProviderRequestError = (error: unknown): error is {
  readonly message: string;
  readonly status: number;
  readonly code?: string | undefined;
  readonly retryAfterMs?: number | undefined;
} => isOpenSandboxProviderRequestErrorLike(error) || isCloudflareSandboxProviderRequestErrorLike(error);

const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).min(1),
  expires_at: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), "invalid expires_at")
    .optional(),
});

interface AppServices {
  readonly database?: ControlPlaneDatabase;
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly publicBaseUrl?: string;
  readonly runtimeRegistry?: RuntimeRegistry;
  readonly runtimeSessionService?: RuntimeSessionService;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly agentService?: AgentService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly nodeExecutionAdapter?: NodeExecutionAdapter;
}

type RouteGroups = Record<string, string | undefined>;
type RouteHandler = (request: Request, groups: RouteGroups, url: URL) => Promise<Response> | Response;

interface RouteEntry {
  readonly pattern: URLPattern;
  readonly methods: ReadonlyMap<string, RouteHandler>;
}

/**
 * Purpose:
 * Request router and controller bundle for the OR3 Net HTTP API.
 *
 * Behavior:
 * Builds its route table once at construction time and dispatches requests to
 * service-backed handlers. Unknown routes fall back to a structured 404.
 */
export class Or3NetApp {
  private readonly routes: readonly RouteEntry[];

  public constructor(private readonly services: AppServices) {
    this.routes = this.createRoutes();
  }

  /**
   * Purpose:
   * Handles a single HTTP request against the registered OR3 Net route table.
   */
  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let matchedPath = false;

    for (const route of this.routes) {
      const match = route.pattern.exec(url);
      if (match === null) {
        continue;
      }

      matchedPath = true;

      const handler = route.methods.get(request.method);
      if (handler !== undefined) {
        return await handler(request, match.pathname.groups, url);
      }
    }

    if (matchedPath) {
      throw new HttpError(405, "method not allowed");
    }

    throw new HttpError(404, "route not found", { code: platformErrorCodes.resourceNotFound });
  }

  private createRoutes(): readonly RouteEntry[] {
    return [
      createRoute(consoleEntryPath, {
        GET: () => htmlResponse(renderConsoleHtml()),
      }),
      createRoute("/v1/launch/:token", {
        GET: (_request, groups) => this.handleLaunchCapability(requireGroup(groups, "token")),
      }),
      createRoute("/v1/launch/:token/:path*", {
        GET: (_request, groups) => this.handleLaunchCapability(requireGroup(groups, "token"), requireGroup(groups, "path")),
      }),
      createRoute("/v1/auth/exchange", {
        POST: (request) => this.handleExchange(request),
      }),
      createRoute("/v1/workspaces/:workspaceId/jobs", {
        GET: (request, groups, url) => this.handleListJobs(request, requireGroup(groups, "workspaceId"), url),
        POST: (request, groups) => this.handleCreateJob(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/api-keys", {
        GET: (request, groups) => this.handleListApiKeys(request, requireGroup(groups, "workspaceId")),
        POST: (request, groups) => this.handleCreateApiKey(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/api-keys/:apiKeyId/revoke", {
        POST: (request, groups) => this.handleRevokeApiKey(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "apiKeyId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/sessions", {
        GET: (request, groups, url) => this.handleListSessions(request, requireGroup(groups, "workspaceId"), url),
      }),
      createRoute("/v1/workspaces/:workspaceId/sessions/:sessionId", {
        GET: (request, groups) => this.handleGetSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/sessions/:sessionId/events", {
        GET: (request, groups, url) => this.handleListSessionEvents(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), url),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtimes", {
        GET: (request, groups) => this.handleListRuntimes(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtimes/:runtimeId", {
        GET: (request, groups) => this.handleGetRuntime(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "runtimeId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtimes/:runtimeId/nodes", {
        GET: (request, groups) => this.handleListRuntimeNodes(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "runtimeId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions", {
        GET: (request, groups, url) => this.handleListRuntimeSessions(request, requireGroup(groups, "workspaceId"), url),
        POST: (request, groups) => this.handleCreateRuntimeSession(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId", {
        GET: (request, groups) => this.handleGetRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/exec", {
        POST: (request, groups) => this.handleExecInRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/pty", {
        POST: (request, groups) => this.handleOpenRuntimeSessionPty(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/pty/:ptyId/write", {
        POST: (request, groups) => this.handleWriteRuntimeSessionPty(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), requireGroup(groups, "ptyId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/pty/:ptyId/resize", {
        POST: (request, groups) => this.handleResizeRuntimeSessionPty(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), requireGroup(groups, "ptyId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/pty/:ptyId/close", {
        POST: (request, groups) => this.handleCloseRuntimeSessionPty(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), requireGroup(groups, "ptyId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/pty/:ptyId/stream", {
        GET: (request, groups, url) => this.handleStreamRuntimeSessionPty(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), requireGroup(groups, "ptyId"), url),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/stop", {
        POST: (request, groups) => this.handleStopRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/destroy", {
        POST: (request, groups) => this.handleDestroyRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/commit", {
        POST: (request, groups) => this.handleCommitRuntimeSessionWorkspace(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/discard", {
        POST: (request, groups) => this.handleDiscardRuntimeSessionWorkspace(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/staging", {
        GET: (request, groups) => this.handleGetRuntimeSessionStaging(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/logs", {
        GET: (request, groups, url) => this.handleGetRuntimeSessionLogs(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId"), url),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-in", {
        POST: (request, groups) => this.handleCopyInRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-out", {
        POST: (request, groups) => this.handleCopyOutRuntimeSession(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "sessionId")),
      }),
      createRoute("/v1/jobs/:jobId", {
        GET: (request, groups) => this.handleGetJob(request, requireGroup(groups, "jobId")),
      }),
      createRoute("/v1/jobs/:jobId/stream", {
        GET: (request, groups) => this.handleStreamJob(request, requireGroup(groups, "jobId")),
      }),
      createRoute("/v1/jobs/:jobId/abort", {
        POST: (request, groups) => this.handleAbortJob(request, requireGroup(groups, "jobId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/agents", {
        GET: (request, groups) => this.handleListAgents(request, requireGroup(groups, "workspaceId")),
        POST: (request, groups) => this.handleCreateAgent(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/agents/:agentId", {
        GET: (request, groups) => this.handleGetAgent(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "agentId")),
        PATCH: (request, groups) => this.handleUpdateAgent(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "agentId")),
        PUT: (request, groups) => this.handleUpdateAgent(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "agentId")),
        DELETE: (request, groups) => this.handleDeleteAgent(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "agentId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes", {
        GET: (request, groups) => this.handleListNodes(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId", {
        GET: (request, groups) => this.handleGetNode(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/enroll", {
        POST: (request, groups) => this.handleEnrollNode(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/bootstrap-tokens", {
        POST: (request, groups) => this.handleIssueNodeBootstrapToken(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId/approve", {
        POST: (request, groups) => this.handleApproveNode(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId")),
      }),
      createRoute("/v1/nodes/bootstrap/redeem", {
        POST: (request) => this.handleRedeemNodeBootstrapToken(request),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId/services", {
        GET: (request, groups) => this.handleListNodeServices(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/launch", {
        POST: (request, groups) => this.handleLaunchNodeService(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId"), requireGroup(groups, "serviceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/revoke", {
        POST: (request, groups) => this.handleRevokeNodeService(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId"), requireGroup(groups, "serviceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/restart", {
        POST: (request, groups) => this.handleRestartNodeService(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "nodeId"), requireGroup(groups, "serviceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/previews", {
        GET: (request, groups) => this.handleListPreviews(request, requireGroup(groups, "workspaceId")),
        POST: (request, groups) => this.handleRegisterPreview(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/previews/:previewId/launch", {
        POST: (request, groups) => this.handleLaunchPreview(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "previewId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/previews/:previewId/revoke", {
        POST: (request, groups) => this.handleRevokePreview(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "previewId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/files", {
        GET: (request, groups) => this.handleFiles(request, requireGroup(groups, "workspaceId")),
      }),
      createRoute("/v1/workspaces/:workspaceId/files/:path*", {
        GET: (request, groups) => this.handleFiles(request, requireGroup(groups, "workspaceId"), requireGroup(groups, "path")),
      }),
    ];
  }

  private async handleExchange(request: Request): Promise<Response> {
    const { parsed: payload, fingerprint } = await readRequiredJsonPayload(request, exchangeSessionRequestSchema, MAX_AUTH_EXCHANGE_BODY_BYTES);
    const idempotencyKey = resolveIdempotencyKey(request.headers.get("Idempotency-Key"));
    const idempotencyScope = `auth.exchange:${payload.provider}`;
    const idempotencyOwnerKey = payload.workspace_id ?? payload.provider;
    const existing = this.readIdempotencyRecord(idempotencyScope, idempotencyOwnerKey, idempotencyKey, fingerprint);
    if (existing !== null) {
      return jsonResponse(existing.status_code, JSON.parse(existing.response_json) as unknown);
    }
    const token = await this.services.authService.exchangeSessionProof({
      provider: payload.provider,
      session_proof: payload.session_proof,
      ...(payload.workspace_id === undefined ? {} : { workspace_id: payload.workspace_id }),
    });
    this.saveIdempotencyRecord(idempotencyScope, idempotencyOwnerKey, idempotencyKey, fingerprint, token, 200, token.workspace_id, token.expires_at);
    return jsonResponse(200, token);
  }

  private async handleCreateJob(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "jobs:write");
    const { parsed: payload, fingerprint } = await readRequiredJsonPayload(request, createJobRequestSchema, MAX_CREATE_JOB_BODY_BYTES);
    const auditContext = createRequestAuditContext(request, principal);
    const idempotencyKey = resolveIdempotencyKey(request.headers.get("Idempotency-Key"));
    const existing = this.readIdempotencyRecord("jobs.create", principal.workspace_id, idempotencyKey, fingerprint);
    if (existing !== null) {
      return jsonResponse(existing.status_code, JSON.parse(existing.response_json) as unknown);
    }
    const job = this.services.localJobService.submitJob(principal.workspace_id, payload, {
      initiator_subject: principal.subject,
      request_id: auditContext.request_id,
    });
    this.saveIdempotencyRecord(
      "jobs.create",
      principal.workspace_id,
      idempotencyKey,
      fingerprint,
      job,
      202,
      job.job_id,
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    );
    return jsonResponse(202, job);
  }

  private async handleListJobs(request: Request, workspaceId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "jobs:read");
    const status = parseJobStatusFilter(url.searchParams.get("status"));
    const networkSessionId = url.searchParams.get("network_session_id") ?? undefined;
    const limit = clampLimit(parsePositiveIntegerQuery(url.searchParams.get("limit")), MAX_LIST_QUERY_LIMIT);
    const items = this.services.localJobService.listJobs(principal.workspace_id, {
      ...(status === undefined ? {} : { status }),
      ...(networkSessionId === undefined ? {} : { network_session_id: networkSessionId }),
      ...(limit === undefined ? {} : { limit }),
    });
    return jsonResponse(200, {
      items: items.map((item) => ({
        job_id: item.job.job_id,
        status: item.job.status,
        node_id: item.job.node_id ?? null,
        created_at: item.job.created_at,
        started_at: item.job.started_at ?? null,
        completed_at: item.job.completed_at ?? null,
        network_session_id: item.network_session_id,
      })),
    });
  }

  private async handleGetJob(request: Request, jobId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, undefined, "jobs:read");
    const job = this.services.localJobService.getJob(principal.workspace_id, jobId);
    return jsonResponse(200, job.job);
  }

  private async handleStreamJob(request: Request, jobId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, undefined, "jobs:read");
    const stream = this.services.localJobService.streamJob(principal.workspace_id, jobId);
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  private async handleAbortJob(request: Request, jobId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, undefined, "jobs:write");
    const response = await this.services.localJobService.abortJob(principal.workspace_id, jobId);
    return jsonResponse(200, response);
  }

  private async handleListApiKeys(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "api-keys:read");
    return jsonResponse(200, { items: this.services.authService.listApiKeys(principal.workspace_id).map(toApiKeyResponse) });
  }

  private async handleCreateApiKey(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "api-keys:write");
    const payload = createApiKeyRequestSchema.parse(await readJsonBody(request, MAX_API_KEY_BODY_BYTES));
    const created = await this.services.authService.createApiKey({
      workspace_id: principal.workspace_id,
      name: payload.name,
      scopes: payload.scopes,
      ...(payload.expires_at === undefined ? {} : { expires_at: payload.expires_at }),
    });
    return jsonResponse(201, {
      api_key: created.api_key,
      record: toApiKeyResponse(created.record),
    });
  }

  private async handleRevokeApiKey(request: Request, workspaceId: string, apiKeyId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "api-keys:write");
    return jsonResponse(200, {
      record: toApiKeyResponse(this.services.authService.revokeApiKey(principal.workspace_id, apiKeyId)),
    });
  }

  private async handleListSessions(request: Request, workspaceId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "sessions:read");
    const limit = clampLimit(parsePositiveIntegerQuery(url.searchParams.get("limit")), MAX_LIST_QUERY_LIMIT);
    return jsonResponse(200, {
      items: this.services.localJobService.listSessions(principal.workspace_id, { ...(limit === undefined ? {} : { limit }) }),
    });
  }

  private async handleGetSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "sessions:read");
    return jsonResponse(200, {
      session: this.services.localJobService.getSession(principal.workspace_id, sessionId),
      jobs: this.services.localJobService.listSessionJobs(principal.workspace_id, sessionId).map((item) => ({
        job_id: item.job.job_id,
        status: item.job.status,
        created_at: item.job.created_at,
      })),
    });
  }

  private async handleListSessionEvents(request: Request, workspaceId: string, sessionId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "sessions:read");
    const limit = clampLimit(parsePositiveIntegerQuery(url.searchParams.get("limit")), MAX_SESSION_EVENT_LIMIT);
    return jsonResponse(200, {
      items: this.services.localJobService.listSessionEvents(principal.workspace_id, sessionId, { ...(limit === undefined ? {} : { limit }) }),
    });
  }

  private async handleListRuntimes(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtimes:read");
    const registry = requireRuntimeRegistry(this.services.runtimeRegistry);
    const health = await registry.health(principal.workspace_id);
    return jsonResponse(200, {
      items: registry.list().map((adapter) => toRuntimeDescriptor(adapter, health[adapter.manifest.adapter_id])),
    });
  }

  private async handleGetRuntime(request: Request, workspaceId: string, runtimeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtimes:read");
    const registry = requireRuntimeRegistry(this.services.runtimeRegistry);
    const adapter = registry.get(runtimeId);
    if (adapter === undefined) {
      throw new HttpError(404, `runtime ${runtimeId} was not found`, { code: platformErrorCodes.resourceNotFound });
    }
    const health = await registry.health(principal.workspace_id);
    return jsonResponse(200, {
      runtime: toRuntimeDescriptor(adapter, health[adapter.manifest.adapter_id]),
    });
  }

  private async handleListRuntimeNodes(request: Request, workspaceId: string, runtimeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtimes:read");
    const adapter = requireRuntimeAdapter(requireRuntimeRegistry(this.services.runtimeRegistry), runtimeId);
    return jsonResponse(200, {
      items: await adapter.listNodes({ workspace_id: principal.workspace_id }),
    });
  }

  private async handleCreateRuntimeSession(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimeSessionCreateInputSchema.parse(await readJsonBody(request, MAX_RUNTIME_SESSION_CREATE_BODY_BYTES));
    const session = await requireRuntimeSessionService(this.services.runtimeSessionService).createSession(principal.workspace_id, payload);
    return jsonResponse(201, { session });
  }

  private async handleListRuntimeSessions(request: Request, workspaceId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    const status = parseRuntimeSessionStatusFilter(url.searchParams.get("status"));
    const adapterId = url.searchParams.get("adapter_id") ?? undefined;
    const limit = clampLimit(parsePositiveIntegerQuery(url.searchParams.get("limit")), MAX_LIST_QUERY_LIMIT);
    return jsonResponse(200, {
      items: requireRuntimeSessionService(this.services.runtimeSessionService).listSessions(principal.workspace_id, {
        ...(status === undefined ? {} : { status }),
        ...(adapterId === undefined ? {} : { adapter_id: adapterId }),
        ...(limit === undefined ? {} : { limit }),
      }),
    });
  }

  private async handleGetRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    return jsonResponse(200, {
      session: requireRuntimeSessionService(this.services.runtimeSessionService).getSession(principal.workspace_id, sessionId),
    });
  }

  private async handleExecInRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimeExecutionRequestSchema.parse(await readJsonBody(request, MAX_RUNTIME_EXEC_BODY_BYTES));
    const handle = await requireRuntimeSessionService(this.services.runtimeSessionService).exec(principal.workspace_id, sessionId, payload);
    if (wantsEventStream(request) && handle.stream !== undefined) {
      return runtimeExecutionStreamResponse(handle);
    }
    return jsonResponse(200, {
      execution_id: handle.execution_id,
      result: await handle.result,
    });
  }

  private async handleOpenRuntimeSessionPty(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimePtyOpenInputSchema.omit({ session_ref: true }).parse(await readJsonBody(request, MAX_RUNTIME_PTY_BODY_BYTES));
    const pty = await requireRuntimeSessionService(this.services.runtimeSessionService).openPty(principal.workspace_id, sessionId, payload);
    return jsonResponse(201, { pty });
  }

  private async handleWriteRuntimeSessionPty(request: Request, workspaceId: string, sessionId: string, ptyId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimePtyWriteInputSchema.omit({ session_ref: true, pty_id: true }).parse(await readJsonBody(request, MAX_RUNTIME_PTY_BODY_BYTES));
    const result = await requireRuntimeSessionService(this.services.runtimeSessionService).writePty(principal.workspace_id, sessionId, { ...payload, pty_id: ptyId });
    return jsonResponse(200, { result });
  }

  private async handleResizeRuntimeSessionPty(request: Request, workspaceId: string, sessionId: string, ptyId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimePtyResizeInputSchema.omit({ session_ref: true, pty_id: true }).parse(await readJsonBody(request, MAX_RUNTIME_PTY_BODY_BYTES));
    const result = await requireRuntimeSessionService(this.services.runtimeSessionService).resizePty(principal.workspace_id, sessionId, { ...payload, pty_id: ptyId });
    return jsonResponse(200, { result });
  }

  private async handleCloseRuntimeSessionPty(request: Request, workspaceId: string, sessionId: string, ptyId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    runtimePtyCloseInputSchema.omit({ session_ref: true, pty_id: true }).parse(await readOptionalJson(request, MAX_RUNTIME_PTY_BODY_BYTES));
    const result = await requireRuntimeSessionService(this.services.runtimeSessionService).closePty(principal.workspace_id, sessionId, { pty_id: ptyId });
    return jsonResponse(200, { result });
  }

  private async handleStreamRuntimeSessionPty(request: Request, workspaceId: string, sessionId: string, ptyId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    runtimePtyStreamInputSchema.omit({ session_ref: true, pty_id: true }).parse({ ...(cursor === undefined ? {} : { cursor }) });
    const stream = requireRuntimeSessionService(this.services.runtimeSessionService).streamPty(principal.workspace_id, sessionId, {
      pty_id: ptyId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return runtimePtyStreamResponse(stream);
  }

  private async handleStopRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const session = await requireRuntimeSessionService(this.services.runtimeSessionService).stopSession(principal.workspace_id, sessionId);
    return jsonResponse(200, { session });
  }

  private async handleDestroyRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const session = await requireRuntimeSessionService(this.services.runtimeSessionService).destroySession(principal.workspace_id, sessionId);
    return jsonResponse(200, { session });
  }

  private async handleCommitRuntimeSessionWorkspace(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const result = await requireRuntimeSessionService(this.services.runtimeSessionService).commitWorkspaceStage(principal.workspace_id, sessionId);
    return jsonResponse(200, { commit: result });
  }

  private async handleDiscardRuntimeSessionWorkspace(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const session = await requireRuntimeSessionService(this.services.runtimeSessionService).discardWorkspaceStage(principal.workspace_id, sessionId);
    return jsonResponse(200, { session });
  }

  private async handleGetRuntimeSessionStaging(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    const staging = await requireRuntimeSessionService(this.services.runtimeSessionService).getWorkspaceStageStatus(principal.workspace_id, sessionId);
    return jsonResponse(200, { staging });
  }

  private async handleGetRuntimeSessionLogs(request: Request, workspaceId: string, sessionId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = clampLimit(parsePositiveIntegerQuery(url.searchParams.get("limit")), MAX_RUNTIME_LOG_LIMIT);
    const logs = await requireRuntimeSessionService(this.services.runtimeSessionService).getLogs(principal.workspace_id, sessionId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    return jsonResponse(200, logs);
  }

  private async handleCopyInRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:write");
    const payload = runtimeCopyInInputSchema.omit({ session_ref: true }).parse(await readJsonBody(request, MAX_RUNTIME_COPY_BODY_BYTES));
    const transfer = await requireRuntimeSessionService(this.services.runtimeSessionService).copyIn(principal.workspace_id, sessionId, payload);
    return jsonResponse(200, { transfer });
  }

  private async handleCopyOutRuntimeSession(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "runtime-sessions:read");
    const payload = runtimeCopyOutInputSchema.omit({ session_ref: true }).parse(await readJsonBody(request, MAX_RUNTIME_COPY_BODY_BYTES));
    const transfer = await requireRuntimeSessionService(this.services.runtimeSessionService).copyOut(principal.workspace_id, sessionId, payload);
    return jsonResponse(200, { transfer });
  }

  private async handleListAgents(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:read");
    const agents = requireAgentService(this.services.agentService).listAgents(principal.workspace_id);
    return jsonResponse(200, { items: agents });
  }

  private async handleCreateAgent(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:write");
    const agent = agentSchema.parse(await readJsonBody(request, MAX_AGENT_BODY_BYTES));
    if (agent.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch", { code: platformErrorCodes.authWorkspaceMismatch });
    }
    return jsonResponse(201, {
      agent: requireAgentService(this.services.agentService).saveAgent(principal.workspace_id, agent),
    });
  }

  private async handleGetAgent(request: Request, workspaceId: string, agentId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:read");
    const agent = requireAgentService(this.services.agentService).getAgent(principal.workspace_id, agentId);
    return jsonResponse(200, { agent });
  }

  private async handleUpdateAgent(request: Request, workspaceId: string, agentId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:write");
    const agent = agentSchema.parse(await readJsonBody(request, MAX_AGENT_BODY_BYTES));
    if (agent.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch", { code: platformErrorCodes.authWorkspaceMismatch });
    }
    if (agent.agent_id !== agentId) {
      throw new HttpError(400, "agent id mismatch", { code: platformErrorCodes.inputInvalidParameter });
    }
    return jsonResponse(200, {
      agent: requireAgentService(this.services.agentService).saveAgent(principal.workspace_id, agent),
    });
  }

  private async handleDeleteAgent(request: Request, workspaceId: string, agentId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:write");
    requireAgentService(this.services.agentService).deleteAgent(principal.workspace_id, agentId);
    return new Response(null, { status: 204 });
  }

  private async handleListNodes(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:read");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    return jsonResponse(200, { items: registry.listNodes(principal.workspace_id) });
  }

  private async handleGetNode(request: Request, workspaceId: string, nodeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:read");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const nodes = registry.listNodes(principal.workspace_id);
    const node = nodes.find((n) => n.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new HttpError(404, `node ${nodeId} not found`);
    }
    return jsonResponse(200, {
      node,
      connection: {
        last_seen_at: node.last_seen_at,
        health_status: node.health_status,
        last_error: node.last_error,
      },
    });
  }

  private async handleEnrollNode(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:write");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const payload = enrollNodeRequestSchema.parse(await readJsonBody(request, MAX_NODE_ENROLL_BODY_BYTES));
    const node = await registry.enrollNode(principal.workspace_id, payload);
    return jsonResponse(202, { node });
  }

  private async handleApproveNode(request: Request, workspaceId: string, nodeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:write");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const approval = await registry.approveNode(principal.workspace_id, nodeId);
    return jsonResponse(200, approval);
  }

  private async handleIssueNodeBootstrapToken(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:write");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const payload = issueNodeBootstrapTokenRequestSchema.parse(await readOptionalJson(request, MAX_NODE_BOOTSTRAP_BODY_BYTES));
    const bootstrapToken = await registry.issueBootstrapToken(principal.workspace_id, payload);
    return jsonResponse(201, bootstrapToken);
  }

  private async handleRedeemNodeBootstrapToken(request: Request): Promise<Response> {
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const payload = redeemNodeBootstrapTokenRequestSchema.parse(await readJsonBody(request, MAX_NODE_BOOTSTRAP_BODY_BYTES));
    let redemption;
    try {
      redemption = await registry.redeemBootstrapToken(payload);
    } catch (error: unknown) {
      if (error instanceof Error && isNodeBootstrapClientError(error)) {
        throw new HttpError(400, error.message, { code: platformErrorCodes.inputInvalidParameter });
      }
      throw error;
    }
    return jsonResponse(200, redemption);
  }

  private async handleListNodeServices(request: Request, workspaceId: string, nodeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:read");
    const adapter = requireNodeExecutionAdapter(this.services.nodeExecutionAdapter);
    const node = this.requireLaunchableNode(principal.workspace_id, nodeId);
    return jsonResponse(200, { items: adapter.listServices(node) });
  }

  private async handleLaunchNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const adapter = requireNodeExecutionAdapter(this.services.nodeExecutionAdapter);
    const previewService = requirePreviewService(this.services.previewService);
    const auditContext = createRequestAuditContext(request, principal);
    const node = this.requireLaunchableNode(principal.workspace_id, nodeId);
    const internalLaunch = await adapter.prepareServiceLaunch(principal.workspace_id, node, serviceId, toProviderRequestContext(auditContext));
    const launch = previewService.mintLaunchCapability({
      origin: resolvePublicBaseUrl(this.services.publicBaseUrl, request.url),
      workspace_id: principal.workspace_id,
      scope_key: buildServiceLaunchScope(principal.workspace_id, nodeId, serviceId),
      target_url: internalLaunch.target_url,
      delivery_mode: internalLaunch.delivery_mode,
      supports_iframe: internalLaunch.supports_iframe,
      supports_new_tab: internalLaunch.supports_new_tab,
      reused_tunnel: internalLaunch.reused_tunnel,
      service_status: internalLaunch.service_status,
      expires_at: internalLaunch.expires_at,
    });
    return jsonResponse(200, launch);
  }

  private async handleRevokeNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const previewService = requirePreviewService(this.services.previewService);
    const auditContext = createRequestAuditContext(request, principal);
    const node = this.requireLaunchableNode(principal.workspace_id, nodeId);
    const revokedLaunches = previewService.revokeLaunchScope(buildServiceLaunchScope(principal.workspace_id, nodeId, serviceId));
    const revokedTunnels = await requireNodeExecutionAdapter(this.services.nodeExecutionAdapter).revokeServiceLaunch(
      principal.workspace_id,
      node,
      serviceId,
      toProviderRequestContext(auditContext),
    );
    return jsonResponse(200, { ok: true, revoked: revokedLaunches + revokedTunnels });
  }

  private async handleRestartNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const adapter = requireNodeExecutionAdapter(this.services.nodeExecutionAdapter);
    const previewService = requirePreviewService(this.services.previewService);
    const auditContext = createRequestAuditContext(request, principal);
    const node = this.requireLaunchableNode(principal.workspace_id, nodeId);
    previewService.revokeLaunchScope(buildServiceLaunchScope(principal.workspace_id, nodeId, serviceId));
    const result = await adapter.restartService(principal.workspace_id, node, serviceId, toProviderRequestContext(auditContext));
    return jsonResponse(200, result);
  }

  private async handleListPreviews(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:read");
    const previewService = requirePreviewService(this.services.previewService);
    return jsonResponse(200, { items: previewService.listPreviews(principal.workspace_id) });
  }

  private async handleRegisterPreview(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:write");
    const previewService = requirePreviewService(this.services.previewService);
    const preview = previewDescriptorSchema.parse(await readJsonBody(request, MAX_PREVIEW_BODY_BYTES));
    if (preview.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch", { code: platformErrorCodes.authWorkspaceMismatch });
    }
    if (preview.launch_url !== undefined || preview.embed_url !== undefined) {
      throw new HttpError(403, "caller-supplied browser URLs are not allowed");
    }
    return jsonResponse(201, { preview: previewService.registerPreview(principal.workspace_id, preview) });
  }

  private async handleLaunchPreview(request: Request, workspaceId: string, previewId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:read");
    const previewService = requirePreviewService(this.services.previewService);
    void createRequestAuditContext(request, principal);
    const launchRequest = previewLaunchRequestSchema.parse(await readOptionalJson(request, MAX_PREVIEW_LAUNCH_BODY_BYTES));
    const launch = previewService.launchPreview(principal.workspace_id, previewId, launchRequest, resolvePublicBaseUrl(this.services.publicBaseUrl, request.url));
    return jsonResponse(200, launch);
  }

  private async handleRevokePreview(request: Request, workspaceId: string, previewId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:write");
    const previewService = requirePreviewService(this.services.previewService);
    return jsonResponse(200, { preview: previewService.revokePreview(principal.workspace_id, previewId) });
  }

  private async handleFiles(request: Request, workspaceId: string, requestedPath?: string): Promise<Response> {
    const fileService = requireWorkspaceFileService(this.services.workspaceFileService);
    const principal = await this.requirePrincipal(request, workspaceId, "files:read");
    const normalizedFilePath = requestedPath?.trim() ?? "";
    if (normalizedFilePath === "") {
      return jsonResponse(200, { items: fileService.listFiles(principal.workspace_id) });
    }

    const file = fileService.readFile(principal.workspace_id, `/${normalizedFilePath}`);
    return new Response(file.content, {
      status: 200,
      headers: {
        "Content-Type": file.entry.mime_type ?? "text/plain; charset=utf-8",
        "Cache-Control": NO_STORE_CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private handleLaunchCapability(token: string, requestedPath?: string): Response {
    const previewService = requirePreviewService(this.services.previewService);
    const resolved = previewService.resolveLaunchCapability(token, requestedPath);
    if (resolved.kind === "files") {
      const file = requireWorkspaceFileService(this.services.workspaceFileService).readFile(resolved.workspace_id, resolved.file_path);
      return new Response(file.content, {
        status: 200,
        headers: {
          "Content-Type": file.entry.mime_type ?? "text/plain; charset=utf-8",
          "Cache-Control": NO_STORE_CACHE_CONTROL,
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return Response.redirect(resolved.target_url, 302);
  }

  private async requirePrincipal(
    request: Request,
    workspaceId: string | undefined,
    requiredScope: string,
  ): Promise<WorkspacePrincipal> {
    let principal: WorkspacePrincipal;
    try {
      principal = await this.services.authService.authenticateBearerToken(request.headers.get("Authorization"));
    } catch (error) {
      throw new HttpError(401, isExpiredAuthError(error) ? "token expired" : "unauthorized", {
        code: isExpiredAuthError(error) ? platformErrorCodes.authTokenExpired : platformErrorCodes.authTokenInvalid,
      });
    }
    if (workspaceId !== undefined && principal.workspace_id !== workspaceId) {
      throw new HttpError(403, "workspace mismatch", { code: platformErrorCodes.authWorkspaceMismatch });
    }
    if (!hasScope(principal, requiredScope)) {
      throw new HttpError(403, "missing required scope", { code: platformErrorCodes.authInsufficientScope });
    }
    return principal;
  }

  private readIdempotencyRecord(
    scope: string,
    ownerKey: string,
    idempotencyKey: string | undefined,
    requestBody: string,
  ): StoredIdempotencyRecord | null {
    if (idempotencyKey === undefined || this.services.database === undefined) {
      return null;
    }

    this.services.database.pruneExpiredIdempotencyRecords();
    const existing = this.services.database.getIdempotencyRecord(scope, ownerKey, idempotencyKey);
    if (existing === null) {
      return null;
    }
    if (existing.request_body !== requestBody) {
      throw new HttpError(409, "idempotency key was reused with a different request body", {
        code: platformErrorCodes.resourceConflict,
      });
    }
    return existing;
  }

  private saveIdempotencyRecord(
    scope: string,
    ownerKey: string,
    idempotencyKey: string | undefined,
    requestBody: string,
    responsePayload: unknown,
    statusCode: number,
    resourceId: string,
    expiresAt: string,
  ): void {
    if (idempotencyKey === undefined || this.services.database === undefined) {
      return;
    }

    this.services.database.saveIdempotencyRecord({
      scope,
      owner_key: ownerKey,
      idempotency_key: idempotencyKey,
      request_body: requestBody,
      response_json: JSON.stringify(responsePayload),
      status_code: statusCode,
      resource_id: resourceId,
      expires_at: expiresAt,
    });
  }

  private requireLaunchableNode(workspaceId: string, nodeId: string): ReturnType<NodeRegistryService["getNode"]> {
    try {
      const node = requireNodeRegistry(this.services.nodeRegistryService).getNode(workspaceId, nodeId);
      ensureLaunchableNode(node);
      return node;
    } catch (error: unknown) {
      if (error instanceof Error && isNotFoundError(error)) {
        throw new HttpError(404, "node not found", { code: platformErrorCodes.resourceNotFound });
      }
      throw error;
    }
  }
}

class HttpError extends Error {
  public readonly code: PlatformErrorCode;
  public readonly retry_after_ms: number | undefined;

  public constructor(
    public readonly status: number,
    message: string,
    options: { code?: PlatformErrorCode; retry_after_ms?: number } = {},
  ) {
    super(message);
    this.code = options.code ?? defaultErrorCodeForStatus(status);
    this.retry_after_ms = options.retry_after_ms;
  }
}

const hasScope = (principal: WorkspacePrincipal, requiredScope: string): boolean =>
  principal.scopes.includes("*") || principal.scopes.includes(requiredScope);

const jsonResponse = (status: number, payload: unknown): Response =>
  Response.json(payload, { status });

const htmlResponse = (html: string): Response =>
  new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_STORE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });

const requireGroup = (groups: Record<string, string | undefined>, key: string): string => {
  const value = groups[key];
  if (value === undefined) {
    throw new HttpError(404, `missing route parameter ${key}`, { code: platformErrorCodes.resourceNotFound });
  }
  return value;
};

const requireNodeRegistry = (service: NodeRegistryService | undefined): NodeRegistryService => {
  if (service === undefined) {
    throw new HttpError(503, "node registry is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requireRuntimeRegistry = (service: RuntimeRegistry | undefined): RuntimeRegistry => {
  if (service === undefined) {
    throw new HttpError(503, "runtime registry is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requireRuntimeSessionService = (service: RuntimeSessionService | undefined): RuntimeSessionService => {
  if (service === undefined) {
    throw new HttpError(503, "runtime session service is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requireRuntimeAdapter = (registry: RuntimeRegistry, runtimeId: string): RuntimeAdapter => {
  const adapter = registry.get(runtimeId);
  if (adapter === undefined) {
    throw new HttpError(404, `runtime ${runtimeId} was not found`, { code: platformErrorCodes.resourceNotFound });
  }
  return adapter;
};

const requireAgentService = (service: AgentService | undefined): AgentService => {
  if (service === undefined) {
    throw new HttpError(503, "agent service is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requirePreviewService = (service: PreviewService | undefined): PreviewService => {
  if (service === undefined) {
    throw new HttpError(503, "preview service is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requireWorkspaceFileService = (service: InMemoryWorkspaceFileService | undefined): InMemoryWorkspaceFileService => {
  if (service === undefined) {
    throw new HttpError(503, "workspace file service is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const requireNodeExecutionAdapter = (service: NodeExecutionAdapter | undefined): NodeExecutionAdapter => {
  if (service === undefined) {
    throw new HttpError(503, "node execution adapter is not configured", { code: platformErrorCodes.serverUnavailable });
  }
  return service;
};

const ensureLaunchableNode = (node: { status: string; health_status: string }): void => {
  if (node.status !== "approved") {
    throw new HttpError(403, "node is not approved");
  }
  if (node.health_status === "stale") {
    throw new HttpError(403, "node is not healthy enough for service launch");
  }
};

const buildServiceLaunchScope = (workspaceId: string, nodeId: string, serviceId: string): string =>
  `service:${workspaceId}:${nodeId}:${serviceId}`;

const readJsonBody = async (request: Request, maxBytes = MAX_PREVIEW_BODY_BYTES): Promise<unknown> => parseJsonBody(await readTextBody(request, maxBytes));

const readOptionalJson = async (request: Request, maxBytes = MAX_PREVIEW_LAUNCH_BODY_BYTES): Promise<unknown> => {
  const text = await readTextBody(request, maxBytes);
  if (text.trim() === "") {
    return {};
  }
  return parseJsonBody(text);
};

const parseJobStatusFilter = (value: string | null): "running" | "terminal" | "all" | undefined => {
  if (value === null || value === "") {
    return undefined;
  }
  if (value === "running" || value === "terminal" || value === "all") {
    return value;
  }
  throw new HttpError(400, "invalid status filter", { code: platformErrorCodes.inputInvalidParameter });
};

const parseRuntimeSessionStatusFilter = (value: string | null): RuntimeSessionState | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  return runtimeSessionStateSchema.parse(value);
};

const parsePositiveIntegerQuery = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "invalid numeric query parameter", { code: platformErrorCodes.inputInvalidParameter });
  }
  return parsed;
};

const clampLimit = (value: number | undefined, max: number): number | undefined =>
  value === undefined ? undefined : Math.min(value, max);

const toApiKeyResponse = (record: ReturnType<AuthService["listApiKeys"]>[number]): Record<string, unknown> => ({
  api_key_id: record.api_key_id,
  workspace_id: record.workspace_id,
  name: record.name,
  scopes: record.scopes,
  created_at: record.created_at,
  expires_at: record.expires_at,
  revoked_at: record.revoked_at,
});

const toRuntimeDescriptor = (adapter: RuntimeAdapter, health?: RuntimeDescriptor["health"]): RuntimeDescriptor => ({
  adapter_id: adapter.manifest.adapter_id,
  display_name: adapter.manifest.display_name,
  isolation_class: adapter.manifest.isolation_class,
  trust_tier: adapter.manifest.trust_tier,
  locality: adapter.manifest.locality,
  health: health ?? { status: "unavailable", checked_at: new Date().toISOString() },
  capabilities: adapter.manifest.capabilities,
  supported_presets: [...adapter.manifest.supported_presets],
  session_modes: [...adapter.manifest.session_modes],
});

/**
 * Purpose:
 * Wraps `Or3NetApp.fetch()` with the shared top-level HTTP error normalization
 * used by the server entry point.
 */
export const handleAppRequest = async (app: Or3NetApp, request: Request): Promise<Response> => {
  const requestId = resolveRequestId(request.headers.get("X-Request-Id"));
  const normalizedRequest = withRequestId(request, requestId);
  try {
    const response = await app.fetch(normalizedRequest);
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse({
        error: error.message,
        status: error.status,
        code: error.code,
        request_id: requestId,
        ...(error.retry_after_ms === undefined ? {} : { retry_after_ms: error.retry_after_ms }),
      });
    }
    if (error instanceof RuntimeError) {
      return errorResponse(runtimeErrorToApiEnvelope(error, requestId));
    }
    if (isKnownProviderRequestError(error)) {
      return errorResponse(normalizeProviderRequestError(error, requestId));
    }
    if (error instanceof InternRequestError) {
      return errorResponse(normalizeInternError(error, requestId));
    }
    if (error instanceof PreviewStateError) {
      return errorResponse({
        error: error.message,
        status: error.status,
        code: previewStateErrorCode(error),
        request_id: requestId,
      });
    }
    if (error instanceof z.ZodError) {
      return errorResponse({
        error: error.issues[0]?.message ?? "invalid request",
        status: 400,
        code: platformErrorCodes.inputInvalidParameter,
        request_id: requestId,
      });
    }
    if (error instanceof Error && isNotFoundError(error)) {
      return errorResponse({
        error: error.message,
        status: 404,
        code: platformErrorCodes.resourceNotFound,
        request_id: requestId,
      });
    }
    return errorResponse({
      error: "internal server error",
      status: 500,
      code: platformErrorCodes.serverInternal,
      request_id: requestId,
    });
  }
};

const withRequestId = (request: Request, requestId: string): Request => {
  const headers = new Headers(request.headers);
  headers.set("X-Request-Id", requestId);
  return new Request(request, { headers });
};

const isNotFoundError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return message.includes("was not found") || message.endsWith("not found");
};

const isNodeBootstrapClientError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return message.includes("bootstrap token") || message.includes("different public key");
};

const previewStateErrorCode = (error: PreviewStateError): PlatformErrorCode => {
  const message = error.message.toLowerCase();
  if (message.includes("expired")) {
    return platformErrorCodes.capabilityExpired;
  }
  if (message.includes("revoked")) {
    return platformErrorCodes.capabilityRevoked;
  }
  if (error.status === 403) {
    return platformErrorCodes.inputInvalidParameter;
  }
  return defaultErrorCodeForStatus(error.status);
};

const isExpiredAuthError = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes("expired");

const resolveIdempotencyKey = (value: string | null): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

const wantsEventStream = (request: Request): boolean =>
  request.headers.get("Accept")?.toLowerCase().includes("text/event-stream") ?? false;

const runtimeExecutionStreamResponse = (handle: Awaited<ReturnType<RuntimeSessionService["exec"]>>): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          if (handle.stream !== undefined) {
            for await (const event of handle.stream) {
              controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
            }
          }
          const result = await handle.result;
          controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({ execution_id: handle.execution_id, result })}\n\n`));
          controller.close();
        } catch (error: unknown) {
          const payload = error instanceof RuntimeError ? error.toEnvelope() : { message: error instanceof Error ? error.message : "runtime exec failed" };
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
};

const runtimePtyStreamResponse = (stream: AsyncIterable<{ event: string; data: Record<string, unknown> }>): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for await (const event of stream) {
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          controller.close();
        } catch (error: unknown) {
          const payload = error instanceof RuntimeError ? error.toEnvelope() : { message: error instanceof Error ? error.message : "PTY stream failed" };
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
          controller.close();
        }
      })();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
};

const createRoute = (pathname: string, methods: Record<string, RouteHandler>): RouteEntry => ({
  pattern: new URLPattern({ pathname }),
  methods: new Map(Object.entries(methods)),
});

const readRequiredJsonPayload = async <T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<{ parsed: T; fingerprint: string }> => {
  const text = await readTextBody(request, maxBytes);
  if (text.trim() === "") {
    throw new HttpError(400, "invalid JSON body", { code: platformErrorCodes.inputMalformedBody });
  }

  const parsed = parseJsonBody(text);

  return {
    parsed: schema.parse(parsed),
    fingerprint: await sha256Hex(text),
  };
};

const createRequestAuditContext = (request: Request, principal: WorkspacePrincipal): AuditContext => ({
  request_id: resolveRequestId(request.headers.get("X-Request-Id")),
  workspace_id: principal.workspace_id,
  subject: principal.subject,
});

const toProviderRequestContext = (auditContext: AuditContext): ProviderRequestContext => ({
  requestId: auditContext.request_id,
  workspaceId: auditContext.workspace_id,
});

const readTextBody = async (request: Request, maxBytes: number): Promise<string> => {
  const body = request.body as (AsyncIterable<Uint8Array> | null);
  if (body === null) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "request body too large", { code: platformErrorCodes.inputMalformedBody });
    }
    chunks.push(chunk);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
};

const parseJsonBody = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HttpError(400, "invalid JSON body", { code: platformErrorCodes.inputMalformedBody });
    }
    throw error;
  }
};

const resolvePublicBaseUrl = (configuredPublicBaseUrl: string | undefined, requestUrl: string): string => {
  if (configuredPublicBaseUrl !== undefined && configuredPublicBaseUrl.trim() !== "") {
    return normalizePublicBaseUrl(configuredPublicBaseUrl);
  }

  const requestOrigin = new URL(requestUrl).origin;
  const parsedOrigin = new URL(requestOrigin);
  if (
    (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:")
    && DEFAULT_TRUSTED_REQUEST_ORIGIN_HOSTS.has(parsedOrigin.hostname)
  ) {
    return parsedOrigin.origin;
  }

  return DEFAULT_PUBLIC_BASE_URL;
};

const normalizePublicBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("publicBaseUrl must use http or https");
  }
  return parsed.origin;
};
