import type { AuthService } from "./auth/service.ts";
import { handleAppRequest, Or3NetApp } from "./api/app.ts";
import type { LocalJobService } from "./execution/local-jobs.ts";
import type { SandboxNodeAdapter } from "./nodes/adapter-sandbox.ts";
import type { NodeRegistryService } from "./nodes/index.ts";
import type { PreviewService } from "./previews/service.ts";
import type { InMemoryWorkspaceFileService } from "./workspace/files.ts";

export interface ServerOptions {
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

export const createServerApp = (options: ServerOptions): Or3NetApp =>
  new Or3NetApp({
    authService: options.authService,
    localJobService: options.localJobService,
    ...(options.nodeRegistryService === undefined ? {} : { nodeRegistryService: options.nodeRegistryService }),
    ...(options.previewService === undefined ? {} : { previewService: options.previewService }),
    ...(options.workspaceFileService === undefined ? {} : { workspaceFileService: options.workspaceFileService }),
    ...(options.sandboxNodeAdapter === undefined ? {} : { sandboxNodeAdapter: options.sandboxNodeAdapter }),
  });

export const startServer = (
  options: ServerOptions & { readonly port?: number },
): ReturnType<typeof Bun.serve> => {
  const app = createServerApp(options);
  return Bun.serve({
    port: options.port ?? 3001,
    fetch: (request) => handleAppRequest(app, request),
  });
};