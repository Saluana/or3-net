import type { PreviewDescriptor, PreviewLaunchMetadata, PreviewLaunchRequest } from "../contracts/index.ts";
import type { CapabilityGrant } from "../contracts/platform/types.ts";
import type { ControlPlaneDatabase, StoredPreview } from "../db/index.ts";
import { createId } from "../lib/ids.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

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
  private readonly revokedLaunchCapabilities = new Map<string, { revoked_at: string; expires_at: string }>();
  private readonly capabilityExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxRevokedLaunchCapabilities = 256;

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
    this.scheduleLaunchCapabilityExpiry(capability.capability_id, capability.expires_at);

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
    const revokedCapability = this.revokedLaunchCapabilities.get(token);
    if (revokedCapability !== undefined) {
      throw new PreviewStateError(403, "launch capability has been revoked");
    }
    const capability = this.launchCapabilities.get(token);
    if (capability === undefined) {
      throw new PreviewStateError(410, "launch capability has expired");
    }
    if (Date.parse(capability.grant.expires_at) <= Date.now()) {
      this.deleteLaunchCapability(token, capability);
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
      if (capability === undefined) {
        continue;
      }

      const revokedCapability: LaunchCapabilityRecord = {
        ...capability,
        grant: {
          ...capability.grant,
          revoked_at: new Date().toISOString(),
        },
      };
      this.deleteLaunchCapability(token, revokedCapability, "revoked");
      revokedCount += 1;
    }
    this.scopedLaunchTokens.delete(scopeKey);
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
        const revokedCapability: LaunchCapabilityRecord = {
          ...capability,
          grant: {
            ...capability.grant,
            revoked_at: new Date().toISOString(),
          },
        };
        this.deleteLaunchCapability(token, revokedCapability, "revoked");
      }
    }

    this.previewLaunchTokens.delete(previewId);
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
    this.scheduleLaunchCapabilityExpiry(capability.capability_id, capability.expires_at);

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

  private deleteLaunchCapability(token: string, capability: LaunchCapabilityRecord, reason: "expired" | "revoked" = "expired"): void {
    this.clearCapabilityExpiryTimer(token);
    this.launchCapabilities.delete(token);
    this.removeCapabilityFromIndexes(token, capability);
    if (reason === "revoked" && capability.grant.revoked_at !== null) {
      this.revokedLaunchCapabilities.set(token, {
        revoked_at: capability.grant.revoked_at,
        expires_at: capability.grant.expires_at,
      });
      this.scheduleRevokedCapabilityExpiry(token, capability.grant.expires_at);
      this.trimRevokedLaunchCapabilities();
    } else {
      this.revokedLaunchCapabilities.delete(token);
    }
  }

  private scheduleLaunchCapabilityExpiry(token: string, expiresAt: string): void {
    this.clearCapabilityExpiryTimer(token);
    this.capabilityExpiryTimers.set(token, this.createExpiryTimer(token, expiresAt, () => {
      const capability = this.launchCapabilities.get(token);
      if (capability !== undefined && Date.parse(capability.grant.expires_at) <= Date.now()) {
        this.deleteLaunchCapability(token, capability, "expired");
      }
    }));
  }

  private scheduleRevokedCapabilityExpiry(token: string, expiresAt: string): void {
    this.clearCapabilityExpiryTimer(token);
    this.capabilityExpiryTimers.set(token, this.createExpiryTimer(token, expiresAt, () => {
      const revoked = this.revokedLaunchCapabilities.get(token);
      if (revoked !== undefined && Date.parse(revoked.expires_at) <= Date.now()) {
        this.revokedLaunchCapabilities.delete(token);
      }
    }));
  }

  private createExpiryTimer(token: string, expiresAt: string, onExpire: () => void): ReturnType<typeof setTimeout> {
    const remainingMs = Date.parse(expiresAt) - Date.now();
    if (remainingMs <= 0) {
      return setTimeout(() => {
        this.capabilityExpiryTimers.delete(token);
        onExpire();
      }, 0);
    }

    const delayMs = Math.min(remainingMs, MAX_TIMEOUT_MS);
    return setTimeout(() => {
      this.capabilityExpiryTimers.delete(token);
      if (Date.parse(expiresAt) > Date.now()) {
        this.capabilityExpiryTimers.set(token, this.createExpiryTimer(token, expiresAt, onExpire));
        return;
      }
      onExpire();
    }, delayMs);
  }

  private clearCapabilityExpiryTimer(token: string): void {
    const timer = this.capabilityExpiryTimers.get(token);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.capabilityExpiryTimers.delete(token);
  }

  private trimRevokedLaunchCapabilities(): void {
    while (this.revokedLaunchCapabilities.size > this.maxRevokedLaunchCapabilities) {
      const oldest = this.revokedLaunchCapabilities.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.clearCapabilityExpiryTimer(oldest);
      this.revokedLaunchCapabilities.delete(oldest);
    }
  }

  private removeCapabilityFromIndexes(token: string, capability: LaunchCapabilityRecord): void {
    if (capability.preview_id !== undefined) {
      const previewTokens = this.previewLaunchTokens.get(capability.preview_id);
      previewTokens?.delete(token);
      if (previewTokens?.size === 0) {
        this.previewLaunchTokens.delete(capability.preview_id);
      }
    }

    if (capability.scope_key !== undefined) {
      const scopedTokens = this.scopedLaunchTokens.get(capability.scope_key);
      scopedTokens?.delete(token);
      if (scopedTokens?.size === 0) {
        this.scopedLaunchTokens.delete(capability.scope_key);
      }
    }
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
  const normalized = normalizePosixPath(value.startsWith("/") ? value : `/${value}`);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
};

const looksLikeFilePath = (value: string): boolean => getPosixBasename(value).includes(".");

const resolvePreviewRootPath = (preview: PreviewDescriptor): string => {
  if (preview.path !== undefined) {
    const normalizedPath = normalizeAbsolutePath(preview.path);
    if (preview.entry_path !== undefined || !looksLikeFilePath(normalizedPath)) {
      return normalizedPath;
    }
    return getPosixDirname(normalizedPath);
  }

  if (preview.entry_path !== undefined) {
    return getPosixDirname(normalizeAbsolutePath(preview.entry_path));
  }

  throw new PreviewStateError(403, "file-backed preview is missing a target path");
};

const resolvePreviewDefaultFilePath = (preview: PreviewDescriptor): string => {
  if (preview.entry_path !== undefined) {
    return normalizeAbsolutePath(preview.entry_path);
  }

  if (preview.path !== undefined) {
    const normalizedPath = normalizeAbsolutePath(preview.path);
    return looksLikeFilePath(normalizedPath) ? normalizedPath : joinPosixPath(normalizedPath, "index.html");
  }

  throw new PreviewStateError(403, "file-backed preview is missing a target path");
};

const buildFileLaunchUrl = (origin: string | undefined, token: string, rootPath: string, defaultFilePath: string): string => {
  const relativePath = relativePosixPath(rootPath, defaultFilePath);
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
  const candidate = resolvePosixPath(normalizedRoot, requestedPath);
  if (!isPathWithinRoot(normalizedRoot, candidate)) {
    throw new PreviewStateError(403, "launch capability path is outside the preview root");
  }
  return candidate;
};

const splitPosixSegments = (value: string): string[] =>
  value
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

const normalizePosixPath = (value: string): string => {
  const normalizedSegments: string[] = [];
  for (const segment of splitPosixSegments(value)) {
    if (segment === "..") {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }
  return `/${normalizedSegments.join("/")}`;
};

const getPosixBasename = (value: string): string => {
  const normalized = normalizeAbsolutePath(value);
  const segments = splitPosixSegments(normalized);
  return segments.at(-1) ?? "";
};

const getPosixDirname = (value: string): string => {
  const normalized = normalizeAbsolutePath(value);
  const segments = splitPosixSegments(normalized);
  if (segments.length <= 1) {
    return "/";
  }
  return `/${segments.slice(0, -1).join("/")}`;
};

const joinPosixPath = (...parts: string[]): string => normalizeAbsolutePath(parts.join("/"));

const relativePosixPath = (from: string, to: string): string => {
  const fromSegments = splitPosixSegments(normalizeAbsolutePath(from));
  const toSegments = splitPosixSegments(normalizeAbsolutePath(to));
  let index = 0;
  while (index < fromSegments.length && index < toSegments.length && fromSegments[index] === toSegments[index]) {
    index += 1;
  }
  return [...Array.from({ length: fromSegments.length - index }, () => ".."), ...toSegments.slice(index)].join("/");
};

const resolvePosixPath = (root: string, candidate: string): string =>
  normalizeAbsolutePath(candidate.startsWith("/") ? candidate : `${normalizeAbsolutePath(root)}/${candidate}`);

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
