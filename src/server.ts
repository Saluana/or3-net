/**
 * @module src/server
 *
 * Purpose:
 * Wires the high-level OR3 Net server surface together. This module turns a set
 * of already-constructed services into a request-handling app and optional Bun
 * HTTP server.
 *
 * Responsibilities:
 * - Resolve default runtime infrastructure when the caller omits it
 * - Start startup reconciliation for persisted runtime sessions
 * - Expose a small API for embedding or launching the control-plane server
 *
 * Non-responsibilities:
 * - Does not construct auth, database, or job services from env vars
 * - Does not persist process lifecycle state beyond runtime-session recovery
 */
import type { AuthService } from "./auth/service.ts";
import type { AgentService } from "./agents/index.ts";
import { handleAppRequest, Or3NetApp } from "./api/app.ts";
import type { ControlPlaneDatabase } from "./db/index.ts";
import type { LocalJobService } from "./execution/local-jobs.ts";
import type { SandboxNodeAdapter } from "./nodes/adapter-sandbox.ts";
import type { NodeRegistryService, RemoteNodeExecutor } from "./nodes/index.ts";
import type { PreviewService } from "./previews/service.ts";
import {
  LocalContainerRuntimeAdapter,
  RemoteNodeRuntimeAdapter,
  RuntimeRegistry,
  RuntimeSelectionService,
  RuntimeSessionService,
} from "./runtime/index.ts";
import type { LeaseScheduler } from "./scheduler/index.ts";
import type { InMemoryWorkspaceFileService } from "./workspace/files.ts";

/**
 * Purpose:
 * Describes the service graph required to host an OR3 Net API server.
 *
 * Behavior:
 * Callers can supply only the mandatory services and allow this module to fill
 * in default runtime adapters and reconciliation helpers.
 *
 * Constraints:
 * - `authService` and `localJobService` are always required
 * - Runtime defaults are only created when the necessary dependencies exist
 */
export interface ServerOptions {
  readonly database?: ControlPlaneDatabase;
  readonly authService: AuthService;
  readonly localJobService: LocalJobService;
  readonly publicBaseUrl?: string;
  readonly runtimeRegistry?: RuntimeRegistry;
  readonly runtimeSessionService?: RuntimeSessionService;
  readonly leaseScheduler?: LeaseScheduler;
  readonly remoteNodeExecutor?: RemoteNodeExecutor;
  readonly nodeRegistryService?: NodeRegistryService;
  readonly agentService?: AgentService;
  readonly previewService?: PreviewService;
  readonly workspaceFileService?: InMemoryWorkspaceFileService;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

/**
 * Purpose:
 * Creates an `Or3NetApp` with the default runtime wiring applied.
 *
 * Behavior:
 * Resolves optional runtime infrastructure, starts background reconciliation,
 * and returns a request handler container without binding a network port.
 *
 * Non-Goals:
 * - Does not call `Bun.serve`
 * - Does not validate environment configuration beyond the provided services
 */
export const createServerApp = (options: ServerOptions): Or3NetApp =>
  new Or3NetApp(resolveServerOptions(options));

/**
 * Purpose:
 * Starts a Bun HTTP server for an OR3 Net app.
 *
 * Behavior:
 * Builds the application with `createServerApp()` and routes all requests
 * through `handleAppRequest()`.
 *
 * Constraints:
 * - Uses Bun's native server runtime
 * - Defaults to port `3001` when the caller does not supply one
 *
 * @example
 * ```ts
 * const server = startServer({
 *   authService,
 *   localJobService,
 *   database,
 *   port: 3001,
 * });
 * ```
 */
export const startServer = (
  options: ServerOptions & { readonly port?: number },
): ReturnType<typeof Bun.serve> => {
  const app = createServerApp(options);
  return Bun.serve({
    port: options.port ?? 3001,
    fetch: (request) => handleAppRequest(app, request),
  });
};

const resolveServerOptions = (options: ServerOptions): ServerOptions => {
  const runtimeRegistry = resolveRuntimeRegistry(options);
  const runtimeSessionService = resolveRuntimeSessionService(options, runtimeRegistry);
  startRuntimeReconciliation(runtimeSessionService);

  return {
    ...options,
    ...(runtimeRegistry === undefined ? {} : { runtimeRegistry }),
    ...(runtimeSessionService === undefined ? {} : { runtimeSessionService }),
  };
};

const resolveRuntimeRegistry = (options: ServerOptions): RuntimeRegistry | undefined => {
  if (options.runtimeRegistry !== undefined) {
    return options.runtimeRegistry;
  }

  const registry = new RuntimeRegistry();
  registry.register(new LocalContainerRuntimeAdapter());

  if (
    options.database !== undefined &&
    options.nodeRegistryService !== undefined &&
    options.leaseScheduler !== undefined &&
    options.remoteNodeExecutor !== undefined
  ) {
    registry.register(
      new RemoteNodeRuntimeAdapter({
        database: options.database,
        nodeRegistryService: options.nodeRegistryService,
        leaseScheduler: options.leaseScheduler,
        remoteNodeExecutor: options.remoteNodeExecutor,
      }),
    );
  }

  return registry;
};

const resolveRuntimeSessionService = (
  options: ServerOptions,
  runtimeRegistry: RuntimeRegistry | undefined,
): RuntimeSessionService | undefined => {
  if (options.runtimeSessionService !== undefined) {
    return options.runtimeSessionService;
  }

  if (options.database === undefined || runtimeRegistry === undefined) {
    return undefined;
  }

  return new RuntimeSessionService(
    runtimeRegistry,
    new RuntimeSelectionService(runtimeRegistry),
    options.database,
  );
};

const startRuntimeReconciliation = (runtimeSessionService: RuntimeSessionService | undefined): void => {
  if (runtimeSessionService === undefined) {
    return;
  }

  void runtimeSessionService.reconcileOnStartup().catch((error: unknown) => {
    console.error("runtime startup reconciliation failed", error);
  });
};