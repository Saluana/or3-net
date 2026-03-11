import { z } from "zod";

import type { AuthService } from "../auth/service.ts";
import { previewDescriptorSchema } from "../contracts/index.ts";
import type { WorkspacePrincipal } from "../auth/tokens.ts";
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

interface AppServices {
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

export class Or3NetApp {
  public constructor(private readonly services: AppServices) {}

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const launchCapabilityMatch = new URLPattern({ pathname: "/v1/launch/:token" }).exec(url);
    if (request.method === "GET" && launchCapabilityMatch !== null) {
      return this.handleLaunchCapability(requireGroup(launchCapabilityMatch.pathname.groups, "token"));
    }

    if (request.method === "POST" && url.pathname === "/v1/auth/exchange") {
      return this.handleExchange(request);
    }

    const createJobMatch = new URLPattern({ pathname: "/v1/workspaces/:workspaceId/jobs" }).exec(url);
    if (request.method === "POST" && createJobMatch !== null) {
      const workspaceId = requireGroup(createJobMatch.pathname.groups, "workspaceId");
      return this.handleCreateJob(request, workspaceId);
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
    const job = this.services.localJobService.submitJob(principal.workspace_id, payload);
    return jsonResponse(202, job);
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
    const launch = previewService.launchPreview(principal.workspace_id, previewId);
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
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "internal server error",
    });
  }
};