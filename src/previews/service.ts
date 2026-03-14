import { posix as pathPosix } from "node:path";

import type { PreviewDescriptor, PreviewLaunchMetadata, PreviewLaunchRequest } from "../contracts/index.ts";
import type { CapabilityGrant } from "../contracts/platform/types.ts";
import type { ControlPlaneDatabase, StoredPreview } from "../db/index.ts";
import { createId } from "../lib/ids.ts";

type LaunchCapabilityRecord =
  | {
      readonly grant: CapabilityGrant;
      readonly preview_id?: string;
      readonly scope_key?: string;
      readonly kind: "redirect";
      readonly target_url: string;
    }
  | {
      readonly grant: CapabilityGrant;
      readonly preview_id?: string;
      readonly scope_key?: string;
      readonly kind: "files";
      readonly root_path: string;
      readonly default_file_path: string;
    };

export type ResolvedLaunchCapability =
  | {
      readonly kind: "redirect";
      readonly target_url: string;
      readonly workspace_id: string;
    }
  | {
      readonly kind: "files";
      readonly workspace_id: string;
      readonly file_path: string;
    };

export class PreviewStateError extends Error {
  public constructor(
    public readonly status: 403 | 410,
    message: string,
  ) {
    super(message);
  }
}

export class PreviewService {
  private readonly launchCapabilities = new Map<string, LaunchCapabilityRecord>();
  private readonly previewLaunchTokens = new Map<string, Set<string>>();
  private readonly scopedLaunchTokens = new Map<string, Set<string>>();

  public constructor(private readonly database: ControlPlaneDatabase) {}

  public listPreviews(workspaceId: string): StoredPreview[] {
    return this.database.workspace(workspaceId).listPreviews();
  }

  public registerPreview(workspaceId: string, preview: PreviewDescriptor): StoredPreview {
    if (preview.launch_url !== undefined || preview.embed_url !== undefined) {
      throw new PreviewStateError(403, "caller-supplied browser URLs are not allowed");
    }

    return this.database.workspace(workspaceId).savePreview({ preview });
  }

  public launchPreview(
    workspaceId: string,
    previewId: string,
    request?: PreviewLaunchRequest,
    origin = "http://localhost",
  ): PreviewLaunchMetadata {
    const stored = this.database.workspace(workspaceId).getPreview(previewId);
    if (stored.preview.status === "revoked") {
      throw new PreviewStateError(403, "preview has been revoked");
    }
    if (stored.preview.expires_at !== undefined && Date.parse(stored.preview.expires_at) <= Date.now()) {
      throw new PreviewStateError(410, "preview has expired");
    }
    const supportsIframe = shouldOfferIframe(stored.preview, request);
    const expiresAt = stored.preview.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString();

    if (stored.preview.source_type === "files") {
      return this.mintFileLaunchCapability({
        origin,
        workspace_id: workspaceId,
        preview_id: previewId,
        preview: stored.preview,
        delivery_mode: resolveDeliveryMode(stored.preview, request, supportsIframe),
        supports_iframe: supportsIframe,
        supports_new_tab: stored.preview.supports_new_tab,
        reused_tunnel: false,
        service_status: stored.preview.status,
        expires_at: expiresAt,
      });
    }

    return this.mintLaunchCapability({
      origin,
      workspace_id: workspaceId,
      preview_id: previewId,
      target_url: this.buildPreviewTargetUrl(stored.preview),
      delivery_mode: resolveDeliveryMode(stored.preview, request, supportsIframe),
      supports_iframe: supportsIframe,
      supports_new_tab: stored.preview.supports_new_tab,
      reused_tunnel: false,
      service_status: stored.preview.status,
      expires_at: expiresAt,
    });
  }

  public revokePreview(workspaceId: string, previewId: string): StoredPreview {
    const stored = this.database.workspace(workspaceId).getPreview(previewId);
    this.revokeLaunchCapabilitiesForPreview(previewId);
    return this.database.workspace(workspaceId).savePreview({
      preview: {
        ...stored.preview,
        status: "revoked",
      },
      revoked_at: new Date().toISOString(),
    });
  }

  public mintLaunchCapability(input: {
    readonly origin?: string;
    readonly workspace_id: string;
    readonly target_url: string;
    readonly delivery_mode: PreviewLaunchMetadata["delivery_mode"];
    readonly supports_iframe: boolean;
    readonly supports_new_tab: boolean;
    readonly reused_tunnel: boolean;
    readonly service_status: PreviewLaunchMetadata["service_status"];
    readonly expires_at: string;
    readonly preview_id?: string;
    readonly scope_key?: string;
  }): PreviewLaunchMetadata {
    const capabilityKind: CapabilityGrant["kind"] = input.preview_id === undefined ? "service-launch" : "preview-launch";
    const capability = createCapabilityGrant({
      workspace_id: input.workspace_id,
      kind: capabilityKind,
      scope: {
        ...(input.preview_id === undefined ? {} : { preview_id: input.preview_id }),
        ...(input.scope_key === undefined ? {} : { scope_key: input.scope_key }),
        target_url: input.target_url,
      },
      expires_at: input.expires_at,
    });
    this.launchCapabilities.set(capability.capability_id, {
      grant: capability,
      ...(input.preview_id === undefined ? {} : { preview_id: input.preview_id }),
      ...(input.scope_key === undefined ? {} : { scope_key: input.scope_key }),
      kind: "redirect",
      target_url: input.target_url,
    });

    if (input.preview_id !== undefined) {
      const existing = this.previewLaunchTokens.get(input.preview_id) ?? new Set<string>();
      existing.add(capability.capability_id);
      this.previewLaunchTokens.set(input.preview_id, existing);
    }

    if (input.scope_key !== undefined) {
      const existing = this.scopedLaunchTokens.get(input.scope_key) ?? new Set<string>();
      existing.add(capability.capability_id);
      this.scopedLaunchTokens.set(input.scope_key, existing);
    }

    const launchUrl = new URL(`/v1/launch/${capability.capability_id}`, normalizeOrigin(input.origin)).toString();
    return {
      preview_id: input.preview_id ?? capability.capability_id,
      workspace_id: input.workspace_id,
      launch_url: launchUrl,
      ...(input.supports_iframe ? { embed_url: launchUrl } : {}),
      delivery_mode: input.delivery_mode,
      supports_iframe: input.supports_iframe,
      supports_new_tab: input.supports_new_tab,
      reused_tunnel: input.reused_tunnel,
      service_status: input.service_status,
      expires_at: input.expires_at,
    };
  }

  public resolveLaunchCapability(token: string, requestedPath?: string): ResolvedLaunchCapability {
    const capability = this.launchCapabilities.get(token);
    if (capability === undefined) {
      throw new PreviewStateError(410, "launch capability has expired");
    }
    if (capability.grant.revoked_at !== null) {
      throw new PreviewStateError(403, "launch capability has been revoked");
    }
    if (Date.parse(capability.grant.expires_at) <= Date.now()) {
      throw new PreviewStateError(410, "launch capability has expired");
    }

    if (capability.kind === "redirect") {
      return {
        kind: "redirect",
        target_url: capability.target_url,
        workspace_id: capability.grant.workspace_id,
      };
    }

    return {
      kind: "files",
      workspace_id: capability.grant.workspace_id,
      file_path: resolveCapabilityFilePath(capability.root_path, capability.default_file_path, requestedPath),
    };
  }

  public revokeLaunchScope(scopeKey: string): number {
    const tokens = this.scopedLaunchTokens.get(scopeKey);
    if (tokens === undefined) {
      return 0;
    }

    let revokedCount = 0;
    for (const token of tokens) {
      const capability = this.launchCapabilities.get(token);
      if (capability?.grant.revoked_at !== null) {
        continue;
      }

      this.launchCapabilities.set(token, {
        ...capability,
        grant: {
          ...capability.grant,
          revoked_at: new Date().toISOString(),
        },
      });
      revokedCount += 1;
    }
    return revokedCount;
  }

  private revokeLaunchCapabilitiesForPreview(previewId: string): void {
    const tokens = this.previewLaunchTokens.get(previewId);
    if (tokens === undefined) {
      return;
    }

    for (const token of tokens) {
      const capability = this.launchCapabilities.get(token);
      if (capability !== undefined) {
        this.launchCapabilities.set(token, {
          ...capability,
          grant: {
            ...capability.grant,
            revoked_at: new Date().toISOString(),
          },
        });
      }
    }
  }

  private buildPreviewTargetUrl(preview: PreviewDescriptor): string {
    if (preview.launch_url !== undefined) {
      return preview.launch_url;
    }

    throw new PreviewStateError(403, "preview target is not available");
  }

  private mintFileLaunchCapability(input: {
    readonly origin?: string;
    readonly workspace_id: string;
    readonly preview_id: string;
    readonly preview: PreviewDescriptor;
    readonly delivery_mode: PreviewLaunchMetadata["delivery_mode"];
    readonly supports_iframe: boolean;
    readonly supports_new_tab: boolean;
    readonly reused_tunnel: boolean;
    readonly service_status: PreviewLaunchMetadata["service_status"];
    readonly expires_at: string;
  }): PreviewLaunchMetadata {
    const rootPath = resolvePreviewRootPath(input.preview);
    const defaultFilePath = resolvePreviewDefaultFilePath(input.preview);
    const capability = createCapabilityGrant({
      workspace_id: input.workspace_id,
      kind: "preview-launch",
      scope: {
        preview_id: input.preview_id,
        root_path: rootPath,
        default_file_path: defaultFilePath,
      },
      expires_at: input.expires_at,
    });
    if (!isPathWithinRoot(rootPath, defaultFilePath)) {
      throw new PreviewStateError(403, "preview entry path is outside the preview root");
    }
    this.launchCapabilities.set(capability.capability_id, {
      grant: capability,
      preview_id: input.preview_id,
      kind: "files",
      root_path: rootPath,
      default_file_path: defaultFilePath,
    });

    const existing = this.previewLaunchTokens.get(input.preview_id) ?? new Set<string>();
    existing.add(capability.capability_id);
    this.previewLaunchTokens.set(input.preview_id, existing);

    const launchUrl = buildFileLaunchUrl(input.origin, capability.capability_id, rootPath, defaultFilePath);
    return {
      preview_id: input.preview_id,
      workspace_id: input.workspace_id,
      launch_url: launchUrl,
      ...(input.supports_iframe ? { embed_url: launchUrl } : {}),
      delivery_mode: input.delivery_mode,
      supports_iframe: input.supports_iframe,
      supports_new_tab: input.supports_new_tab,
      reused_tunnel: input.reused_tunnel,
      service_status: input.service_status,
      expires_at: input.expires_at,
    };
  }
}

const createCapabilityGrant = (input: {
  readonly workspace_id: string;
  readonly kind: CapabilityGrant["kind"];
  readonly scope: CapabilityGrant["scope"];
  readonly expires_at: string;
}): CapabilityGrant => ({
  capability_id: createId("cap"),
  workspace_id: input.workspace_id,
  kind: input.kind,
  scope: input.scope,
  expires_at: input.expires_at,
  revoked_at: null,
});

const shouldOfferIframe = (preview: PreviewDescriptor, request?: PreviewLaunchRequest): boolean => {
  if (!preview.supports_iframe) {
    return false;
  }

  return request?.launch_mode_hint !== "new_tab" && request?.launch_mode_hint !== "external_browser";
};

const normalizeOrigin = (origin: string | undefined): string => {
  const trimmed = origin?.trim() ?? "";
  return trimmed === "" ? "http://localhost" : trimmed;
};

const normalizeAbsolutePath = (value: string): string => {
  const normalized = pathPosix.normalize(value.startsWith("/") ? value : `/${value}`);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const looksLikeFilePath = (value: string): boolean => pathPosix.basename(value).includes(".");

const resolvePreviewRootPath = (preview: PreviewDescriptor): string => {
  if (preview.path !== undefined) {
    const normalizedPath = normalizeAbsolutePath(preview.path);
    if (preview.entry_path !== undefined || !looksLikeFilePath(normalizedPath)) {
      return normalizedPath;
    }
    return pathPosix.dirname(normalizedPath);
  }

  if (preview.entry_path !== undefined) {
    return pathPosix.dirname(normalizeAbsolutePath(preview.entry_path));
  }

  throw new PreviewStateError(403, "file-backed preview is missing a target path");
};

const resolvePreviewDefaultFilePath = (preview: PreviewDescriptor): string => {
  if (preview.entry_path !== undefined) {
    return normalizeAbsolutePath(preview.entry_path);
  }

  if (preview.path !== undefined) {
    const normalizedPath = normalizeAbsolutePath(preview.path);
    return looksLikeFilePath(normalizedPath) ? normalizedPath : pathPosix.join(normalizedPath, "index.html");
  }

  throw new PreviewStateError(403, "file-backed preview is missing a target path");
};

const buildFileLaunchUrl = (origin: string | undefined, token: string, rootPath: string, defaultFilePath: string): string => {
  const relativePath = pathPosix.relative(rootPath, defaultFilePath);
  const encodedRelativePath = relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const pathname = encodedRelativePath === "" ? `/v1/launch/${token}` : `/v1/launch/${token}/${encodedRelativePath}`;
  return new URL(pathname, normalizeOrigin(origin)).toString();
};

const resolveCapabilityFilePath = (rootPath: string, defaultFilePath: string, requestedPath?: string): string => {
  if (requestedPath === undefined || requestedPath.trim() === "") {
    return defaultFilePath;
  }

  const normalizedRoot = normalizeAbsolutePath(rootPath);
  const candidate = pathPosix.resolve(normalizedRoot, requestedPath);
  if (!isPathWithinRoot(normalizedRoot, candidate)) {
    throw new PreviewStateError(403, "launch capability path is outside the preview root");
  }
  return candidate;
};

const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
  if (rootPath === "/") {
    return candidatePath.startsWith("/");
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
};

const resolveDeliveryMode = (
  preview: PreviewDescriptor,
  request: PreviewLaunchRequest | undefined,
  supportsIframe: boolean,
): PreviewLaunchMetadata["delivery_mode"] => {
  if (request?.launch_mode_hint === "pane") {
    return supportsIframe ? "embedded" : "external-preferred";
  }
  if (request?.launch_mode_hint === "new_tab" || request?.launch_mode_hint === "external_browser") {
    return "external";
  }
  return preview.delivery_mode;
};
