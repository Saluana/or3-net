# Runtime Contract with Adapter Plugins v1 — Requirements

## Overview

This plan introduces a typed runtime adapter contract in `or3-net` that sits above the existing node RPC protocol and transport registry. The contract provides a uniform interface for heterogeneous execution backends—starting with `or3-sandbox` and `remote-node-agent`—so that scheduler, session management, public APIs, and desktop/browser clients can operate on runtime metadata and session lifecycle without provider-specific branching.

### Scope

- Wrap the existing node protocol and transport registry inside adapter implementations; do not replace them.
- Ship working adapters for `or3-sandbox`, `remote-node-agent`, and `local-container` in v1.
- Reserve `fly`, `cloudflare-workers`, `ssh-vm`, and `akash` in the type model but do not implement them.
- Keep `or3-intern` as the execution brain/orchestrator through the existing local job path. It is not a runtime provider in v1.
- Add new workspace-scoped API routes for runtime catalogs and runtime session management.
- Add new DB tables for runtime sessions, events, and artifacts that never collide with `network_sessions`.
- Add new auth scopes for runtime resources that are separate from existing `nodes:*`, `services:*`, and `sessions:*` scopes.

### Assumptions

- The existing node protocol (`src/contracts/protocol.ts`), `NodeTransportRegistry`, `RemoteNodeExecutor`, `SandboxNodeAdapter`, `LeaseScheduler`, `WarmPoolManager`, and `LocalJobService` remain intact as internal implementation details.
- Plugin loading is startup-driven from first-party code or explicitly configured Bun modules. No dynamic install/discovery scanning in v1.
- Runtime sessions use `runtime-sessions` terminology everywhere public and durable. Existing `sessions` routes and `network_sessions` tables keep their current meaning.
- Workspace staging in v1 follows the smaller host-owned model from `planning/host-workspace-staging/`; `workspace-materialize` is staged copy substrate, not a distributed workspace store.

---

## Requirements

### 1. Typed runtime adapter manifest and registration

**Requirement:** The system must provide a typed `RuntimeAdapterManifest` that declares adapter identity, version, supported capabilities, isolation class, trust tier, locality, and health reporting hooks, and a startup `RuntimeRegistry` that validates, registers, and exposes adapter manifests.

**Acceptance criteria:**

- `RuntimeAdapterManifest` is a Zod-validated schema exported from `src/contracts/runtime/`.
- `RuntimeRegistry` accepts manifest registration at startup, validates version and capability declarations, and rejects duplicate adapter IDs.
- `RuntimeRegistry` exposes health aggregation across all registered adapters.
- No dynamic package install or discovery scanning occurs; adapters register explicitly from first-party code or configured Bun modules.

### 2. Typed runtime adapter interface

**Requirement:** The system must define a `RuntimeAdapter` interface that adapter plugins implement, covering the full runtime session lifecycle and execution operations.

**Acceptance criteria:**

- Required methods: adapter metadata, capability reporting, adapter health, runtime/node discovery, create/list/get/destroy session, command execution, basic copy-in/copy-out, log retrieval.
- Optional (capability-gated) methods: stop, resume, live log streaming, file browse/read/write/delete, workspace materialization, service exposure, snapshots, artifact push.
- Each method receives a typed input and returns a typed output or a typed error envelope.
- Optional methods are discoverable through the capability system; calling an unsupported method returns a normalized `unsupported_capability` error.

### 3. Strongly typed capability system

**Requirement:** The system must define a core capability union that scheduler, policy, and UI layers can branch on, plus namespaced adapter-specific extension capabilities.

**Acceptance criteria:**

- Core capabilities include: `exec`, `stop`, `resume`, `copy-in`, `copy-out`, `file-browse`, `file-rw`, `workspace-materialize`, `log-stream`, `service-expose`, `snapshot`, `artifact-push`, `internet`, `public-ingress`, `persistent-session`, `browser`, `package-install`, `secret-inject`, `workspace-write`.
- Adapter-specific extension capabilities use a `ext:<adapter>:<name>` namespace.
- Core code only branches on declared core capabilities. Extension capabilities are passed through to adapter-aware consumer code.
- Capabilities are declared per-adapter and per-runtime-node, not assumed globally.

### 4. Runtime and node descriptors

**Requirement:** The system must expose `RuntimeDescriptor` and `RuntimeNodeDescriptor` shapes that describe available runtimes and their execution nodes with enough metadata for scheduler selection and UI rendering.

**Acceptance criteria:**

- `RuntimeDescriptor` includes: adapter ID, display name, isolation class, trust tier, locality, health, supported capabilities, supported presets, and session modes.
- `RuntimeNodeDescriptor` includes: node ID, runtime ID, health, capabilities, resource limits, and locality.
- Descriptors are workspace-scoped and queryable through the runtime catalog API.
- Desktop/browser clients can render runtime actions from descriptor metadata without adapter-specific conditional branches.

### 5. Runtime session lifecycle

**Requirement:** The system must provide typed session creation, retrieval, listing, stop, resume, and destroy operations that are adapter-delegated but contract-uniform.

**Acceptance criteria:**

- Session creation input includes: `preset_id`, required capabilities, workspace reference/mode, network policy, resource hints, persistence mode, env/secret refs, timeout rules, artifact rules.
- Unsupported fields fail with a normalized `unsupported_capability` or `policy_denied` error, not provider-specific leaks.
- Session state transitions are persisted in `runtime_sessions` and emitted as typed events in `runtime_session_events`.
- Destroy cleans up adapter-side resources and marks session as destroyed in the DB.
- Session listing supports workspace-scoped pagination and status filtering.

### 6. Runtime execution contract

**Requirement:** The system must provide a typed execution request/handle model for running commands within a runtime session.

**Acceptance criteria:**

- Execution input includes: command/task spec, arguments, working directory, environment bindings, timeout, stdin allowance, background/foreground mode.
- Execution returns a typed `RuntimeExecutionHandle` with: result promise, exit metadata, cancellation method, and optional streaming output (async iterable of typed events).
- Execution timeouts are enforced adapter-side with contract-specified soft/hard thresholds.
- Abort is best-effort and returns a typed acknowledgment.

### 7. Normalized error model

**Requirement:** All runtime adapter errors must surface through a typed `RuntimeErrorEnvelope` that extends the platform error model with runtime-specific error codes.

**Acceptance criteria:**

- `RuntimeErrorEnvelope` includes: `code`, `message`, `retriable`, `details`, and optional `retry_after_ms`.
- Error codes cover: `unsupported_capability`, `policy_denied`, `adapter_unavailable`, `session_not_found`, `session_destroyed`, `exec_failed`, `exec_timeout`, `copy_failed`, `log_unavailable`, `adapter_internal`.
- Adapter-specific errors are normalized into the envelope before crossing the public API boundary.
- Existing `RemoteExecutionError` and `SandboxRequestError` map cleanly into the new envelope.

### 8. Artifact tracking

**Requirement:** The system must provide a typed `RuntimeArtifactDescriptor` for tracking files and outputs produced by runtime sessions.

**Acceptance criteria:**

- `RuntimeArtifactDescriptor` includes: artifact ID, session ID, path, kind, content type, size, source metadata.
- Artifacts are persisted in `runtime_artifacts` and queryable per session.
- Artifact push is optional and capability-gated.
- Artifact descriptors are compatible with the existing `ArtifactDescriptor` from `src/contracts/core.ts` but namespaced to runtime sessions.

### 9. Public API routes and auth scopes

**Requirement:** The system must expose workspace-scoped HTTP routes for runtime catalog and runtime session management, gated by new auth scopes.

**Acceptance criteria:**

- Runtime catalog routes:
  - `GET /v1/workspaces/:workspaceId/runtimes` — list available runtimes.
  - `GET /v1/workspaces/:workspaceId/runtimes/:runtimeId` — get runtime details.
  - `GET /v1/workspaces/:workspaceId/runtimes/:runtimeId/nodes` — list runtime nodes.
- Runtime session routes:
  - `POST /v1/workspaces/:workspaceId/runtime-sessions` — create session.
  - `GET /v1/workspaces/:workspaceId/runtime-sessions` — list sessions.
  - `GET /v1/workspaces/:workspaceId/runtime-sessions/:sessionId` — get session.
  - `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/exec` — execute command.
  - `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/stop` — stop session.
  - `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/destroy` — destroy session.
  - `GET /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/logs` — get logs.
  - `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-in` — copy file in.
  - `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-out` — copy file out.
- New scopes: `runtimes:read`, `runtimes:write`, `runtime-sessions:read`, `runtime-sessions:write`.
- Existing `nodes:*`, `services:*`, and `sessions:*` scopes remain unchanged.
- All routes use `ErrorEnvelope` for error responses and require workspace-scoped bearer authentication.

### 10. `or3-sandbox` adapter

**Requirement:** The `or3-sandbox` adapter must preserve current execution, file transfer, log, health, warm pool, and tunnel behavior while implementing the new `RuntimeAdapter` interface.

**Acceptance criteria:**

- Delegates to the existing `SandboxClient` SDK, `SandboxNodeAdapter`, and `WarmPoolManager`.
- Declares capabilities based on sandbox runtime features: `exec`, `stop`, `copy-in`, `copy-out`, `file-browse`, `file-rw`, `log-stream`, `service-expose`, `internet` (gated), `workspace-write`.
- Session create maps to sandbox create/start; destroy maps to sandbox delete.
- Exec maps to sandbox exec/execStream.
- Copy-in/copy-out map to sandbox writeFile/readFile.
- Health maps to sandbox runtimeHealth.
- Existing `SandboxNodeAdapter` behavior is fully preserved for callers that bypass the runtime contract.

### 11. `remote-node-agent` adapter

**Requirement:** The `remote-node-agent` adapter must delegate to the existing node registry, lease scheduler, transport registry, and `RemoteNodeExecutor` while implementing the new `RuntimeAdapter` interface.

**Acceptance criteria:**

- Runtime/node discovery delegates to `NodeRegistryService.listNodes()` filtered to `adapter_kind: 'remote'`.
- Session create issues a lease via `LeaseScheduler` and resolves transport via `NodeTransportRegistry`.
- Exec delegates to `RemoteNodeExecutor.startExecution()`.
- Health delegates to `RemoteNodeExecutor.heartbeat()`.
- Capabilities are derived from node manifests: `exec`, and optionally others based on `node.manifest.capabilities`.
- Existing node enrollment, approval, and credential flows remain untouched.

### 12. `local-container` adapter

**Requirement:** A `local-container` adapter must provide Docker/OCI container-based local execution with the runtime adapter interface.

**Acceptance criteria:**

- Declares capabilities: `exec`, `stop`, `copy-in`, `copy-out`, `file-rw`, `workspace-write`.
- Session create maps to container create/start from a configured image; destroy maps to container remove.
- Exec maps to container exec with timeout enforcement.
- Copy-in/copy-out map to container cp operations.
- Health reports container runtime availability (Docker daemon reachable).
- Trust tier is `development`; isolation class is `container`.
- Must fail cleanly with `adapter_unavailable` if Docker daemon is not reachable.

### 13. Persistence and restart safety

**Requirement:** Runtime session state must survive process restarts and support clean failure behavior on transport loss or adapter health degradation.

**Acceptance criteria:**

- `runtime_sessions`, `runtime_session_events`, and `runtime_artifacts` are durable SQLite tables.
- On restart, sessions in non-terminal states are reconciled: adapter health is probed and sessions are marked failed or recovered.
- Destroy always marks the DB record as destroyed even if the adapter-side cleanup fails.
- Session event history is queryable after restart.

### 14. Catalog and session separation from existing models

**Requirement:** Runtime catalog and session resources must be structurally and conceptually separate from existing node/job/session resources.

**Acceptance criteria:**

- Runtime sessions use `runtime_sessions` tables, not `network_sessions`.
- Runtime catalog routes live under `/v1/workspaces/:workspaceId/runtimes`, not under `/nodes` or `/services`.
- Runtime session routes live under `/v1/workspaces/:workspaceId/runtime-sessions`, not under `/sessions`.
- Runtime auth scopes use `runtimes:*` and `runtime-sessions:*`, not `nodes:*` or `sessions:*`.
- No foreign-key relationships between runtime tables and existing node/job/network-session tables.

---

## Non-functional constraints

- **Backward compatibility:** Existing node protocol, transport registry, lease scheduler, warm pool, local job service, network sessions, and all current API routes must remain fully functional.
- **No dynamic plugin install:** V1 uses first-party code and explicitly configured Bun modules only.
- **Bounded complexity:** Reserved adapter types (Fly, Cloudflare, SSH-VM, Akash) appear in the type model but are not implemented.
- **Security:** Sensitive features (internet, public ingress, persistent sessions, browser, package install, secret injection, workspace write) are explicit capabilities gated by policy, not silently available.
- **Error hygiene:** Adapter-specific error details never leak through the public API boundary.
- **Performance:** Registry and descriptor lookups must be in-memory or single-query; no unbounded scans.
- **`or3-intern` stays parallel:** The existing local `or3-intern` execution path (`LocalJobService`) is not migrated to the runtime contract in v1 and continues to operate as-is.
