# Host-Owned Workspace Staging — Requirements

## Overview

This plan defines a smaller alternative to a full persistent workspace sync system.

The host machine remains the canonical owner of workspace files. Runtime sessions stage selected files into a sandbox or container, do work there, and explicitly sync approved changes back to the host when needed.

Scope:

- add host-workspace staging behavior to the runtime session model in `or3-net`
- reuse `or3-sandbox` for isolated execution and file transfer
- keep `or3-intern` out of host-workspace transport and storage ownership
- avoid introducing a distributed canonical workspace store, background sync engine, or multi-writer merge system in v1

Assumptions:

- `or3-net` remains the boundary owner for browser/CLI clients
- the host workspace root is explicit and configured per workspace, not inferred from arbitrary client input
- sandbox-backed sessions use staged copy semantics in v1
- direct bind-mount access to arbitrary host paths is not required for v1

---

## Requirements

### 1. Host workspace must remain the canonical source of truth

**Requirement:** The system must treat a configured host-side workspace root as the authoritative file store for a workspace.

**Acceptance criteria:**

- `or3-net` must resolve a single configured host workspace root for each workspace that enables host staging.
- Runtime sessions must not become the canonical owner of user project files.
- Session cleanup, runtime deletion, or sandbox failure must not delete the canonical host workspace.
- The host workspace root must be normalized and scoped so clients cannot redirect the workspace to arbitrary host paths at request time.

### 2. Runtime sessions must support explicit workspace staging

**Requirement:** The runtime session contract must support staging selected host files into a session with explicit access mode.

**Acceptance criteria:**

- Session creation must allow a host-workspace staging spec that declares:
  - selected paths
  - staging mode (`read_only` or `read_write`)
  - transport preference (`archive`, `file_api`, or `auto`)
- The runtime session must materialize only the selected paths, not an implicit full host mirror.
- Read-only sessions must not be allowed to commit workspace changes.
- Sessions that do not request host staging must continue to work without workspace behavior changes.

### 3. Stage-in and stage-out must use bounded, explicit transfer semantics

**Requirement:** File transfer into and out of isolated runtimes must use explicit staging operations rather than implicit live filesystem sharing.

**Acceptance criteria:**

- `or3-net` must be able to stage host files into a runtime session through a bulk archive path when available.
- `or3-net` must retain a small-transfer fallback using existing per-file APIs when bulk staging is unavailable or disabled.
- Staging operations must enforce path normalization, size limits, and workspace-root confinement.
- The system must not expose arbitrary host filesystem access inside remote or untrusted sandboxes.

### 4. Sync-back must reject stale or invalid commits

**Requirement:** A read-write staged session must only sync changes back when the host workspace has not changed incompatibly since staging began.

**Acceptance criteria:**

- `or3-net` must capture a base manifest for staged files when the session is prepared.
- Commit must compare sandbox output against both the base manifest and the current host state.
- If a host file changed since session start and the sandbox also changed that path, commit must fail with a normalized conflict or stale-write error.
- Commit must apply writes and deletes only within the selected workspace paths.
- Commit must extract or inspect sandbox output in a temporary location before applying changes to the host root.

### 5. Write coordination must stay simple and bounded

**Requirement:** The system must provide single-writer coordination for read-write staged sessions without implementing a general collaborative merge workflow.

**Acceptance criteria:**

- At most one active read-write staged session may target the same configured host workspace root at a time.
- Multiple read-only staged sessions may target the same host workspace concurrently.
- Coordination state must survive `or3-net` process restart.
- Lock or coordination cleanup must occur when sessions are destroyed or reconciled after restart.

### 6. Artifact handling must remain separate from workspace commit

**Requirement:** Session output files and user-facing artifacts must stay conceptually separate from host-workspace sync.

**Acceptance criteria:**

- Runtime sessions must continue to expose artifacts independently of host-workspace commit.
- A session must be able to produce artifacts without gaining read-write workspace commit rights.
- Files promoted back into the host workspace must go through the explicit commit path, not artifact side effects.
- Existing preview and service-launch flows must remain compatible with runtime artifacts and sandbox files.

### 7. `or3-sandbox` must provide safe substrate support for staged transfers

**Requirement:** `or3-sandbox` must support the transfer primitives needed for efficient host-workspace staging while preserving current isolation rules.

**Acceptance criteria:**

- Existing file APIs (`read`, `write`, `delete`, `mkdir`) must remain supported.
- `or3-sandbox` must expose a bulk import/export substrate suitable for workspace staging, or explicitly document and test the fallback to per-file transfer.
- Bulk transfer behavior must reject traversal, symlink escape, and oversized archive payloads.
- Snapshot behavior must remain separate from host-workspace commit semantics.

### 8. `or3-intern` must remain out of workspace transport ownership in v1

**Requirement:** `or3-intern` must not become the owner of host-workspace staging, transfer, or commit logic.

**Acceptance criteria:**

- The existing `or3-net -> or3-intern` turn submission contract must remain valid without new host-workspace payload ownership.
- Any workspace context sent to `or3-intern` must remain metadata only.
- Host staging, manifest capture, commit safety checks, and file transfer orchestration must stay in `or3-net` and runtime adapters.

### 9. Recovery behavior must preserve host safety and predictable cleanup

**Requirement:** The system must recover from `or3-net` or runtime crashes without corrupting the canonical host workspace.

**Acceptance criteria:**

- Base manifest state and session staging metadata must survive `or3-net` restart.
- A partially failed commit must not leave the host workspace in an unknown mixed state.
- Restart reconciliation must mark abandoned staged sessions as failed or recoverable and release any stale write coordination.
- Temporary extracted staging data must be cleaned up when it is no longer needed.

---

## Non-functional constraints

- Keep the design smaller than a general distributed workspace-sync system.
- Prefer archive transfer plus explicit commit over background sync or per-file watch loops.
- Keep SQLite state bounded; large manifests or exported trees must not be stored inline in SQLite blobs.
- Treat sandbox output as untrusted input until it passes host-side path and manifest validation.
- Preserve workspace isolation across workspaces and across runtime sessions.
- Keep existing job, preview, service-launch, and runtime-session flows backward-compatible where possible.
- Do not require `or3-chat` changes before `or3-net` and `or3-sandbox` contracts are stable.
