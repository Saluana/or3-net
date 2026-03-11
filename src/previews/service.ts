import type { PreviewDescriptor, PreviewLaunchMetadata } from "../contracts/index.ts";
import type { ControlPlaneDatabase, StoredPreview } from "../db/index.ts";
import { createId } from "../lib/ids.ts";

interface LaunchCapability {
  readonly token: string;
  readonly workspace_id: string;
  readonly preview_id?: string;
  readonly target_url: string;
  readonly expires_at: string;
  readonly revoked: boolean;
}

export class PreviewStateError extends Error {
  public constructor(
    public readonly status: 403 | 410,
    message: string,
  ) {
    super(message);
  }
}

export class PreviewService {
  private readonly launchCapabilities = new Map<string, LaunchCapability>();
  private readonly previewLaunchTokens = new Map<string, Set<string>>();

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

  public launchPreview(workspaceId: string, previewId: string): PreviewLaunchMetadata {
    const stored = this.database.workspace(workspaceId).getPreview(previewId);
    if (stored.preview.status === "revoked") {
      throw new PreviewStateError(403, "preview has been revoked");
    }
    if (stored.preview.expires_at !== undefined && Date.parse(stored.preview.expires_at) <= Date.now()) {
      throw new PreviewStateError(410, "preview has expired");
    }
    return this.mintLaunchCapability({
      workspace_id: workspaceId,
      preview_id: previewId,
      target_url: this.buildPreviewTargetUrl(stored.preview),
      delivery_mode: stored.preview.delivery_mode,
      supports_iframe: stored.preview.supports_iframe,
      supports_new_tab: stored.preview.supports_new_tab,
      reused_tunnel: false,
      service_status: stored.preview.status,
      expires_at: stored.preview.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString(),
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
    readonly workspace_id: string;
    readonly target_url: string;
    readonly delivery_mode: PreviewLaunchMetadata["delivery_mode"];
    readonly supports_iframe: boolean;
    readonly supports_new_tab: boolean;
    readonly reused_tunnel: boolean;
    readonly service_status: PreviewLaunchMetadata["service_status"];
    readonly expires_at: string;
    readonly preview_id?: string;
  }): PreviewLaunchMetadata {
    const token = createId("launchcap");
    this.launchCapabilities.set(token, {
      token,
      workspace_id: input.workspace_id,
      ...(input.preview_id === undefined ? {} : { preview_id: input.preview_id }),
      target_url: input.target_url,
      expires_at: input.expires_at,
      revoked: false,
    });

    if (input.preview_id !== undefined) {
      const existing = this.previewLaunchTokens.get(input.preview_id) ?? new Set<string>();
      existing.add(token);
      this.previewLaunchTokens.set(input.preview_id, existing);
    }

    const launchUrl = `https://or3.local/v1/launch/${token}`;
    return {
      preview_id: input.preview_id ?? token,
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

  public resolveLaunchCapability(token: string): { target_url: string; workspace_id: string } {
    const capability = this.launchCapabilities.get(token);
    if (capability === undefined || capability.revoked) {
      throw new PreviewStateError(410, "launch capability has been revoked");
    }
    if (Date.parse(capability.expires_at) <= Date.now()) {
      throw new PreviewStateError(410, "launch capability has expired");
    }
    return {
      target_url: capability.target_url,
      workspace_id: capability.workspace_id,
    };
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
          revoked: true,
        });
      }
    }
  }

  private buildPreviewTargetUrl(preview: PreviewDescriptor): string {
    if (preview.source_type === "files") {
      const filePath = preview.entry_path ?? preview.path;
      if (filePath === undefined) {
        throw new PreviewStateError(403, "file-backed preview is missing a target path");
      }
      return `https://or3.local/v1/workspaces/${preview.workspace_id}/files${filePath.startsWith("/") ? filePath : `/${filePath}`}`;
    }

    if (preview.launch_url !== undefined) {
      return preview.launch_url;
    }

    throw new PreviewStateError(403, "preview target is not available");
  }
}