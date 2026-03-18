# Cloudflare Sandbox Adapter — Technical Design

## Overview

This design adds a `Cloudflare Sandbox` backend as a later managed-provider option for `or3-net`.

Unlike the `OpenSandbox` integration, this backend cannot be implemented as a direct Bun SDK wrapper because the official Cloudflare runtime model is:

- Worker-owned control plane
- `Durable Objects` for stateful sandbox identity
- `Containers` as the underlying execution runtime
- `Sandbox SDK` methods exposed inside Worker code

That means the correct shape for `or3-net` is:

1. a **Cloudflare Worker bridge** that owns `@cloudflare/sandbox`
2. a **Bun-side HTTP client wrapper** in `or3-net`
3. normal `RuntimeAdapter` and `NodeExecutionAdapter` implementations behind the existing OR3 seams

## External findings that change the design

### 1. Direct Bun integration is the wrong abstraction

The official SDK is built around `getSandbox(env.Sandbox, id)` and Worker request handlers.
`or3-net` does not run inside a Worker and does not own `DurableObjectNamespace` bindings.

**Design consequence:** Cloudflare integration must be a remote bridge, not a local SDK dependency in runtime code.

### 2. Preview URLs are not just “provider endpoint lookup”

Cloudflare preview routing requires:

- `proxyToSandbox()` in the Worker fetch handler
- a custom hostname for wildcard subdomains
- no reliance on `.workers.dev` for wildcard port preview routing

**Design consequence:** preview support must be treated as a separately gated capability, not assumed from basic process support.

### 3. Port exposure is sandbox-level, not explicit-session-level

The docs and SDK examples support explicit sessions for exec/files/processes, but port exposure is documented and tested against the sandbox/default-session surface.

**Design consequence:** the first OR3 implementation should model one OR3 runtime/job/service environment as one named Cloudflare sandbox, not as many OR3 resources packed into one sandbox with explicit sub-sessions.

### 4. Cloudflare already provides some readiness helpers

The SDK exposes process APIs, logs, readiness helpers like `waitForLog()` / `waitForPort()`, and port exposure helpers.

**Design consequence:** the Worker bridge should expose those capabilities where they help OR3 service launch and preview flows, rather than rebuilding readiness logic entirely in `or3-net`.

## Goals

- Add Cloudflare Sandbox as a managed provider without changing OR3 public API contracts
- Preserve the provider-neutral `RuntimeAdapter` and `NodeExecutionAdapter` boundaries
- Keep Cloudflare-specific code isolated to a bridge plus Bun wrapper
- Preserve OR3 preview capability semantics even when Cloudflare preview URLs are used underneath
- Make degraded modes explicit when preview custom-domain requirements are not met

## Non-goals

- Replace `OpenSandbox` as the primary backend
- Force local development onto Workers
- Expose raw Cloudflare preview URLs directly as OR3’s only security boundary
- Implement every Cloudflare Sandbox feature in the first cut

## Target architecture

```mermaid
flowchart TD
    Client[Client / CLI / or3-chat] --> Net[or3-net API]
    Net --> Runtime[CloudflareRuntimeAdapter]
    Net --> Jobs[CloudflareNodeAdapter]
    Net --> Previews[OR3 Preview Service]

    Runtime --> CFClient[Cloudflare Sandbox Client Wrapper]
    Jobs --> CFClient
    Previews --> CFClient

    CFClient --> Bridge[Cloudflare Worker Bridge]
    Bridge --> SDK[@cloudflare/sandbox]
    SDK --> DO[Durable Objects]
    SDK --> Containers[Cloudflare Containers]
```

## Component design

### 1. Worker bridge

Suggested location:

- separate bridge package or deployable example under `or3-net`
- keeps Worker-specific code out of core Bun runtime paths

Responsibilities:

- authenticate OR3 bridge requests
- translate bridge HTTP requests into `Sandbox SDK` calls
- own preview URL routing via `proxyToSandbox()`
- normalize Cloudflare SDK failures into a stable bridge error shape
- expose a narrow HTTP surface for OR3 operations

Suggested bridge endpoints:

- `POST /sandboxes`
- `GET /sandboxes/:id`
- `DELETE /sandboxes/:id`
- `POST /sandboxes/:id/exec`
- `POST /sandboxes/:id/processes`
- `GET /sandboxes/:id/processes/:processId`
- `DELETE /sandboxes/:id/processes/:processId`
- `GET /sandboxes/:id/processes/:processId/logs`
- `PUT /sandboxes/:id/files/*`
- `GET /sandboxes/:id/files/*`
- `POST /sandboxes/:id/mkdir`
- `POST /sandboxes/:id/ports/:port/expose`
- `DELETE /sandboxes/:id/ports/:port/expose`
- `GET /sandboxes/:id/ports`
- `GET /health`

The bridge should stay deliberately narrower than the full Cloudflare SDK.

### 2. Bun-side wrapper

Suggested location:

- `sdk/cloudflare-sandbox/types.ts`
- `sdk/cloudflare-sandbox/client.ts`

Responsibilities:

- own HTTP transport to the Worker bridge
- own request signing or bearer authentication
- normalize provider and transport failures
- expose only the subset of operations needed by OR3 runtime and node adapters

This is the Cloudflare equivalent of the current `sdk/opensandbox` layer, except the backing transport is HTTP to the Worker bridge rather than a local third-party SDK.

### 3. `CloudflareRuntimeAdapter`

Responsibilities:

- register a normal OR3 runtime manifest
- create one named Cloudflare sandbox per OR3 runtime session
- execute commands via bridge exec APIs
- support copy-in/copy-out using file APIs
- destroy sandboxes when runtime sessions are destroyed

Recommended manifest posture for v1:

- `adapter_id`: `cloudflare-sandbox`
- `adapter_kind`: `cloudflare`
- `locality`: `remote`
- `session_modes`: `['ephemeral']` initially
- capabilities only for proven surfaces (`exec`, `copy-in`, `copy-out`, `file-rw`, `workspace-write`, `service-expose`, `stop`)

### 4. `CloudflareNodeAdapter`

Responsibilities:

- provision dedicated job sandboxes for task execution
- stage artifacts under `/workspace`
- stream stdout/stderr/result into the OR3 job event model
- create and manage long-lived sandbox instances for service-launch-capable nodes
- revoke service launches by stopping processes, unexposing ports, or destroying the node sandbox according to the chosen lifecycle policy

## Capability mapping

| OR3 need | Cloudflare surface | First-cut plan |
|----------|--------------------|----------------|
| runtime session create | named sandbox via Worker bridge | supported |
| foreground exec | `sandbox.exec()` | supported |
| streaming output | `exec(..., { stream: true })` or bridge streaming | supported |
| file staging | `writeFile`, `readFile`, `mkdir` | supported |
| background services | `startProcess`, `getProcessLogs`, `killProcess` | supported |
| service readiness | `waitForLog`, `waitForPort` via bridge or bridge-side polling | supported |
| preview URL | `exposePort()` + `proxyToSandbox()` | supported only with custom domain |
| preview revoke | `unexposePort()` plus OR3 capability revoke | supported |
| archive workspace import/export | no required first-class assumption from research | not in v1 |
| pooled warm sandboxes | possible later optimization | not in v1 |

## Preview model

### Baseline rule

OR3 preview capabilities remain the browser-facing control surface.

### Underlying provider behavior

Cloudflare may generate a provider preview URL for an exposed port, but:

- the Worker must route preview traffic through `proxyToSandbox()`
- the operator needs a custom wildcard domain
- direct provider URL exposure does not replace OR3 capability issuance

### Recommended OR3 behavior

Option A — preferred for security parity:

- OR3 preview URL stays primary
- OR3 preview handler redirects or proxies to the Cloudflare preview URL only after capability validation

Option B — degraded but acceptable for some managed deployments:

- OR3 returns a capability-gated redirect to the Cloudflare preview URL
- revocation is enforced at the OR3 entrypoint, even if the provider preview URL could continue to exist until unexposed

### Unsupported/degraded state

If the deployment only has `.workers.dev` and no wildcard custom domain, the adapter should:

- register exec/file capabilities normally
- mark preview/service exposure as unavailable or degraded in health/docs
- avoid advertising preview success for launch flows that cannot route correctly

## Lifecycle model

### Runtime sessions

- `createSession()` provisions a named sandbox id derived from workspace + session
- `exec()` runs against that sandbox
- `destroySession()` destroys the sandbox

### Job execution

- create one named sandbox per job execution
- stage task artifacts
- run job command
- destroy sandbox on completion unless policy keeps it for debugging

### Service-backed nodes

- create or reuse one named sandbox per workspace + node id
- start background process for service
- expose port only after readiness succeeds
- revoke by unexposing port and applying process/sandbox cleanup policy

## Security model

- bridge endpoints require explicit auth from `or3-net`
- bridge never trusts browser callers directly
- OR3 public APIs never expose Cloudflare credentials
- preview access remains gated by OR3 capabilities
- provider errors are normalized before returning to public OR3 routes

## Risks and mitigations

### 1. Platform coupling risk

Risk:

- Cloudflare-specific worker/runtime assumptions leak into Bun code

Mitigation:

- keep all Worker-specific imports inside the bridge
- use a narrow Bun wrapper interface mirroring current provider-wrapper patterns

### 2. Preview-domain misconfiguration

Risk:

- operators enable previews without wildcard custom domain support

Mitigation:

- startup validation and health reporting must flag preview as unavailable
- docs must explicitly call out `.workers.dev` limitations

### 3. Service lifecycle drift

Risk:

- long-lived service sandboxes accumulate stale processes or stale exposed ports

Mitigation:

- store OR3 metadata on sandbox ids/process ids
- make revoke idempotent
- expose bridge-side list/inspect endpoints for reconciliation

### 4. Cost and quota surprises

Risk:

- managed runtime pricing or limits differ sharply from self-hosted expectations

Mitigation:

- keep Cloudflare as opt-in managed provider
- document known quota and preview requirements before enabling by default anywhere

## Recommended rollout

### Phase 1 — bridge contract and client

- define bridge HTTP contract
- implement Worker bridge auth + lifecycle + exec + file APIs
- add Bun wrapper and contract tests

### Phase 2 — runtime adapter

- add `CloudflareRuntimeAdapter`
- support create/exec/copy/destroy
- register only proven capabilities

### Phase 3 — node execution and services

- add `CloudflareNodeAdapter`
- support task staging, job streaming, process logs, readiness
- add preview launch/revoke behavior with degraded-mode handling

### Phase 4 — operator hardening

- add preview-domain validation
- add reconciliation/cleanup guidance
- add docs for deployment, debugging, and cost caveats

## Open questions

- Should the Worker bridge live inside `or3-net` as a deployable example, or in a dedicated provider package?
- Should preview launch use redirect semantics or proxy semantics by default?
- Do we want runtime sessions to expose a persistent-mode option later, or keep Cloudflare runtime sessions ephemeral-only?
- How much readiness logic should stay in the bridge versus `or3-net`?