import type { AuthService } from "./auth/service.ts";
import type { AgentService } from "./agents/index.ts";
import { handleAppRequest, Or3NetApp } from "./api/app.ts";
import type { ControlPlaneDatabase } from "./db/index.ts";
import type { LocalJobService } from "./execution/local-jobs.ts";
import type { SandboxNodeAdapter } from "./nodes/adapter-sandbox.ts";
import type { NodeRegistryService } from "./nodes/index.ts";
import type { PreviewService } from "./previews/service.ts";
import type { RuntimeRegistry, RuntimeSessionService } from "./runtime/index.ts";
import type { InMemoryWorkspaceFileService } from "./workspace/files.ts";

export interface ServerOptions {
  readonly database?: ControlPlaneDatabase;
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly runtimeRegistry?: RuntimeRegistry;
  readonly runtimeSessionService?: RuntimeSessionService;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly agentService?: AgentService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

export const createServerApp = (options: ServerOptions): Or3NetApp =>
  new Or3NetApp(options);

export const startServer = (
  options: ServerOptions & { readonly port?: number },
): ReturnType<typeof Bun.serve> => {
  const app = createServerApp(options);
  return Bun.serve({
    port: options.port ?? 3001,
    fetch: (request) => handleAppRequest(app, request),
  });
};