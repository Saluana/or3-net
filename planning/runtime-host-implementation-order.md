# Runtime Contract + Host Workspace Staging — Implementation Order

## Recommendation

Implement `runtime-contract` first, then implement `host-workspace-staging` on top of it.

This keeps the first phase focused on the reusable execution substrate:

- typed runtime contracts
- adapter registration and selection
- runtime session persistence
- runtime session lifecycle service
- sandbox adapter integration
- runtime session API routes

Then `host-workspace-staging` becomes the first concrete workspace-transfer workflow built on that substrate rather than a parallel system.

---

## Why this order is smaller and safer

`host-workspace-staging` depends on runtime-session concepts that already belong in `runtime-contract`:

- runtime session creation and destruction
- capability gating
- copy-in / copy-out primitives
- normalized runtime errors
- runtime session persistence and restart recovery
- adapter delegation to `or3-sandbox`
- workspace-scoped runtime APIs

If staging is implemented first, it will likely force early one-off definitions for session configuration, error handling, adapter behavior, and persistence. Those would then need to be reconciled back into the runtime contract later.

Implementing `runtime-contract` first avoids defining those surfaces twice.

---

## Required scoping decision

While implementing `runtime-contract`, treat `workspace-materialize` as the host-owned staging model from `host-workspace-staging`, not as a distributed workspace store.

In practice, that means:

- no background sync engine
- no multi-writer merge system
- no canonical runtime-owned workspace store
- no implicit full-workspace mirroring
- no bind-mount access to arbitrary host paths

`workspace-materialize` should mean:

- resolve a configured host workspace root
- stage selected paths into the runtime
- allow explicit read-only or read-write staging modes
- commit changes back only through explicit host-side validation

---

## Recommended implementation sequence

### Phase 1 — Runtime contracts and service foundation

Implement from `planning/runtime-contract/` first:

1. contracts in `src/contracts/runtime/`
2. runtime registry
3. runtime selection service
4. runtime DB tables and store methods
5. runtime session service
6. `or3-sandbox` adapter
7. runtime catalog and runtime-session API routes

This phase should establish all generic runtime primitives without committing to any broader workspace-sync model.

### Phase 2 — Narrow workspace support inside the runtime contract

Before adding host commit logic, narrow the runtime contract’s workspace-related surfaces so they align with host staging:

- `workspace_ref` / `workspace_mode` should not imply runtime ownership of canonical files
- `workspace-materialize` should be documented as explicit staged copy semantics
- copy-in / copy-out should remain the substrate for staging operations
- runtime error codes should include the host-staging failures needed later

At the end of this phase, the runtime contract should be capable of supporting staged workspaces without implying a larger distributed design.

### Phase 3 — Host workspace staging on top of runtime sessions

Then implement from `planning/host-workspace-staging/`:

1. host workspace root resolution
2. selected-path manifest capture
3. durable single-writer coordination for read-write staged sessions
4. session prepare flow for staged host paths
5. explicit commit flow with conflict detection
6. discard / reconcile behavior
7. archive transfer via `or3-sandbox` when available, file-API fallback otherwise

This phase should use the runtime session service and sandbox adapter that already exist rather than introducing a separate session system.

---

## Ownership boundaries

To avoid overlap, each plan should own a distinct layer.

### `runtime-contract` owns

- type system for runtimes, nodes, sessions, execution, artifacts, and errors
- runtime adapter interface and manifest registration
- runtime registry and selection logic
- generic runtime session lifecycle
- generic persistence for runtime sessions, events, and artifacts
- generic adapter capabilities such as `exec`, `copy-in`, `copy-out`, `logs`, `stop`, `destroy`
- runtime catalog and runtime-session API routes
- adapter wrappers for `or3-sandbox`, `remote-node-agent`, and `local-container`

### `host-workspace-staging` owns

- host workspace root resolution and normalization
- selected-path staging spec semantics
- base manifest capture and export reconstruction
- host-side conflict detection and stale-write rejection
- explicit commit / discard behavior
- read-only vs read-write coordination rules
- single-writer locking for host-backed staged sessions
- temporary staging directories and commit summaries

### `or3-sandbox` owns

- safe execution environment
- file transfer substrate
- optional archive import / export substrate
- traversal, symlink, and size protections for bulk transfer

### `or3-intern` does not own

- host workspace transport
- host manifest capture
- commit validation
- host write coordination

---

## Non-overlap rules

To keep the two tracks from colliding:

1. `runtime-contract` must not define a canonical workspace storage model.
2. `host-workspace-staging` must not redefine runtime session, adapter, or runtime catalog primitives.
3. Any new workspace-related runtime types must be generic enough to live in `runtime-contract`, but their host-root resolution and commit semantics must live in `host-workspace-staging`.
4. `copy-in`, `copy-out`, and optional archive transport belong to the runtime substrate; base manifests and host commit safety belong to staging.
5. API routes for runtime sessions belong to `runtime-contract`; explicit staged-session prepare / commit / discard flows belong to `host-workspace-staging`.

---

## Practical interpretation for current tasks

Use `planning/runtime-contract/tasks.md` as the primary execution plan first, but interpret its workspace-related items through the host-staging design:

- `workspace-materialize` means staged host copies
- session workspace fields should stay compatible with explicit host staging
- sandbox copy operations are enabling infrastructure, not a separate sync system

Use `planning/host-workspace-staging/tasks.md` only after the runtime session foundation is in place, and treat it as an extension of runtime sessions rather than a competing architecture.

---

## Final decision

Implement `runtime-contract` first.

But lock one design rule immediately: any workspace support added during that work must be compatible with the smaller host-owned staging model and must not expand into a distributed workspace-sync system.
