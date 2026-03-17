# OpenSandbox Migration — Requirements

## Introduction

This plan removes the remaining `or3-sandbox` SDK, adapter, warm-pool, and provider-specific integration code from `or3-net`, then replaces the execution backend with an `OpenSandbox` adapter built on the current OpenSandbox lifecycle and JavaScript SDK surfaces.

The goal is to stop `or3-net` from owning a custom sandbox backend while preserving the parts of the product that matter:

- runtime session creation and execution
- workspace file staging
- node-backed task execution
- preview and service launch flows
- normalized error handling and streaming output
- Bun-first developer experience

This migration is scoped to `or3-net`.
It does not require `or3-chat`, `or3-intern`, or `OpenShell` work to ship in the same change, but it should leave `or3-net` in a shape where additional sandbox providers can be added later.

### Recommended provider choice

For this migration, `OpenSandbox` is the recommended first replacement backend.

It is the best fit for `or3-net` because it is the closest match to the current control-plane needs:

- self-hostable rather than tied to one managed platform
- explicit lifecycle APIs for sandbox create/list/get/pause/resume/kill
- first-party JavaScript/TypeScript SDK surface
- built-in command execution and file operations
- endpoint and ingress exposure for browser-facing services
- architecture aimed at agent, browser, and remote-development workloads

`Cloudflare Sandboxes` remains a strong later option for a managed deployment mode, but it is not the first recommendation for the primary `or3-net` backend because it introduces stronger platform coupling and a different operational model.

`OpenShell` remains a possible later integration, but it is not the recommended first replacement because its current public positioning is more gateway/product-oriented and less obviously aligned with `or3-net`'s need for a stable, explicit backend lifecycle contract.

## Requirements

### 1. Remove `or3-sandbox` as an OR3 Net dependency

**As** `or3-net`, **I want** all `or3-sandbox`-specific SDK, adapter, and runtime wiring removed, **so that** the control plane no longer depends on a custom sandbox daemon that the project must maintain.

**Acceptance Criteria:**

- WHEN the migration is complete, THEN `or3-net` SHALL contain no production code imports from `sdk/sandbox/*`.
- WHEN the migration is complete, THEN `or3-net` SHALL contain no production code references to `SandboxRuntimeAdapter`, `SandboxNodeAdapter`, or `WarmPoolManager`.
- WHEN the migration is complete, THEN runtime, jobs, previews, and API routes SHALL no longer require any `or3-sandbox`-specific type names or error classes.
- WHEN the migration is complete, THEN `or3-net` docs and active planning docs SHALL no longer describe `or3-sandbox` as the primary execution backend.

### 2. Introduce an `OpenSandbox` client wrapper

**As** `or3-net`, **I want** a thin internal OpenSandbox wrapper, **so that** the rest of the codebase can use a stable Bun-friendly interface instead of depending directly on third-party SDK details.

**Acceptance Criteria:**

- WHEN `or3-net` integrates OpenSandbox, THEN it SHALL do so through an internal wrapper module under `sdk/opensandbox/`.
- WHEN the wrapper is implemented, THEN it SHALL support the `or3-net` operations currently required by runtime sessions and node execution:
  - create sandbox
  - connect to sandbox by id
  - list sandbox infos
  - get sandbox info
  - run commands
  - stage files
  - read files
  - get service endpoint information
  - pause, resume, renew, and kill sandbox instances
- WHEN OpenSandbox returns provider-specific exceptions, THEN the wrapper SHALL normalize them into an `or3-net` provider error type with status, code, and retry metadata when available.
- WHEN the wrapper is used from Bun, THEN it SHALL be validated against the current `or3-net` runtime and dependency constraints before full migration proceeds.

### 3. Replace the runtime adapter with `OpenSandbox`

**As** `or3-net`, **I want** a runtime adapter backed by OpenSandbox, **so that** runtime sessions continue to work after the `or3-sandbox` adapter is removed.

**Acceptance Criteria:**

- WHEN a runtime session is created for the OpenSandbox backend, THEN `or3-net` SHALL provision an OpenSandbox instance and persist the provider session reference.
- WHEN a runtime session is executed, THEN `or3-net` SHALL run the command inside OpenSandbox and return normalized stdout, stderr, exit code, and execution errors.
- WHEN a runtime session is listed or fetched, THEN `or3-net` SHALL map OpenSandbox lifecycle state into `RuntimeAdapterSessionHandle.status` values.
- WHEN a runtime session is destroyed or stopped, THEN `or3-net` SHALL issue the corresponding OpenSandbox lifecycle action and persist the resulting terminal state.
- WHEN archive-based workspace transport is not available through OpenSandbox, THEN the adapter SHALL either:
  - expose only file-based workspace staging capabilities, or
  - implement an equivalent archive transport through the provider wrapper.

### 4. Replace sandbox-backed node execution and service launch

**As** `or3-net`, **I want** task execution and service launch flows to run through an OpenSandbox-backed node adapter, **so that** jobs and previews continue to work after the old sandbox adapter is removed.

**Acceptance Criteria:**

- WHEN a job targets a sandbox-style node backend, THEN `or3-net` SHALL execute the task package through the OpenSandbox-backed node adapter.
- WHEN task artifacts are staged for execution, THEN `or3-net` SHALL write them into the OpenSandbox filesystem before command execution begins.
- WHEN command output is produced by OpenSandbox, THEN `or3-net` SHALL normalize it into the existing job stream event model.
- WHEN a node service is launched, THEN `or3-net` SHALL resolve the provider endpoint through OpenSandbox and return browser launch metadata through the existing preview service.
- WHEN a node service is restarted or revoked, THEN `or3-net` SHALL apply the equivalent provider-side lifecycle changes and revoke any OR3-side preview capabilities.

### 5. Preserve preview and launch security semantics

**As** `or3-net`, **I want** preview launches to remain workspace-scoped and revocable, **so that** replacing the backend does not accidentally weaken browser access controls.

**Acceptance Criteria:**

- WHEN `or3-net` returns a launch URL for an OpenSandbox-backed service, THEN it SHALL continue to mint an OR3 preview capability before exposing browser-facing access.
- WHEN the underlying OpenSandbox endpoint is not inherently revocable, THEN deployment guidance SHALL require one of the following:
  - OpenSandbox ingress remains private to `or3-net`, or
  - `or3-net` mediates browser access through an OR3-owned proxy or relay.
- WHEN a launch capability is revoked or expires, THEN the OR3 launch path SHALL become unusable even if the provider sandbox remains alive.
- WHEN iframe eligibility is determined, THEN `or3-net` SHALL continue to make that decision at the OR3 preview layer rather than delegating it to the provider.

### 6. Preserve control-plane error and stream normalization

**As** `or3-net`, **I want** OpenSandbox failures and execution output translated into the same public platform shapes, **so that** callers do not need backend-specific handling.

**Acceptance Criteria:**

- WHEN OpenSandbox operations fail, THEN `or3-net` SHALL map those failures into the platform error envelope used by existing API routes and job results.
- WHEN OpenSandbox emits command output incrementally, THEN `or3-net` SHALL translate it into the existing stream event vocabulary for jobs and runtime execution.
- WHEN a provider-specific state has no direct OR3 equivalent, THEN `or3-net` SHALL map it conservatively and document the mapping.

### 7. Keep configuration explicit and provider-specific

**As** an operator, **I want** a clear OpenSandbox configuration surface, **so that** the new backend can be deployed without hidden assumptions from the old `or3-sandbox` stack.

**Acceptance Criteria:**

- WHEN the OpenSandbox backend is configured, THEN `or3-net` SHALL use explicit configuration for provider URL or domain, API key, default image policy, timeout defaults, and endpoint exposure expectations.
- WHEN `or3-net` starts without required OpenSandbox configuration, THEN it SHALL fail clearly instead of silently falling back to removed `or3-sandbox` code paths.
- WHEN the migration is complete, THEN any `OR3_SANDBOX_*` deployment guidance in active `or3-net` docs SHALL be removed or replaced.

### 8. Complete the migration with tests and documentation

**As** a maintainer, **I want** the migration to leave `or3-net` clean and verifiable, **so that** the codebase does not retain dead legacy branches or misleading docs.

**Acceptance Criteria:**

- WHEN the migration is complete, THEN tests covering `sdk/sandbox`, `SandboxRuntimeAdapter`, `SandboxNodeAdapter`, and warm-pool behavior SHALL be deleted or replaced.
- WHEN the migration is complete, THEN new tests SHALL cover the OpenSandbox wrapper, runtime adapter behavior, node execution flow, preview launch flow, and error normalization.
- WHEN the migration is complete, THEN `or3-net` documentation SHALL describe OpenSandbox as the supported sandbox backend for this path.
- WHEN the migration is complete, THEN no user-facing or maintainer-facing `or3-net` docs SHALL claim that `or3-sandbox` is still the primary runtime backend.

## Out of Scope

- Implementing `OpenShell` in the same change.
- Reworking `or3-intern` contracts.
- Building a generalized provider marketplace inside `or3-net`.
- Reintroducing client-side warm pools before the OpenSandbox migration is stable.
