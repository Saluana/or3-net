# Host-Owned Workspace Staging — Tasks

## Dependency and scope note

This task list starts **after** the reusable runtime substrate from `planning/runtime-contract/tasks.md` is in place.

- It extends runtime sessions with host-owned staging behavior.
- It does **not** redefine the generic runtime contract, registry, adapter lifecycle, or runtime catalog APIs.
- It owns host-specific semantics only: canonical host root resolution, selected-path manifests, conflict-safe commit, discard, and host-backed write coordination.

## 1. Cross-project planning alignment

- [x] [Req 1-9] Project: `or3-net` — add a short cross-link from `planning/runtime-contract/requirements.md` and `planning/runtime-contract/design.md` to this plan as the smaller host-owned workspace option.
- [x] [Req 1-9] Project: `or3-net` — update `planning/runtime-contract/tasks.md` so `workspace-materialize` work is explicitly scoped to host staging and explicit commit, not a distributed workspace store.
- [x] [Req 1, 3, 4, 7] Project: `or3-net` — update `planning/main/04-host-api.md` and `planning/main/03-security-model.md` to describe host-owned staging, explicit commit, and sandbox import/export boundaries.

## 2. `or3-net` host-staging contract extension work

- [ ] [Req 2, 3, 4, 5] Project: `or3-net` — after `runtime-contract` Phase 1-4 is complete, extend the runtime session contract in `src/contracts/runtime/` with the host-staging-specific fields needed by this plan:
  - `workspace_stage`
  - `workspace_stage_mode`
  - `workspace_stage_transport`
  - `WorkspaceCommitResult`
- [ ] [Req 2, 5, 9] Project: `or3-net` — extend `runtime_sessions` persistence with the host-staging metadata this plan needs (`host_workspace_root`, `workspace_stage_mode`, `staging_status`, or a documented hybrid with `config_json`) without reopening the generic runtime-session schema design.
- [ ] [Req 4, 5, 9] Project: `or3-net` — add host-staging-specific normalized error codes on top of the runtime error model for:
  - stale host write conflict
  - unsupported staging transport
  - workspace root missing
  - read-only commit denied

## 3. `or3-net` implementation work

- [ ] [Req 1] Project: `or3-net` — add host workspace resolution to workspace config handling so a workspace can opt into a canonical host root without accepting arbitrary client-provided host paths.
- [ ] [Req 2, 3, 4, 9] Project: `or3-net` — add a staging helper module such as `src/runtime/workspace-stage.ts` that:
  - scans selected host paths
  - writes base manifests under `.data/workspace-stage/<session-id>/`
  - reconstructs exported trees into temp storage
  - computes host vs base vs sandbox diffs
  - applies safe write/delete plans to the host root
- [ ] [Req 5, 9] Project: `or3-net` — add durable single-writer coordination for read-write staged sessions using runtime session persistence rather than in-memory locks.
- [ ] [Req 2, 3, 4] Project: `or3-net` — implement session preparation flow in the runtime session service:
  - resolve host root
  - enforce read-only/read-write coordination
  - capture base manifest
  - stage selected paths into the runtime
- [ ] [Req 4, 5, 9] Project: `or3-net` — implement explicit commit flow in the runtime session service:
  - export sandbox files
  - detect host drift
  - reject stale writes
  - apply safe host updates
  - release write coordination on success or terminal failure
- [ ] [Req 2, 4, 6] Project: `or3-net` — extend the runtime-session API in `src/api/app.ts` with explicit staged-session operations only after the generic runtime-session routes already exist:
  - prepare/create staged session
  - commit session changes
  - discard staged session
  - inspect staged status or changed paths summary
- [ ] [Req 6] Project: `or3-net` — keep artifact persistence and preview flows separate from commit logic; update `runtime_artifacts` planning and API responses only where session summaries need commit metadata.

## 4. `or3-net` sandbox substrate integration work

- [ ] [Req 3, 7] Project: `or3-net` — extend `sdk/sandbox/types.ts` and `sdk/sandbox/client.ts` with archive import/export methods if `or3-sandbox` adds bulk endpoints; do not re-specify the generic sandbox runtime adapter lifecycle here.
- [ ] [Req 3, 7] Project: `or3-net` — keep existing `readFile`, `writeFile`, `deleteFile`, and `mkdir` flows as a bounded fallback path for small transfers.
- [ ] [Req 2, 3, 7] Project: `or3-net` — extend the existing sandbox runtime adapter so host workspace staging chooses:
  - archive transfer when available
  - file API fallback when bulk transfer is unavailable or too small to justify archive packaging

## 5. `or3-sandbox` API and service work

- [ ] [Req 3, 7] Project: `or3-sandbox` — decide whether to add explicit bulk endpoints:
  - `POST /v1/sandboxes/{id}/workspace-import`
  - `POST /v1/sandboxes/{id}/workspace-export`
- [ ] [Req 3, 7] Project: `or3-sandbox` — if bulk endpoints are added, implement archive extraction and export inside the existing workspace root only, with traversal, symlink, and size checks.
- [ ] [Req 7] Project: `or3-sandbox` — keep the existing file APIs unchanged and documented as the fallback compatibility surface.
- [ ] [Req 7] Project: `or3-sandbox` — document archive import/export limits and safety rules in `docs/api-reference.md`.
- [ ] [Req 7] Project: `or3-sandbox` — add service/API tests for archive round-trips, traversal rejection, symlink escape rejection, and oversized payload rejection.

## 6. `or3-intern` compatibility work

- [ ] [Req 8] Project: `or3-intern` — confirm in `planning/or3-net-plan.md` or service API docs that host-workspace staging remains outside `or3-intern` ownership.
- [ ] [Req 8] Project: `or3-intern` — only if runtime metadata passed to `or3-intern` changes, add a small service contract regression test proving the current turn API remains backward-compatible.

## 7. Testing

- [ ] [Req 1, 2, 3, 4] Project: `or3-net` — add unit tests for host root normalization, selected-path manifest capture, archive/file fallback selection, and commit diff classification.
- [ ] [Req 4, 5, 9] Project: `or3-net` — add regression tests for stale host writes, read-only commit rejection, partial commit failure handling, and restart reconciliation releasing stale writer state.
- [ ] [Req 3, 7] Project: `or3-net` — add host-staging integration tests with fake sandbox client coverage for:
  - archive prepare/commit
  - file API fallback prepare/commit
  - unavailable bulk transport -> fallback or normalized error
- [ ] [Req 7] Project: `or3-sandbox` — add endpoint-level tests for bulk import/export if those endpoints are adopted.
- [ ] [Req 8] Project: `or3-intern` — add or update service contract tests only if metadata changes cross the boundary.

## 8. Documentation and rollout

- [ ] [Req 1-9] Project: `or3-net` — document the v1 mental model clearly:
  - host workspace is canonical
  - runtime sessions stage selected files
  - commit is explicit
  - artifacts remain separate
- [ ] [Req 3, 7] Project: `or3-sandbox` — document that sandbox workspace files are staged runtime state, not the canonical host workspace.
- [ ] [Req 1-9] Project: `or3-net` — record explicit deferrals in this plan and related runtime docs so follow-on work does not silently expand into a distributed workspace store.

## 9. Out of scope

- [ ] [Req 5] Project: `or3-net` — do not build multi-writer merge workflows in v1.
- [ ] [Req 3, 7] Project: `or3-sandbox` — do not expose arbitrary host-path bind mounts through the public sandbox API in v1.
- [ ] [Req 1, 4] Project: `or3-net` — do not introduce a separate canonical blob store or background sync engine in v1.
- [ ] [Req 8] Project: `or3-intern` — do not move host staging or commit ownership into `or3-intern`.
