# Cloudflare Sandbox Adapter — Requirements

## Introduction

This plan adds a future `Cloudflare Sandbox` execution backend to `or3-net` without undoing the provider-neutral runtime and node adapter seams introduced during the `OpenSandbox` migration.

The Cloudflare path is intentionally treated as a **managed deployment option**, not as the default backend for core `or3-net` development.

The official Cloudflare docs and SDK research establish several constraints that shape this plan:

- `Sandbox SDK` is built on `Workers`, `Durable Objects`, and `Containers`
- sandbox lifecycle is owned by Worker code, not by a standalone self-hosted control plane
- preview URL routing requires `proxyToSandbox()` in the Worker
- preview URLs require a **custom domain with wildcard DNS**; `.workers.dev` is not sufficient for production preview routing
- explicit SDK sessions support exec/files/processes, but **port exposure is sandbox-level rather than explicit-session-level**

Those constraints mean `or3-net` should integrate Cloudflare through a **Worker-hosted bridge service** plus a Bun-side client wrapper, rather than trying to call the Cloudflare SDK directly from Bun runtime code.

## Requirements

### 1. Keep `or3-net` provider-neutral

**As** `or3-net`, **I want** the Cloudflare backend to fit the current runtime and node execution seams, **so that** the managed provider does not reintroduce app-layer Cloudflare coupling.

**Acceptance Criteria:**

- WHEN the Cloudflare backend is added, THEN `src/api/app.ts`, `src/execution/local-jobs.ts`, and `src/server.ts` SHALL continue to depend on provider-neutral runtime and node adapter interfaces.
- WHEN the Cloudflare backend is registered, THEN it SHALL publish a normal `RuntimeAdapterManifest` and participate in the existing `RuntimeRegistry`.
- WHEN the Cloudflare backend is unavailable or not configured, THEN `or3-net` SHALL continue to function without Cloudflare-specific imports in unrelated code paths.

### 2. Integrate through a Worker-side bridge, not direct Bun SDK calls

**As** `or3-net`, **I want** a narrow Cloudflare bridge boundary, **so that** Bun code does not depend on Worker-only `DurableObjectNamespace`, `proxyToSandbox()`, or container runtime primitives.

**Acceptance Criteria:**

- WHEN Cloudflare Sandbox support is implemented, THEN `or3-net` SHALL talk to a dedicated Cloudflare bridge over an explicit HTTP contract.
- WHEN the bridge is implemented, THEN it SHALL be the only layer that imports `@cloudflare/sandbox` or other Worker-only Cloudflare container primitives.
- WHEN Bun-side code needs Cloudflare operations, THEN it SHALL do so through an internal wrapper under a Cloudflare-specific SDK folder rather than by issuing ad hoc fetches across the codebase.
- WHEN the bridge is unreachable or misconfigured, THEN `or3-net` SHALL fail clearly with provider-specific error metadata rather than hanging or returning ambiguous transport errors.

### 3. Support the minimum OR3 execution surface

**As** `or3-net`, **I want** the Cloudflare backend to cover the same minimum execution surface as existing sandbox providers, **so that** runtime sessions and remote jobs can use it without backend-specific hacks.

**Acceptance Criteria:**

- WHEN the first Cloudflare adapter ships, THEN the bridge and Bun wrapper SHALL support the operations `or3-net` actually needs:
  - create sandbox
  - get sandbox info
  - destroy sandbox
  - execute foreground commands
  - start, inspect, and kill background processes
  - read and write files
  - create directories
  - read process logs
  - expose and unexpose service ports
  - report provider health
- WHEN command results are returned, THEN stdout, stderr, exit code, and timing metadata SHALL be normalized into OR3 result shapes.
- WHEN provider-specific lifecycle states have no exact OR3 equivalent, THEN the mapping SHALL be conservative and documented.

### 4. Model OR3 sessions as Cloudflare-named sandboxes in the first cut

**As** a maintainer, **I want** the initial Cloudflare mapping to be simple and explicit, **so that** preview and process semantics do not depend on unsupported session-level assumptions.

**Acceptance Criteria:**

- WHEN `or3-net` creates a Cloudflare-backed runtime session in v1, THEN it SHALL provision a dedicated named Cloudflare sandbox for that OR3 session.
- WHEN `or3-net` runs a job in v1, THEN it SHALL provision a dedicated named Cloudflare sandbox per execution or per reusable service node lifecycle, rather than multiplexing unrelated OR3 jobs into one shared sandbox by default.
- WHEN service launch is required, THEN the implementation SHALL rely on sandbox-level process and port APIs rather than explicit SDK sub-sessions.
- WHEN explicit Cloudflare sessions are later introduced for optimization, THEN that work SHALL be documented as a follow-on phase and SHALL not be required for the initial adapter.

### 5. Preserve preview and capability security semantics

**As** `or3-net`, **I want** Cloudflare-backed previews to remain OR3-scoped and revocable, **so that** provider preview URLs do not bypass OR3 launch control.

**Acceptance Criteria:**

- WHEN a Cloudflare-backed service is launched, THEN `or3-net` SHALL continue to mint an OR3 preview capability before returning a browser-facing launch path.
- WHEN Cloudflare preview URLs are used, THEN the Worker bridge SHALL route them through `proxyToSandbox()` as required by the official docs.
- WHEN the deployment only has a `.workers.dev` hostname, THEN preview URL support SHALL be treated as unavailable or degraded because wildcard preview routing requires a custom domain.
- WHEN a launch is revoked or expires, THEN the OR3 launch path SHALL become unusable even if the underlying Cloudflare process or preview URL still exists.
- WHEN iframe/new-tab behavior is exposed to clients, THEN `or3-net` SHALL continue to make the policy decision instead of delegating it to Cloudflare.

### 6. Keep configuration explicit and deployment-scoped

**As** an operator, **I want** Cloudflare requirements called out explicitly, **so that** the managed backend cannot be enabled with hidden assumptions.

**Acceptance Criteria:**

- WHEN the Cloudflare backend is configured, THEN `or3-net` SHALL require explicit values for bridge base URL, auth credentials, account or environment identifiers as needed, and preview hostname policy.
- WHEN preview URLs are enabled, THEN the docs SHALL call out the need for a custom domain with wildcard DNS.
- WHEN required Cloudflare configuration is missing, THEN startup or adapter registration SHALL fail clearly.
- WHEN the Cloudflare backend is disabled, THEN `or3-net` SHALL not attempt background health calls or registration for it.

### 7. Preserve public API and stream contracts

**As** `or3-net` clients, **I want** Cloudflare-backed execution to look like existing OR3 execution, **so that** consumers do not need provider-specific handling.

**Acceptance Criteria:**

- WHEN Cloudflare command output is streamed, THEN it SHALL be normalized into the existing OR3 job stream event vocabulary.
- WHEN Cloudflare operations fail, THEN `or3-net` SHALL map them into the current public error envelope and internal provider error normalization layer.
- WHEN a preview/service launch succeeds or fails, THEN public OR3 launch APIs SHALL keep the same response structure already covered by preview tests.

### 8. Ship with focused tests and deployment docs

**As** a maintainer, **I want** the Cloudflare adapter to land with targeted contract coverage and operator guidance, **so that** the managed backend is supportable.

**Acceptance Criteria:**

- WHEN the Cloudflare Bun wrapper is added, THEN it SHALL have focused contract tests for request building, error mapping, and result normalization.
- WHEN the Worker bridge is added, THEN it SHALL have focused tests for sandbox lifecycle, file ops, process ops, and preview routing behavior.
- WHEN the runtime and node adapters are added, THEN `or3-net` tests SHALL cover adapter registration, exec behavior, service launch, revoke, and degraded preview cases.
- WHEN the plan ships, THEN docs SHALL describe Cloudflare as a managed provider path with explicit preview-domain requirements and current limitations.

## Out of Scope

- Making Cloudflare Sandbox the default development backend for `or3-net`
- Replacing `OpenSandbox` as the primary built-in provider
- Reworking `or3-chat` around raw Cloudflare preview URLs
- Introducing provider-specific client behavior in OR3 public APIs
- Shipping advanced Cloudflare-only features such as bucket mounts, browser terminals, desktop features, or file watching in the first adapter cut