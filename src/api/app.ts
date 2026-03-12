import { z } from "zod";

import type { AuthService } from "../auth/service.ts";
import type { AgentService } from "../agents/index.ts";
import { agentSchema, previewDescriptorSchema, previewLaunchRequestSchema } from "../contracts/index.ts";
import type { WorkspacePrincipal } from "../auth/tokens.ts";
import { consoleEntryPath, renderConsoleHtml } from "../console/index.ts";
import type { LocalJobService } from "../execution/local-jobs.ts";
import { createJobRequestSchema } from "../execution/local-jobs.ts";
import type { SandboxNodeAdapter } from "../nodes/adapter-sandbox.ts";
import type { NodeRegistryService } from "../nodes/index.ts";
import { enrollNodeRequestSchema } from "../nodes/index.ts";
import { PreviewStateError, type PreviewService } from "../previews/service.ts";
import type { InMemoryWorkspaceFileService } from "../workspace/files.ts";

const exchangeSessionRequestSchema = z.object({
  provider: z.string().trim().min(1),
  session_proof: z.record(z.string(), z.unknown()),
  workspace_id: z.string().trim().min(1).optional(),
});

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
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly agentService?: AgentService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

export class Or3NetApp {
  public constructor(private readonly services: AppServices) {}

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === consoleEntryPath) {
      return htmlResponse(renderConsoleHtml());
    }

    const launchCapabilityMatch = new URLPattern({ pathname: "/v1/launch/:token" }).exec(url);
    if (request.method === "GET" && launchCapabilityMatch !== null) {
      return this.handleLaunchCapability(requireGroup(launchCapabilityMatch.pathname.groups, "token"));
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/exchange") {
      return this.handleExchange(request);
    }

    const createJobMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/jobs" }).exec(url);
    if (createJobMatch !== null) {
      const workspaceId = requireGroup(createJobMatch.pathname.groups, "workspaceId");
      if (request.method === "POST") {
        return this.handleCreateJob(request, workspaceId);
      }
      if (request.method === "GET") {
        return this.handleListJobs(request, workspaceId, url);
      }
    }

    const apiKeysMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/api-keys" }).exec(url);
    if (apiKeysMatch !== null) {
      const workspaceId = requireGroup(apiKeysMatch.pathname.groups, "workspaceId");
      if (request.method === "GET") {
        return this.handleListApiKeys(request, workspaceId);
      }
      if (request.method === "POST") {
        return this.handleCreateApiKey(request, workspaceId);
      }
    }

    const revokeApiKeyMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/api-keys/:apiKeyId/revoke" }).exec(url);
    if (request.method === "POST" && revokeApiKeyMatch !== null) {
      return this.handleRevokeApiKey(
        request,
        requireGroup(revokeApiKeyMatch.pathname.groups, "workspaceId"),
        requireGroup(revokeApiKeyMatch.pathname.groups, "apiKeyId"),
      );
    }

    const sessionsMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/sessions" }).exec(url);
    if (request.method === "GET" && sessionsMatch !== null) {
      return this.handleListSessions(request, requireGroup(sessionsMatch.pathname.groups, "workspaceId"));
    }

    const sessionMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/sessions/:sessionId" }).exec(url);
    if (request.method === "GET" && sessionMatch !== null) {
      return this.handleGetSession(
        request,
        requireGroup(sessionMatch.pathname.groups, "workspaceId"),
        requireGroup(sessionMatch.pathname.groups, "sessionId"),
      );
    }

    const sessionEventsMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/sessions/:sessionId/events" }).exec(url);
    if (request.method === "GET" && sessionEventsMatch !== null) {
      return this.handleListSessionEvents(
        request,
        requireGroup(sessionEventsMatch.pathname.groups, "workspaceId"),
        requireGroup(sessionEventsMatch.pathname.groups, "sessionId"),
      );
    }

    const jobMatch = new URLPattern({ pathname: "/v1/jobs/:jobId" }).exec(url);
    if (request.method === "GET" && jobMatch !== null) {
      return this.handleGetJob(request, requireGroup(jobMatch.pathname.groups, "jobId"));
    }

    const jobStreamMatch = new URLPattern({ pathname: "/v1/jobs/:jobId/stream" }).exec(url);
    if (request.method === "GET" && jobStreamMatch !== null) {
      return this.handleStreamJob(request, requireGroup(jobStreamMatch.pathname.groups, "jobId"));
    }

    const jobAbortMatch = new URLPattern({ pathname: "/v1/jobs/:jobId/abort" }).exec(url);
    if (request.method === "POST" && jobAbortMatch !== null) {
      return this.handleAbortJob(request, requireGroup(jobAbortMatch.pathname.groups, "jobId"));
    }

    const agentsMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/agents" }).exec(url);
    if (agentsMatch !== null) {
      const workspaceId = requireGroup(agentsMatch.pathname.groups, "workspaceId");
      if (request.method === "GET") {
        return this.handleListAgents(request, workspaceId);
      }
      if (request.method === "POST") {
        return this.handleCreateAgent(request, workspaceId);
      }
    }

    const agentMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/agents/:agentId" }).exec(url);
    if (agentMatch !== null) {
      const workspaceId = requireGroup(agentMatch.pathname.groups, "workspaceId");
      const agentId = requireGroup(agentMatch.pathname.groups, "agentId");
      if (request.method === "GET") {
        return this.handleGetAgent(request, workspaceId, agentId);
      }
      if (request.method === "PUT" || request.method === "PATCH") {
        return this.handleUpdateAgent(request, workspaceId, agentId);
      }
      if (request.method === "DELETE") {
        return this.handleDeleteAgent(request, workspaceId, agentId);
      }
    }

    const nodesMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes" }).exec(url);
    if (nodesMatch !== null) {
      const workspaceId = requireGroup(nodesMatch.pathname.groups, "workspaceId");
      if (request.method === "GET") {
        return this.handleListNodes(request, workspaceId);
      }
    }

    const enrollMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/enroll" }).exec(url);
    if (request.method === "POST" && enrollMatch !== null) {
      return this.handleEnrollNode(request, requireGroup(enrollMatch.pathname.groups, "workspaceId"));
    }

    const approveMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/:nodeId/approve" }).exec(url);
    if (request.method === "POST" && approveMatch !== null) {
      return this.handleApproveNode(
        request,
        requireGroup(approveMatch.pathname.groups, "workspaceId"),
        requireGroup(approveMatch.pathname.groups, "nodeId"),
      );
    }

    const nodeServicesMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/:nodeId/services" }).exec(url);
    if (request.method === "GET" && nodeServicesMatch !== null) {
      return this.handleListNodeServices(
        request,
        requireGroup(nodeServicesMatch.pathname.groups, "workspaceId"),
        requireGroup(nodeServicesMatch.pathname.groups, "nodeId"),
      );
    }

    const nodeServiceLaunchMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/launch" }).exec(url);
    if (request.method === "POST" && nodeServiceLaunchMatch !== null) {
      return this.handleLaunchNodeService(
        request,
        requireGroup(nodeServiceLaunchMatch.pathname.groups, "workspaceId"),
        requireGroup(nodeServiceLaunchMatch.pathname.groups, "nodeId"),
        requireGroup(nodeServiceLaunchMatch.pathname.groups, "serviceId"),
      );
    }

    const nodeServiceRevokeMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/revoke" }).exec(url);
    if (request.method === "POST" && nodeServiceRevokeMatch !== null) {
      return this.handleRevokeNodeService(
        request,
        requireGroup(nodeServiceRevokeMatch.pathname.groups, "workspaceId"),
        requireGroup(nodeServiceRevokeMatch.pathname.groups, "nodeId"),
        requireGroup(nodeServiceRevokeMatch.pathname.groups, "serviceId"),
      );
    }

    const nodeServiceRestartMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/restart" }).exec(url);
    if (request.method === "POST" && nodeServiceRestartMatch !== null) {
      return this.handleRestartNodeService(
        request,
        requireGroup(nodeServiceRestartMatch.pathname.groups, "workspaceId"),
        requireGroup(nodeServiceRestartMatch.pathname.groups, "nodeId"),
        requireGroup(nodeServiceRestartMatch.pathname.groups, "serviceId"),
      );
    }

    const previewsMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/previews" }).exec(url);
    if (previewsMatch !== null) {
      const workspaceId = requireGroup(previewsMatch.pathname.groups, "workspaceId");
      if (request.method === "GET") {
        return this.handleListPreviews(request, workspaceId);
      }
      if (request.method === "POST") {
        return this.handleRegisterPreview(request, workspaceId);
      }
    }

    const previewLaunchMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/previews/:previewId/launch" }).exec(url);
    if (request.method === "POST" && previewLaunchMatch !== null) {
      return this.handleLaunchPreview(
        request,
        requireGroup(previewLaunchMatch.pathname.groups, "workspaceId"),
        requireGroup(previewLaunchMatch.pathname.groups, "previewId"),
      );
    }

    const previewRevokeMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/previews/:previewId/revoke" }).exec(url);
    if (request.method === "POST" && previewRevokeMatch !== null) {
      return this.handleRevokePreview(
        request,
        requireGroup(previewRevokeMatch.pathname.groups, "workspaceId"),
        requireGroup(previewRevokeMatch.pathname.groups, "previewId"),
      );
    }

    const filesPrefix = "/v1/workspaces/";
    if (url.pathname.startsWith(filesPrefix) && url.pathname.includes("/files")) {
      return this.handleFiles(request, url.pathname);
    }

    return jsonResponse(404, { error: "route not found" });
  }

  private async handleExchange(request: Request): Promise<Response> {
    const payload = exchangeSessionRequestSchema.parse(await request.json());
    const token = await this.services.authService.exchangeSessionProof({
      provider: payload.provider,
      session_proof: payload.session_proof,
      ...(payload.workspace_id === undefined ? {} : { workspace_id: payload.workspace_id }),
    });
    return jsonResponse(200, token);
  }

  private async handleCreateJob(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "jobs:write");
    const payload = createJobRequestSchema.parse(await request.json());
    const job = this.services.localJobService.submitJob(principal.workspace_id, payload, {
      initiator_subject: principal.subject,
    });
    return jsonResponse(202, job);
  }

  private async handleListJobs(request: Request, workspaceId: string, url: URL): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "jobs:read");
    const status = parseJobStatusFilter(url.searchParams.get("status"));
    const networkSessionId = url.searchParams.get("network_session_id") ?? undefined;
    const items = this.services.localJobService.listJobs(principal.workspace_id, {
      ...(status === undefined ? {} : { status }),
      ...(networkSessionId === undefined ? {} : { network_session_id: networkSessionId }),
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
    const payload = createApiKeyRequestSchema.parse(await request.json());
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

  private async handleListSessions(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "sessions:read");
    return jsonResponse(200, {
      items: this.services.localJobService.listSessions(principal.workspace_id),
    } as unknown as Record<string, unknown>);
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
    } as unknown as Record<string, unknown>);
  }

  private async handleListSessionEvents(request: Request, workspaceId: string, sessionId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "sessions:read");
    return jsonResponse(200, {
      items: this.services.localJobService.listSessionEvents(principal.workspace_id, sessionId),
    } as unknown as Record<string, unknown>);
  }

  private async handleListAgents(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:read");
    const agents = requireAgentService(this.services.agentService).listAgents(principal.workspace_id);
    return jsonResponse(200, { items: agents });
  }

  private async handleCreateAgent(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "agents:write");
    const agent = agentSchema.parse(await request.json());
    if (agent.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch");
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
    const agent = agentSchema.parse(await request.json());
    if (agent.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch");
    }
    if (agent.agent_id !== agentId) {
      throw new HttpError(400, "agent id mismatch");
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

  private async handleEnrollNode(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:write");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const payload = enrollNodeRequestSchema.parse(await request.json());
    const node = await registry.enrollNode(principal.workspace_id, payload);
    return jsonResponse(202, { node });
  }

  private async handleApproveNode(request: Request, workspaceId: string, nodeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "nodes:write");
    const registry = requireNodeRegistry(this.services.nodeRegistryService);
    const approval = await registry.approveNode(principal.workspace_id, nodeId);
    return jsonResponse(200, approval);
  }

  private async handleListNodeServices(request: Request, workspaceId: string, nodeId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:read");
    const adapter = requireSandboxAdapter(this.services.sandboxNodeAdapter);
    const node = requireNodeRegistry(this.services.nodeRegistryService).listNodes(principal.workspace_id).find((item) => item.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new HttpError(404, "node not found");
    }
    ensureLaunchableNode(node);
    return jsonResponse(200, { items: adapter.listServices(node) });
  }

  private async handleLaunchNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const adapter = requireSandboxAdapter(this.services.sandboxNodeAdapter);
    const previewService = requirePreviewService(this.services.previewService);
    const node = requireNodeRegistry(this.services.nodeRegistryService).listNodes(principal.workspace_id).find((item) => item.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new HttpError(404, "node not found");
    }
    ensureLaunchableNode(node);
    const internalLaunch = await adapter.prepareServiceLaunch(principal.workspace_id, node, serviceId);
    const launch = previewService.mintLaunchCapability({
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
    return jsonResponse(200, launch as unknown as Record<string, unknown>);
  }

  private async handleRevokeNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const previewService = requirePreviewService(this.services.previewService);
    const node = requireNodeRegistry(this.services.nodeRegistryService).listNodes(principal.workspace_id).find((item) => item.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new HttpError(404, "node not found");
    }
    ensureLaunchableNode(node);
    const revoked = previewService.revokeLaunchScope(buildServiceLaunchScope(principal.workspace_id, nodeId, serviceId));
    return jsonResponse(200, { ok: true, revoked });
  }

  private async handleRestartNodeService(request: Request, workspaceId: string, nodeId: string, serviceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "services:write");
    const adapter = requireSandboxAdapter(this.services.sandboxNodeAdapter);
    const previewService = requirePreviewService(this.services.previewService);
    const node = requireNodeRegistry(this.services.nodeRegistryService).listNodes(principal.workspace_id).find((item) => item.manifest.node_id === nodeId);
    if (node === undefined) {
      throw new HttpError(404, "node not found");
    }
    ensureLaunchableNode(node);
    previewService.revokeLaunchScope(buildServiceLaunchScope(principal.workspace_id, nodeId, serviceId));
    const result = await adapter.restartService(principal.workspace_id, node, serviceId);
    return jsonResponse(200, result as unknown as Record<string, unknown>);
  }

  private async handleListPreviews(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:read");
    const previewService = requirePreviewService(this.services.previewService);
    return jsonResponse(200, { items: previewService.listPreviews(principal.workspace_id) });
  }

  private async handleRegisterPreview(request: Request, workspaceId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:write");
    const previewService = requirePreviewService(this.services.previewService);
    const preview = previewDescriptorSchema.parse(await request.json());
    if (preview.workspace_id !== principal.workspace_id) {
      throw new HttpError(403, "workspace mismatch");
    }
    if (preview.launch_url !== undefined || preview.embed_url !== undefined) {
      throw new HttpError(403, "caller-supplied browser URLs are not allowed");
    }
    return jsonResponse(201, { preview: previewService.registerPreview(principal.workspace_id, preview) });
  }

  private async handleLaunchPreview(request: Request, workspaceId: string, previewId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:read");
    const previewService = requirePreviewService(this.services.previewService);
    const launchRequest = previewLaunchRequestSchema.parse(await readOptionalJson(request));
    const launch = previewService.launchPreview(principal.workspace_id, previewId, launchRequest);
    return jsonResponse(200, launch as unknown as Record<string, unknown>);
  }

  private async handleRevokePreview(request: Request, workspaceId: string, previewId: string): Promise<Response> {
    const principal = await this.requirePrincipal(request, workspaceId, "previews:write");
    const previewService = requirePreviewService(this.services.previewService);
    return jsonResponse(200, { preview: previewService.revokePreview(principal.workspace_id, previewId) });
  }

  private async handleFiles(request: Request, pathname: string): Promise<Response> {
    const fileService = requireWorkspaceFileService(this.services.workspaceFileService);
    const prefix = "/v1/workspaces/";
    const segments = pathname.slice(prefix.length).split("/");
    const workspaceId = segments[0];
    const remainder = segments.slice(1).join("/");
    if (workspaceId === "" || !remainder.startsWith("files")) {
      throw new HttpError(404, "file route not found");
    }

    const principal = await this.requirePrincipal(request, workspaceId, "files:read");
    const filePath = remainder.slice("files".length).replace(/^\//, "");
    if (filePath === "") {
      return jsonResponse(200, { items: fileService.listFiles(principal.workspace_id) });
    }

    const file = fileService.readFile(principal.workspace_id, `/${filePath}`);
    return new Response(file.content, {
      status: 200,
      headers: {
        "Content-Type": file.entry.mime_type ?? "text/plain; charset=utf-8",
      },
    });
  }

  private handleLaunchCapability(token: string): Response {
    const previewService = requirePreviewService(this.services.previewService);
    const resolved = previewService.resolveLaunchCapability(token);
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
    } catch {
      throw new HttpError(401, "unauthorized");
    }
    if (workspaceId !== undefined && principal.workspace_id !== workspaceId) {
      throw new HttpError(403, "workspace mismatch");
    }
    if (!hasScope(principal, requiredScope)) {
      throw new HttpError(403, "missing required scope");
    }
    return principal;
  }
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const hasScope = (principal: WorkspacePrincipal, requiredScope: string): boolean =>
  principal.scopes.includes("*") || principal.scopes.includes(requiredScope);

const jsonResponse = (status: number, payload: Record<string, unknown>): Response =>
  Response.json(payload, { status });

const htmlResponse = (html: string): Response =>
  new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const requireGroup = (groups: Record<string, string | undefined>, key: string): string => {
  const value = groups[key];
  if (value === undefined) {
    throw new HttpError(404, `missing route parameter ${key}`);
  }
  return value;
};

const requireNodeRegistry = (service: NodeRegistryService | undefined): NodeRegistryService => {
  if (service === undefined) {
    throw new HttpError(503, "node registry is not configured");
  }
  return service;
};

const requireAgentService = (service: AgentService | undefined): AgentService => {
  if (service === undefined) {
    throw new HttpError(503, "agent service is not configured");
  }
  return service;
};

const requirePreviewService = (service: PreviewService | undefined): PreviewService => {
  if (service === undefined) {
    throw new HttpError(503, "preview service is not configured");
  }
  return service;
};

const requireWorkspaceFileService = (service: InMemoryWorkspaceFileService | undefined): InMemoryWorkspaceFileService => {
  if (service === undefined) {
    throw new HttpError(503, "workspace file service is not configured");
  }
  return service;
};

const requireSandboxAdapter = (service: SandboxNodeAdapter | undefined): SandboxNodeAdapter => {
  if (service === undefined) {
    throw new HttpError(503, "sandbox node adapter is not configured");
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

const readOptionalJson = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  return JSON.parse(text) as unknown;
};

const parseJobStatusFilter = (value: string | null): "running" | "terminal" | "all" | undefined => {
  if (value === null || value === "") {
    return undefined;
  }
  if (value === "running" || value === "terminal" || value === "all") {
    return value;
  }
  throw new HttpError(400, "invalid status filter");
};

const toApiKeyResponse = (record: ReturnType<AuthService["listApiKeys"]>[number]): Record<string, unknown> => ({
  api_key_id: record.api_key_id,
  workspace_id: record.workspace_id,
  name: record.name,
  scopes: record.scopes,
  created_at: record.created_at,
  expires_at: record.expires_at,
  revoked_at: record.revoked_at,
});

export const handleAppRequest = async (app: Or3NetApp, request: Request): Promise<Response> => {
  try {
    return await app.fetch(request);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.message });
    }
    if (error instanceof PreviewStateError) {
      return jsonResponse(error.status, { error: error.message });
    }
    if (error instanceof z.ZodError) {
      return jsonResponse(400, { error: error.issues[0]?.message ?? "invalid request" });
    }
    if (error instanceof Error && isNotFoundError(error)) {
      return jsonResponse(404, { error: error.message });
    }
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "internal server error",
    });
  }
};

const isNotFoundError = (error: Error): boolean => {
  const message = error.message.toLowerCase();
  return message.includes("was not found") || message.endsWith("not found");
};
