# OpenSandbox Migration — Technical Design

## Overview

This design removes the remaining `or3-sandbox` integration from `or3-net` and replaces it with an `OpenSandbox`-backed runtime and node execution path.

The migration is intentionally split into two layers:

1. **Provider-neutral OR3 seams** inside `or3-net`
2. **Concrete OpenSandbox implementation** behind those seams

This keeps the change focused while avoiding a second hard-coded provider shape. It also makes a later `OpenShell` adapter possible without redoing the full application layer a second time.

The design is based on the current `or3-net` coupling points and the current OpenSandbox server and TypeScript SDK capabilities:

- `Sandbox.create(...)`
- `SandboxManager.create(...)`
- `sandbox.commands.run(...)`
- `sandbox.files.*`
- `sandbox.getInfo()`
- `sandbox.pause()`, `sandbox.resume()`, `sandbox.renew()`, `sandbox.kill()`
- `sandbox.getEndpoint()` / `sandbox.getEndpointUrl()`

## Goals

- Remove `sdk/sandbox/*`, `SandboxRuntimeAdapter`, `SandboxNodeAdapter`, and `WarmPoolManager` from `or3-net`
- Preserve runtime session behavior, remote job execution, workspace staging, and preview launch
- Normalize OpenSandbox errors and streaming output into existing OR3 contracts
- Keep Bun compatibility and avoid spreading third-party SDK calls across the codebase

## Provider Selection

The recommended first replacement backend for `or3-net` is `OpenSandbox`.

### Why `OpenSandbox` is the best first choice

`OpenSandbox` is the best first migration target because it most closely matches the execution-provider role that `or3-net` already needs:

- self-hosted deployment is a first-class path
- current docs and SDKs expose lifecycle, command, file, and endpoint operations directly
- the architecture is designed for coding agents, browser automation, remote development, and code execution workloads
- the JavaScript/TypeScript SDK reduces the amount of provider-specific glue `or3-net` must own
- ingress and endpoint exposure are explicit enough to support `or3-net` preview and service-launch mediation

### Why not `Cloudflare Sandboxes` first

`Cloudflare Sandboxes` is a strong later provider option, especially for managed deployments, but it is not the best first migration target for the core `or3-net` backend because:

- it introduces strong Cloudflare platform coupling
- its execution model is centered on Workers/Containers rather than a provider-neutral self-hosted control-plane posture
- preview URLs are excellent for product UX, but the deployment and trust model differs more sharply from the current `or3-net` assumptions

### Why not `OpenShell` first

`OpenShell` is interesting and may become a valuable optional backend later, but it is not the best first replacement because:

- its public positioning is currently more product/gateway oriented than backend-contract oriented
- it is still presented as early/alpha software
- the current docs are less explicit about the kind of backend lifecycle and service-exposure primitives `or3-net` needs to depend on programmatically

For those reasons, this design standardizes on `OpenSandbox` first and treats `Cloudflare Sandboxes` and `OpenShell` as follow-on providers.

## Non-Goals

- Implement `OpenShell` in the same migration
- Preserve `or3-sandbox`-specific API compatibility at the `or3-net` internal layer
- Build a generic provider plugin system beyond the minimum seam needed for this migration
- Recreate every `or3-sandbox` feature if OpenSandbox offers a simpler equivalent

## Current Coupling in `or3-net`

The `or3-sandbox` dependency is concentrated in the following areas:

- `sdk/sandbox/*` — transport, contracts, and provider error type
- `src/runtime/adapters/sandbox.ts` — runtime session adapter
- `src/nodes/adapter-sandbox.ts` — task execution and service launch adapter
- `src/scheduler/warmpool.ts` — provider-specific pre-provisioning helper
- `src/api/app.ts` — node service routes and provider error handling
- `src/execution/local-jobs.ts` — provider-specific remote execution path
- `src/contracts/platform/compat.ts` — provider-specific error normalization
- related tests and docs under `tests/**` and `docs/**`

This migration removes those provider-specific surfaces rather than layering OpenSandbox on top of them.

## Target Architecture

```mermaid
flowchart TD
    Client[Client / CLI / or3-chat] --> Net[or3-net API]
    Net --> Runtime[RuntimeSessionService]
    Net --> Jobs[LocalJobService]
    Net --> Previews[PreviewService]

    Runtime --> ORA[OpenSandboxRuntimeAdapter]
    Jobs --> ONA[OpenSandboxNodeAdapter]
    Previews --> ONA

    ORA --> OSC[OpenSandboxClient Wrapper]
    ONA --> OSC

    OSC --> OSSDK[@alibaba-group/opensandbox]
    OSSDK --> OSServer[OpenSandbox Server]
    OSServer --> Execd[execd / Files / Commands]
    OSServer --> Ingress[Endpoint / Ingress]
```

## Design Decisions

### 1. Use an internal OpenSandbox wrapper

`or3-net` should not call `@alibaba-group/opensandbox` directly from runtime, jobs, API, and tests.

Instead, add a narrow wrapper in `sdk/opensandbox/` that:

- owns OpenSandbox connection setup
- owns provider exception translation
- exposes only the methods `or3-net` actually needs
- isolates Bun compatibility issues to one module

This mirrors the role currently played by `sdk/sandbox/*` without preserving the old contract.

### 2. Replace provider-specific application types with provider-neutral seams

The current `SandboxNodeAdapter` name leaks the old provider into application services.
To remove `or3-sandbox` cleanly, define one internal interface for sandbox-style node execution.

Example shape:

```ts
export interface NodeExecutionAdapter {
  executeTaskWithProgress(
    workspaceId: string,
    taskPackage: TaskPackage,
    onEvent?: (event: ProviderExecEvent) => Promise<void> | void,
  ): Promise<{ instance_id: string; exit_code: number }>;

  listServices(node: StoredNode): NodeServiceDescriptor[];
  prepareServiceLaunch(...): Promise<InternalServiceLaunch>;
  restartService(...): Promise<{ service_id: string; status: "ready" }>;
  revokeServiceLaunch(...): Promise<number>;
}
```

`src/api/app.ts`, `src/execution/local-jobs.ts`, and `src/server.ts` should depend on this interface rather than on a provider-branded class.

### 3. Drop warm-pool behavior in the first OpenSandbox implementation

`WarmPoolManager` is tightly coupled to the old sandbox contract and adds migration complexity without being required for correctness.

The first OpenSandbox implementation should:

- create instances on demand
- optionally reuse long-lived service instances where required for previews
- defer pre-provisioning/pooling until after functional parity and performance measurements

This reduces surface area and avoids rebuilding custom lifecycle orchestration on top of a provider that may already evolve its own pooling features.

### 4. Keep `RuntimeAdapter` unchanged

The current runtime abstraction is already sufficient.
The OpenSandbox migration should add a concrete `OpenSandboxRuntimeAdapter` without redesigning runtime sessions.

This keeps the change local to provider integration rather than destabilizing the control-plane core.

### 5. Move preview security responsibility to `or3-net`

OpenSandbox clearly supports endpoint lookup and ingress exposure, but the current research does **not** establish parity with `or3-sandbox`'s signed browser-tunnel URL flow.

Therefore the design assumes:

- OpenSandbox gives `or3-net` an endpoint or URL
- `or3-net` remains responsible for minting short-lived preview capabilities
- deployments must avoid exposing raw provider endpoints directly to browsers unless that risk is explicitly accepted

Preferred deployment posture:

- OpenSandbox endpoint exposure remains private to `or3-net`, or
- `or3-net` proxies browser traffic through an OR3-owned launch or relay path

## Components

### `sdk/opensandbox/client.ts`

Purpose:

- Wrap OpenSandbox SDK lifecycle and execution APIs
- Normalize provider errors
- Present a compact internal interface for `or3-net`

Candidate interface:

```ts
export interface OpenSandboxClient {
  create(input: OpenSandboxCreateRequest): Promise<OpenSandboxInstance>;
  connect(instanceId: string): Promise<OpenSandboxConnection>;
  list(input?: OpenSandboxListRequest): Promise<OpenSandboxInstanceInfo[]>;
  get(instanceId: string): Promise<OpenSandboxInstanceInfo>;
  kill(instanceId: string): Promise<void>;
  pause(instanceId: string): Promise<void>;
  resume(instanceId: string): Promise<OpenSandboxConnection>;
  renew(instanceId: string, timeoutSeconds: number): Promise<void>;
}

export interface OpenSandboxConnection {
  runCommand(
    command: string,
    handlers?: OpenSandboxExecutionHandlers,
  ): Promise<OpenSandboxCommandResult>;
  writeFiles(entries: OpenSandboxWriteFileInput[]): Promise<void>;
  readFile(path: string): Promise<string>;
  createDirectories(paths: OpenSandboxDirectoryInput[]): Promise<void>;
  getEndpoint(port: number): Promise<{ endpoint: string; url?: string }>;
  close(): Promise<void>;
}
```

### `src/runtime/adapters/opensandbox.ts`

Purpose:

- Implement `RuntimeAdapter` on top of the wrapper
- Map runtime session lifecycle to provider instance lifecycle
- Normalize execution and staging semantics

State mapping example:

| OpenSandbox state | OR3 runtime session state |
| --- | --- |
| `Running` | `ready` |
| `Pending` / `Creating` | `creating` |
| `Paused` | `stopped` |
| `Terminated` / `Failed` | `failed` or `destroyed` depending on provider detail |

### `src/nodes/adapter-opensandbox.ts`

Purpose:

- Execute `TaskPackage` workloads in OpenSandbox
- Stage artifacts before execution
- Resolve service endpoints for preview launches
- Own service instance restart and cleanup behavior

Metadata written to provider instances should include OR3 identity for observability and filtering:

```ts
interface Or3OpenSandboxMetadata {
  or3_workspace_id: string;
  or3_role: "runtime" | "service" | "job";
  or3_node_id?: string;
  or3_session_id?: string;
  or3_job_id?: string;
  or3_service_id?: string;
}
```

### `src/contracts/platform/compat.ts`

Purpose:

- Replace `normalizeSandboxError()` with OpenSandbox-specific or provider-generic normalization
- Preserve the public error envelope contract

### `src/api/app.ts`

Required changes:

- stop importing `SandboxRequestContext` and `SandboxRequestError`
- stop requiring `SandboxNodeAdapter`
- depend on the provider-neutral node execution interface for service routes
- keep `PreviewService` launch minting unchanged at the public API layer

### `src/execution/local-jobs.ts`

Required changes:

- stop branching on provider-branded adapter types
- route sandbox-style node execution through the new node execution interface
- keep stream normalization behavior unchanged from the caller perspective

## Data and Configuration Model

### New runtime adapter identity

Use a dedicated runtime adapter id and display name:

```ts
const manifest = {
  adapter_id: "opensandbox",
  display_name: "OpenSandbox",
  adapter_kind: "sandbox",
  isolation_class: "sandbox",
  locality: "remote",
};
```

`adapter_kind` remains `sandbox` so the higher-level OR3 concepts continue to treat it as a sandbox-style backend.

### OpenSandbox configuration

Add explicit provider configuration for `or3-net`.

```ts
interface OpenSandboxConfig {
  baseUrl?: string;
  domain?: string;
  apiKey: string;
  defaultImage: string;
  defaultTimeoutSeconds: number;
  endpointMode: "private-relay" | "direct";
  resourceDefaults?: {
    cpu?: string;
    memory?: string;
  };
}
```

Suggested env names:

- `OR3_NET_OPENSANDBOX_BASE_URL`
- `OR3_NET_OPENSANDBOX_DOMAIN`
- `OR3_NET_OPENSANDBOX_API_KEY`
- `OR3_NET_OPENSANDBOX_DEFAULT_IMAGE`
- `OR3_NET_OPENSANDBOX_DEFAULT_TIMEOUT_SECONDS`
- `OR3_NET_OPENSANDBOX_ENDPOINT_MODE`

### Workspace staging

OpenSandbox clearly supports file operations, but archive import/export parity is not yet established by the current docs review.

Therefore the first implementation should advertise:

- `file_api: true`
- `archive: false`

If later research confirms a robust upload/download archive path through the SDK or server API, archive transport can be added without changing the public runtime contract.

## Error Handling

### Provider errors

OpenSandbox SDK errors should be normalized immediately in the wrapper.

```ts
export class OpenSandboxRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;
}
```

### Runtime mapping

- creation failures → `adapter_unavailable` or `adapter_internal`
- command failures → `exec_failed`
- file staging failures → `copy_failed`
- missing endpoint or service not ready → `adapter_unavailable` or `resource_not_ready` equivalent at the API layer

### Preview risk handling

If deployment chooses `endpointMode=direct`, the design must explicitly document that OR3 preview revocation controls the OR3 launch URL, not the raw provider endpoint itself.

That is acceptable only as an explicit operator tradeoff, not as an implicit default.

## Testing Strategy

### Unit tests

- OpenSandbox wrapper request/response normalization
- OpenSandbox error normalization
- runtime state mapping between OpenSandbox and `RuntimeAdapterSessionHandle`
- job stream normalization from OpenSandbox execution handlers into OR3 stream events
- preview launch metadata generation from provider endpoints

### Integration tests

- runtime session create / exec / destroy through `OpenSandboxRuntimeAdapter`
- local-job remote execution through `OpenSandboxNodeAdapter`
- service launch / restart / revoke behavior through the new adapter
- provider error → platform error envelope translation

### Contract tests

- verify the wrapper against the subset of OpenSandbox APIs actually used by `or3-net`
- validate Bun compatibility for the chosen SDK usage path

### End-to-end tests

- create runtime session, execute command, inspect output
- submit remote job targeting sandbox backend
- launch preview for service-backed node
- revoke preview and confirm OR3 launch path expires

## Migration Sequence

### Step 1: Introduce new seams without deleting old code

- add `sdk/opensandbox/*`
- add provider-neutral node execution interface
- wire application services to the interface

### Step 2: Land OpenSandbox implementations

- add `OpenSandboxRuntimeAdapter`
- add `OpenSandboxNodeAdapter`
- add OpenSandbox-specific tests

### Step 3: Cut runtime and preview flows over

- switch server wiring and tests to OpenSandbox
- validate job execution and preview launch parity

### Step 4: Delete legacy sandbox code

- remove `sdk/sandbox/*`
- remove `src/runtime/adapters/sandbox.ts`
- remove `src/nodes/adapter-sandbox.ts`
- remove `src/scheduler/warmpool.ts`
- remove stale docs and planning references in active `or3-net` docs

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Bun incompatibility with `@alibaba-group/opensandbox` | blocks direct adoption | run a Bun compatibility spike before full code migration; keep the wrapper thin so fallback HTTP calls remain possible |
| No exact equivalent to signed browser tunnel URLs | could weaken preview security | keep preview mediation in `or3-net`; prefer private ingress or OR3-owned relay |
| Missing archive transport parity | runtime staging regression | ship file-based staging first and advertise `archive: false` |
| Over-generalizing provider abstractions | slows delivery | add only one provider-neutral interface at the node execution boundary |
| Large test churn | migration becomes hard to finish | replace tests in phases aligned to the cutover steps rather than deleting all at once |

## Follow-on Work

- Evaluate `Cloudflare Sandboxes` as a managed-hosting provider after the OpenSandbox backend is stable
- Add `OpenShell` as a later optional provider after OpenSandbox is stable
- Evaluate whether OpenSandbox pooling features are worth exposing in `or3-net`
- Revisit archive transport and preview relays after the first production cut
