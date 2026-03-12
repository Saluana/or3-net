# Overview

This plan turns the current `or3-net` findings into one small stabilization wave focused on making remote execution truthful, keeping control-plane state repairable, and freezing the contracts that matter to upstream and downstream clients.

Scope assumptions:

- `or3-net` remains the Bun/SQLite control plane.
- Remote execution continues to flow through the existing scheduler, lease store, job stream, and node transport layers.
- Operator work stays in the current API, CLI, and built-in console rather than adding a new frontend or service.

# Requirements

## 1. Truthful remote job lifecycle

`or3-net` must persist one truthful lifecycle for every local or remote job.

Acceptance criteria:

- Remote abort calls the active backend abort path before the job is finalized as aborted.
- Once a job reaches a terminal state, later success or failure events are ignored and never overwrite the stored terminal result.
- Lease release happens on all remote terminal paths: success, failure, abort, and startup timeout.
- A second job can be scheduled onto the same node immediately after the first remote job reaches a terminal state.

## 2. Repairable scheduler and lease state

The control plane must recover cleanly after process restart or transport loss without leaving ghost capacity behind.

Acceptance criteria:

- Restart reconciliation finds and repairs stuck active leases that no longer have a live job.
- Reconciliation marks orphaned remote executions terminal or releases their lease conservatively.
- Scheduler capacity calculations count only leases that are still active after reconciliation.
- Recovery is covered by automated tests using the current SQLite-backed state model.

## 3. Stable remote execution protocol

Remote nodes must be first-class execution backends with one small stable protocol.

Acceptance criteria:

- The transport contract covers execute, stream, abort, heartbeat, terminal result, and capability advertisement.
- HTTPS and WSS transports both use issued node credentials instead of relying on approval state alone.
- Managed-mode scheduling respects runtime certification posture in addition to approval, health, and capability checks.
- Transport failures surface as stable host-side job errors rather than hanging jobs.

## 4. Frozen sandbox contract

`or3-net` must stop drifting from the real `or3-sandbox` daemon contract.

Acceptance criteria:

- The sandbox client surface used by `or3-net` matches the current `sandboxd` HTTP and streaming behavior for exec, files, tunnels, lifecycle, and runtime inspection.
- Contract tests fail when the local SDK shape diverges from the documented sandbox API.
- Contract coverage stays limited to endpoints `or3-net` actually depends on today.
- Version compatibility expectations are documented in the plan and enforced in CI.

## 5. Predictable public/operator surfaces

Public API and operator paths must be safe to retry, safe to misuse, and safe to inspect.

Acceptance criteria:

- Malformed request bodies return stable `4xx` validation errors without raw parser output.
- Sensitive launch or submit flows support idempotent retry behavior where duplication is likely.
- Minimal operator surfaces exist for job listing, node inspection, preview inspection, and access revocation.
- Preview or service launch capability state is bounded and pruned on resolve, revoke, and expiry.

# Non-functional constraints

- Keep SQLite as the single-process source of truth for jobs, leases, node approval, and operator state.
- Do not introduce a new broker, queue, or distributed scheduler.
- Preserve existing job stream shapes unless an additive compatibility layer is impossible.
- Keep memory growth bounded for preview/service capability tracking and remote run tracking.
- Authentication and authorization failures must return stable envelopes without leaking internal error text.
