# Runtime Services

`src/runtime/` contains the server-side runtime substrate built on top of `src/contracts/runtime/`.

## Components

- `registry.ts` — startup registration and health aggregation for runtime adapters
- `selection.ts` — capability-based runtime and node selection
- `sessions.ts` — persistent runtime session lifecycle, execution delegation, artifact recording, and restart reconciliation
- `adapters/` — first-party runtime adapter implementations

## Startup registration

`src/server.ts` is the default startup integration point.

When available, server startup now:

- creates a `RuntimeRegistry`
- always registers `LocalContainerRuntimeAdapter`
- registers `RemoteNodeRuntimeAdapter` when DB, node registry, lease scheduler, and remote executor dependencies are available
- creates `RuntimeSelectionService` and `RuntimeSessionService`
- kicks off `RuntimeSessionService.reconcileOnStartup()`
- passes the resulting services into `Or3NetApp`

Sandbox execution providers can still be registered manually through `runtimeRegistry` when a deployment wants to offer them, but they are no longer part of the default startup wiring.

Manual `runtimeRegistry` and `runtimeSessionService` overrides are still allowed for tests or custom bootstraps.

## Adapter registration rules

Adapters should:

- declare only capabilities they actually implement at the adapter layer
- normalize backend-specific errors into `RuntimeError`
- preserve runtime session state honestly so reconciliation and polling can reason about transitions
- keep provider-specific details behind the adapter boundary

## Public API boundary

The runtime layer backs these route families in `src/api/app.ts`:

- `/v1/workspaces/:workspaceId/runtimes`
- `/v1/workspaces/:workspaceId/runtimes/:runtimeId`
- `/v1/workspaces/:workspaceId/runtime-sessions`
- `/v1/workspaces/:workspaceId/runtime-sessions/:sessionId/*`

Those routes use the same auth and error-envelope patterns as the rest of `or3-net`, while remaining distinct from the existing `/sessions`, `/nodes`, and `/jobs` resources.
