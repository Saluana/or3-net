# Runtime Contract with Adapter Plugins v1 — Tasks

## Recommended implementation order

1. **Contracts first:** Define all runtime types, schemas, capabilities, and error codes before writing runtime logic or adapters.
2. **Registry and selection:** Build the in-memory adapter registry and selection service with unit tests before wiring adapters.
3. **DB schema:** Add migration and `WorkspaceStore` methods before building the session service.
4. **Session service:** Build the session lifecycle service on top of registry + DB.
5. **Adapters:** Implement `or3-sandbox` first (most complete existing infrastructure), then `remote-node-agent`, then `local-container`.
6. **API routes:** Wire routes last, after the service layer is tested.
7. **Host-staging handoff:** Only after the generic runtime substrate is stable, extend it for host-owned workspace staging as described in `planning/runtime-host-implementation-order.md`.
8. **Cross-link:** Update desktop and main planning docs after the contract is stable.

### Scope guard for this task list

This task list owns the reusable runtime substrate only.

- It defines generic runtime contracts, session lifecycle, persistence, adapters, and runtime APIs.
- It does **not** own host workspace root resolution, base manifest capture, stale-write conflict checks, explicit host commit/discard flows, or single-writer coordination for host-backed staged sessions.
- `workspace-materialize` in this plan must stay compatible with the smaller host-owned staging model from `planning/host-workspace-staging/` and must not grow into a distributed workspace store.

---

## Phase 1: Runtime contracts

### 1. Core capability types (`src/contracts/runtime/capabilities.ts`) [Req 3]

- [x] Define `runtimeCoreCapabilityValues` const array with all core capabilities: `exec`, `stop`, `resume`, `copy-in`, `copy-out`, `file-browse`, `file-rw`, `workspace-materialize`, `log-stream`, `service-expose`, `snapshot`, `artifact-push`, `internet`, `public-ingress`, `persistent-session`, `browser`, `package-install`, `secret-inject`, `workspace-write`.
- [x] Document `workspace-materialize` in this phase as a generic staged-workspace capability only; defer host-root resolution and commit semantics to `planning/host-workspace-staging/tasks.md`.
- [x] Define `runtimeCapabilitySchema` that accepts core capabilities or `ext:<adapter>:<name>` extensions.
- [x] Export `RuntimeCapability` type and `RuntimeCapabilitySet` (array with `.includes()` check helper).

### 2. Adapter manifest schema (`src/contracts/runtime/manifest.ts`) [Req 1]

- [x] Define `runtimeAdapterKindValues` const array: `sandbox`, `remote`, `local`, `fly`, `cloudflare`, `ssh-vm`, `akash`.
- [x] Define `runtimeTrustTierValues`: `production`, `staging`, `development`, `untrusted`.
- [x] Define `runtimeLocalityValues`: `local`, `remote`, `hybrid`.
- [x] Define `runtimeSessionModeValues`: `ephemeral`, `persistent`.
- [x] Define `runtimeAdapterManifestSchema` with Zod: `adapter_id`, `display_name`, `version`, `adapter_kind`, `isolation_class`, `trust_tier`, `locality`, `capabilities`, `supported_presets`, `session_modes`.
- [x] Export `RuntimeAdapterManifest` type.

### 3. Descriptor schemas (`src/contracts/runtime/descriptors.ts`) [Req 4]

- [x] Define `runtimeDescriptorSchema`: `adapter_id`, `display_name`, `isolation_class`, `trust_tier`, `locality`, `health`, `capabilities`, `supported_presets`, `session_modes`.
- [x] Define `runtimeNodeDescriptorSchema`: `node_id`, `runtime_id`, `health`, `capabilities`, `resource_limits`, `locality`.
- [x] Define `runtimeSessionDescriptorSchema`: `session_id`, `workspace_id`, `adapter_id`, `node_id`, `status`, `capabilities`, `isolation_class`, `trust_tier`, `preset_id`, `created_at`, `updated_at`, `destroyed_at`, `error`.
- [x] Export `RuntimeDescriptor`, `RuntimeNodeDescriptor`, `RuntimeSessionDescriptor` types.

### 4. Execution types (`src/contracts/runtime/execution.ts`) [Req 6]

- [x] Define `runtimeExecutionRequestSchema`: `command`, `args`, `cwd`, `env`, `timeout_ms`, `stdin`, `background`.
- [x] Define `RuntimeExecutionEvent` union type: `stdout`, `stderr`, `exit`.
- [x] Define `RuntimeExecutionResult`: `exit_code`, `stdout`, `stderr`, `artifacts`, `meta`.
- [x] Define `RuntimeExecutionHandle` interface: `execution_id`, `stream?`, `result`, `abort()`.

### 5. Session input types (`src/contracts/runtime/sessions.ts`) [Req 5]

- [x] Define `runtimeSessionCreateInputSchema`: `preset_id`, `required_capabilities`, `workspace_ref`, `workspace_mode`, `network_policy`, `resource_hints`, `persistence_mode`, `env_refs`, `secret_refs`, `timeout_rules`, `artifact_rules`.
- [x] Keep workspace-related fields generic in this phase; do not embed host-root resolution, selected-path manifests, or explicit host commit rules here until the host-staging layer is added.
- [x] Define `runtimeSessionStateValues`: `creating`, `ready`, `stopping`, `stopped`, `destroying`, `destroyed`, `failed`.

### 6. Artifact descriptor (`src/contracts/runtime/artifacts.ts`) [Req 8]

- [x] Define `runtimeArtifactDescriptorSchema`: `artifact_id`, `session_id`, `path`, `kind`, `content_type`, `size_bytes`, `source`.
- [x] Export `RuntimeArtifactDescriptor` type.

### 7. Error envelope (`src/contracts/runtime/errors.ts`) [Req 7]

- [x] Define `runtimeErrorCodeValues` const array: `unsupported_capability`, `policy_denied`, `adapter_unavailable`, `session_not_found`, `session_destroyed`, `exec_failed`, `exec_timeout`, `copy_failed`, `log_unavailable`, `adapter_internal`.
- [x] Define `runtimeErrorEnvelopeSchema`: `code`, `message`, `retriable`, `details`, `retry_after_ms`.
- [x] Define `RuntimeError` class extending `Error` with code, retriable, details.
- [x] Add mapping function `runtimeErrorToApiEnvelope()` that converts `RuntimeError` to platform `ErrorEnvelope`.

### 8. Adapter interface (`src/contracts/runtime/adapter.ts`) [Req 2]

- [x] Define `RuntimeAdapter` interface with required and optional methods as specified in design.
- [x] Define `RuntimeAdapterHealth` type: `status`, `message`, `checked_at`.
- [x] Define `RuntimeAdapterSessionHandle` type: `ref`, `adapter_id`, `status`.
- [x] Define input/output types for `copyIn`, `copyOut`, `getLogs`, `fileBrowse`, `fileRead`, `fileWrite`, `materializeWorkspace`, `exposeService`, `snapshot`, `pushArtifact`.
- [x] Keep `materializeWorkspace` substrate-oriented in this phase; host-side manifests, conflict detection, and commit application belong to the host-staging plan.

### 9. Platform error code additions (`src/contracts/platform/error-codes.ts`) [Req 7]

- [x] Add runtime error codes to `platformErrorCodes` const map: `runtimeUnsupportedCapability`, `runtimePolicyDenied`, `runtimeAdapterUnavailable`, `runtimeSessionNotFound`, `runtimeExecFailed`, `runtimeExecTimeout`.

### 10. Barrel export (`src/contracts/runtime/index.ts`)

- [x] Create barrel export for all runtime contract modules.
- [x] Add runtime contracts to `src/contracts/index.ts` barrel.

### 11. Contract test fixtures (`tests/contracts/fixtures/`) [Req 1-8]

- [x] Create `runtime-adapter-manifest.json` fixture with a valid manifest.
- [x] Create `runtime-descriptor.json` fixture.
- [x] Create `runtime-session-descriptor.json` fixture.
- [x] Create `runtime-execution-request.json` fixture.
- [x] Create `runtime-error-envelope.json` fixtures for each error code.
- [x] Create `runtime-artifact-descriptor.json` fixture.

### 12. Contract tests (`tests/contracts/runtime/`) [Req 1-8]

- [x] Write `runtime-manifest.contract.test.ts` validating manifest fixtures and rejection of invalid manifests.
- [x] Write `runtime-descriptors.contract.test.ts` validating descriptor fixtures.
- [x] Write `runtime-errors.contract.test.ts` validating error envelope fixtures and API envelope mapping.
- [x] Write `runtime-capabilities.contract.test.ts` validating capability union and extension namespace.
- [x] Write `runtime-sessions.contract.test.ts` validating session create input and state value fixtures.

---

## Phase 2: Registry and selection

### 13. Runtime registry (`src/runtime/registry.ts`) [Req 1]

- [ ] Implement `RuntimeRegistry` class with `register()`, `get()`, `list()`, `health()`.
- [ ] `register()` validates manifest via Zod, rejects duplicate `adapter_id`.
- [ ] `health()` calls `adapter.health()` for each registered adapter and returns aggregated map.

### 14. Runtime selection service (`src/runtime/selection.ts`) [Req 3, 4]

- [ ] Implement `RuntimeSelectionService` class with `select(workspaceId, criteria)`.
- [ ] Filter adapters by: required capabilities, health, trust tier, isolation class, locality, preset eligibility.
- [ ] If multiple candidates, prefer: healthy > degraded, matching isolation > any, local > remote.
- [ ] Return selected adapter and optional node descriptor.
- [ ] Throw `RuntimeError("policy_denied")` if no adapter matches.

### 15. Registry and selection tests (`tests/runtime/`) [Req 1, 3]

- [ ] Test registry rejects duplicate adapter IDs.
- [ ] Test registry rejects invalid manifests.
- [ ] Test registry health aggregation.
- [ ] Test selection by capability match.
- [ ] Test selection excludes degraded adapters.
- [ ] Test selection by trust tier, isolation class, locality, and preset.
- [ ] Test selection throws policy_denied when no match.

---

## Phase 3: Database schema and persistence

### 16. Schema migration (`src/db/schema.ts`) [Req 13, 14]

- [ ] Add migration version 6 `"runtime-sessions-and-artifacts"` with:
  - `CREATE TABLE runtime_sessions (...)` with workspace-scoped composite PK.
  - `CREATE TABLE runtime_session_events (...)` with workspace-scoped composite PK.
  - `CREATE TABLE runtime_artifacts (...)` with workspace-scoped composite PK.
  - Required indexes per design.
- [ ] Add `RuntimeSessionRow`, `RuntimeSessionEventRow`, `RuntimeArtifactRow` interfaces.
- [ ] Add `StoredRuntimeSession`, `StoredRuntimeSessionEvent`, `StoredRuntimeArtifact` interfaces.

### 17. WorkspaceStore runtime methods (`src/db/client.ts`) [Req 13]

- [ ] Add `saveRuntimeSession(input)` method.
- [ ] Add `getRuntimeSession(sessionId)` method.
- [ ] Add `listRuntimeSessions(filter?)` method with status filter and pagination.
- [ ] Add `touchRuntimeSession(sessionId, updates)` method.
- [ ] Add `appendRuntimeSessionEvent(input)` method with monotonic sequence.
- [ ] Add `listRuntimeSessionEvents(sessionId, limit?)` method.
- [ ] Add `saveRuntimeArtifact(input)` method.
- [ ] Add `listRuntimeArtifacts(sessionId)` method.

### 18. Persistence tests (`tests/db/`) [Req 13]

- [ ] Test runtime session CRUD round-trip.
- [ ] Test runtime session event append and sequence monotonicity.
- [ ] Test runtime artifact save/list per session.
- [ ] Test migration applies cleanly on fresh DB and after existing migrations.
- [ ] Test no FK relationships to existing node/job/network_session tables.

---

## Phase 4: Runtime session service

### 19. Runtime session service (`src/runtime/sessions.ts`) [Req 5, 6, 7]

- [ ] Implement `RuntimeSessionService` class.
- [ ] `createSession(workspaceId, input)`:
  - Call `RuntimeSelectionService.select()`.
  - Validate required capabilities against adapter manifest.
  - Insert `runtime_sessions` row with `status=creating`.
  - Call `adapter.createSession()`.
  - Update row to `status=ready` on success, `status=failed` on error.
  - Append session events.
  - Return `RuntimeSessionDescriptor`.
- [ ] `getSession(workspaceId, sessionId)`: DB lookup + descriptor construction.
- [ ] `listSessions(workspaceId, filter?)`: DB query with status/adapter filter.
- [ ] `exec(workspaceId, sessionId, input)`:
  - Look up session, verify `status=ready`.
  - Verify exec capability.
  - Delegate to `adapter.exec()`.
  - Append exec event.
  - Return `RuntimeExecutionHandle`.
- [ ] `stopSession(workspaceId, sessionId)`:
  - Verify adapter has `stop` capability.
  - Call `adapter.stop()`.
  - Update status to `stopped`.
- [ ] `destroySession(workspaceId, sessionId)`:
  - Call `adapter.destroySession()` (catch errors).
  - Always update status to `destroyed`.
  - Append event with optional `cleanup_error`.
- [ ] `getLogs(workspaceId, sessionId, input)`: delegate to adapter.
- [ ] `copyIn(workspaceId, sessionId, input)`: verify capability, delegate.
- [ ] `copyOut(workspaceId, sessionId, input)`: verify capability, delegate.
- [ ] Do not implement host workspace prepare / commit / discard flows in this phase; those are follow-on tasks under `planning/host-workspace-staging/tasks.md`.

### 20. Restart reconciliation (`src/runtime/sessions.ts`) [Req 13]

- [ ] Add `reconcileOnStartup()` method.
- [ ] Query non-terminal sessions (`creating`, `ready`, `stopping`).
- [ ] For each, probe adapter health and adapter-side session status.
- [ ] Mark recovered, destroyed, or failed as appropriate.
- [ ] Append reconciliation events.

### 21. Session service tests (`tests/runtime/`) [Req 5, 6, 7, 13]

- [ ] Test create session happy path through mock adapter.
- [ ] Test create session failure marks DB as failed.
- [ ] Test exec on non-ready session is rejected.
- [ ] Test exec on session without exec capability is rejected.
- [ ] Test unsupported capability returns `unsupported_capability` error.
- [ ] Test destroy always persists even when adapter throws.
- [ ] Test restart reconciliation marks orphaned sessions.
- [ ] Test session listing with status filter.

---

## Phase 5: Adapter implementations

### 22. `or3-sandbox` adapter (`src/runtime/adapters/sandbox.ts`) [Req 10]

- [ ] Implement `SandboxRuntimeAdapter` implementing `RuntimeAdapter`.
- [ ] Build manifest with capabilities: `exec`, `stop`, `copy-in`, `copy-out`, `file-browse`, `file-rw`, `log-stream`, `service-expose`, `workspace-write`.
- [ ] `createSession()` → `WarmPoolManager.acquire()`, return sandbox ID as ref.
- [ ] `exec()` → `SandboxClient.execStream()`, wrap as `RuntimeExecutionHandle`.
- [ ] `copyIn()` → `SandboxClient.writeFile()`.
- [ ] `copyOut()` → `SandboxClient.readFile()`.
- [ ] `getLogs()` → `SandboxClient.exec(["cat", ...])`.
- [ ] `stop()` → `SandboxClient.stop()`.
- [ ] `destroySession()` → `SandboxClient.delete()`.
- [ ] `health()` → `SandboxClient.runtimeHealth()`.
- [ ] `listNodes()` → single virtual node from `SandboxClient.runtimeInfo()`.
- [ ] Map `SandboxRequestError` to `RuntimeError`.
- [ ] Keep sandbox workspace support limited to generic transfer/materialization substrate in this phase; explicit host staging prepare/commit flows are handled later by `host-workspace-staging`.

### 23. `or3-sandbox` parity tests (`tests/runtime/adapters/`) [Req 10]

- [ ] Test exec produces equivalent results to direct `SandboxNodeAdapter.executeTask()`.
- [ ] Test file operations produce equivalent results to direct `SandboxClient` calls.
- [ ] Test health produces equivalent results to direct `SandboxClient.runtimeHealth()`.
- [ ] Test error mapping from `SandboxRequestError` to `RuntimeError`.

### 24. `remote-node-agent` adapter (`src/runtime/adapters/remote-node.ts`) [Req 11]

- [ ] Implement `RemoteNodeRuntimeAdapter` implementing `RuntimeAdapter`.
- [ ] Build manifest with capabilities: `exec` (others derived from node manifests).
- [ ] `listNodes()` → `NodeRegistryService.listNodes()` filtered to `adapter_kind: 'remote'`, `status: 'approved'`.
- [ ] `createSession()` → `LeaseScheduler.issueLease()`, return lease ID + node ID as ref.
- [ ] `exec()` → `RemoteNodeExecutor.startExecution()`, wrap `NodeExecutionHandle` as `RuntimeExecutionHandle`.
- [ ] `destroySession()` → `LeaseScheduler.releaseLease()`.
- [ ] `health()` → `RemoteNodeExecutor.heartbeat()` for a representative node.
- [ ] Map `RemoteExecutionError` to `RuntimeError`.

### 25. `remote-node-agent` parity tests (`tests/runtime/adapters/`) [Req 11]

- [ ] Test exec produces equivalent results to direct `RemoteNodeExecutor.executeTask()`.
- [ ] Test health delegates to heartbeat correctly.
- [ ] Test error mapping from `RemoteExecutionError` to `RuntimeError`.
- [ ] Test node listing filters correctly.

### 26. `local-container` adapter (`src/runtime/adapters/local-container.ts`) [Req 12]

- [ ] Implement `LocalContainerRuntimeAdapter` implementing `RuntimeAdapter`.
- [ ] Build manifest with capabilities: `exec`, `stop`, `copy-in`, `copy-out`, `file-rw`, `workspace-write`, trust tier `development`, isolation class `container`.
- [ ] `health()` → `Bun.spawn(["docker", "info"])`, return unavailable on failure.
- [ ] `createSession()` → `docker create` + `docker start`, return container ID as ref.
- [ ] `exec()` → `docker exec`, capture stdout/stderr, enforce timeout with `AbortSignal.timeout()`.
- [ ] `stop()` → `docker stop`.
- [ ] `copyIn()` → `docker cp`.
- [ ] `copyOut()` → `docker cp`.
- [ ] `destroySession()` → `docker rm -f`.
- [ ] `listNodes()` → single virtual node representing local Docker daemon.

### 27. `local-container` tests (`tests/runtime/adapters/`) [Req 12]

- [ ] Test health succeeds when Docker daemon mock is available.
- [ ] Test health returns unavailable when Docker daemon mock fails.
- [ ] Test session create/exec/destroy lifecycle.
- [ ] Test exec timeout enforcement.
- [ ] Test copy-in/copy-out.
- [ ] Test adapter_unavailable error when daemon unreachable during session create.

---

## Phase 6: API routes

### 28. Route wiring (`src/api/app.ts`) [Req 9]

- [ ] Add route patterns for all 11 runtime routes.
- [ ] Add `RuntimeSessionService` and `RuntimeRegistry` to `AppServices` interface.
- [ ] Wire route matching in `fetch()` method.

### 29. Runtime catalog handlers [Req 9, 4]

- [ ] `handleListRuntimes(request, workspaceId)`:
  - Auth + scope `runtimes:read`.
  - Return `RuntimeDescriptor[]` from registry.
- [ ] `handleGetRuntime(request, workspaceId, runtimeId)`:
  - Auth + scope `runtimes:read`.
  - Return `RuntimeDescriptor` or 404.
- [ ] `handleListRuntimeNodes(request, workspaceId, runtimeId)`:
  - Auth + scope `runtimes:read`.
  - Delegate to adapter `listNodes()`.

### 30. Runtime session handlers [Req 9, 5, 6]

- [ ] `handleCreateRuntimeSession(request, workspaceId)`:
  - Auth + scope `runtime-sessions:write`.
  - Parse body as `RuntimeSessionCreateInput`.
  - Delegate to `RuntimeSessionService.createSession()`.
  - Return 201 with `RuntimeSessionDescriptor`.
- [ ] `handleListRuntimeSessions(request, workspaceId)`:
  - Auth + scope `runtime-sessions:read`.
  - Delegate to `RuntimeSessionService.listSessions()`.
- [ ] `handleGetRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:read`.
  - Delegate to `RuntimeSessionService.getSession()`.
- [ ] `handleExecInRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:write`.
  - Parse body as `RuntimeExecutionRequest`.
  - Delegate to `RuntimeSessionService.exec()`.
  - Return result or SSE stream.
- [ ] `handleStopRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:write`.
  - Delegate to `RuntimeSessionService.stopSession()`.
- [ ] `handleDestroyRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:write`.
  - Delegate to `RuntimeSessionService.destroySession()`.
- [ ] `handleGetRuntimeSessionLogs(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:read`.
  - Delegate to `RuntimeSessionService.getLogs()`.
- [ ] `handleCopyInRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:write`.
  - Delegate to `RuntimeSessionService.copyIn()`.
- [ ] `handleCopyOutRuntimeSession(request, workspaceId, sessionId)`:
  - Auth + scope `runtime-sessions:read`.
  - Delegate to `RuntimeSessionService.copyOut()`.

### 31. API route tests (`tests/api/`) [Req 9, 14]

- [ ] Test all runtime routes require authentication.
- [ ] Test scope enforcement: `runtimes:read` for catalog, `runtime-sessions:write` for mutations.
- [ ] Test 404 for nonexistent runtime ID and session ID.
- [ ] Test `unsupported_capability` error response format.
- [ ] Test coexistence: existing `/v1/workspaces/:wsId/sessions` routes still work.
- [ ] Test coexistence: existing `/v1/workspaces/:wsId/nodes` routes still work.
- [ ] Test coexistence: existing `/v1/workspaces/:wsId/jobs` routes still work.

---

## Phase 7: Integration and startup wiring

### 32. Server startup wiring (`src/server.ts` or entrypoint) [Req 1, 10, 11, 12]

- [ ] Instantiate `RuntimeRegistry`.
- [ ] Register `SandboxRuntimeAdapter` if `SandboxClient` is configured.
- [ ] Register `RemoteNodeRuntimeAdapter` if `NodeRegistryService` and `LeaseScheduler` are available.
- [ ] Register `LocalContainerRuntimeAdapter` (always register, health-gate at selection time).
- [ ] Instantiate `RuntimeSelectionService(registry)`.
- [ ] Instantiate `RuntimeSessionService(registry, selection, database)`.
- [ ] Call `RuntimeSessionService.reconcileOnStartup()`.
- [ ] Pass services to `Or3NetApp`.

### 33. Integration tests [Req 10, 11, 12, 13]

- [ ] Test full create → exec → destroy lifecycle with sandbox adapter mock.
- [ ] Test full create → exec → destroy lifecycle with remote-node adapter mock.
- [ ] Test full create → exec → destroy lifecycle with local-container adapter mock.
- [ ] Test restart reconciliation marks sessions correctly after simulated restart.
- [ ] Test scheduler selection picks correct adapter for given criteria.

---

## Phase 8: Cross-linking and documentation

### 34. Cross-link desktop planning [Req 4, 9]

- [ ] Update `planning/desktop/tasks.md` task 3 (Host API and registry groundwork) to reference `planning/runtime-contract/` for runtime-provider and service-app contract shapes.
- [ ] Update `planning/desktop/design.md` provider rendering flow to reference the runtime contract's `RuntimeDescriptor` and `RuntimeNodeDescriptor` types.
- [ ] Update `planning/desktop/requirements.md` Req 5 notes to reference the runtime contract as the implementation plan for the runtime-provider registry.

### 35. Cross-link main planning

- [ ] Update `planning/main/design.md` to note that the runtime adapter contract wraps the existing node protocol layer.
- [ ] Update `planning/main/tasks.md` if applicable to note runtime contract as a parallel track.

### 36. Cross-link platform-standardization

- [ ] Update `planning/platform-standardization/tasks.md` to note that runtime error codes extend the platform error code registry.

### 37. README and doc updates

- [ ] Update `README.md` to mention the runtime adapter contract in the architecture overview.
- [ ] Add `src/contracts/runtime/README.md` documenting the runtime contract and adapter plugin model.
- [ ] Add `src/runtime/README.md` documenting the runtime services and adapter registration.

---

## Out of scope

- [ ] Do not implement `fly`, `cloudflare`, `ssh-vm`, or `akash` adapters in v1.
- [ ] Do not migrate `LocalJobService` or `or3-intern` to the runtime contract in v1.
- [ ] Do not add dynamic adapter package discovery or installation.
- [ ] Do not merge runtime session APIs with existing `/sessions` routes or `network_sessions` tables.
- [ ] Do not add runtime-specific rate limiting in v1 (use existing API rate limiting).
- [ ] Do not add runtime billing, metering, or quota tracking in v1.
