# Remote Execution Completion — Requirements

## Overview

This plan covers priorities 1–3 from the status report:

1. fix remote execution correctness
2. finish transport/auth policy enforcement
3. bring the sandbox SDK up to actual v1 scope

Scope is intentionally limited to the parts of `or3-net` that make remote node execution trustworthy:

- remote job lifecycle correctness
- lease correctness and scheduler capacity recovery
- node transport behavior and policy enforcement
- `sdk/sandbox` parity with the real `or3-sandbox` API for the flows `or3-net` depends on

Assumptions:

- `or3-net` remains a Bun/TypeScript control plane with SQLite persistence.
- `or3-intern` remains the execution authority for local turns and subagents.
- `or3-sandbox` remains the first concrete remote backend.
- Existing workspace isolation, token formats, and SQLite data must remain backward-compatible.

## Requirements

### 1. Remote job lifecycle must be truthful and cancellable

**Requirement:** As a client and operator, I need remote jobs to reflect the real upstream execution lifecycle so that `or3-net` never reports a false completion or false abort.

**Acceptance criteria:**

- When a job runs on a remote node, `or3-net` must maintain an active remote execution handle for that job until the job reaches a terminal state.
- When `POST /v1/jobs/:jobId/abort` is called for a remote job, `or3-net` must send an upstream cancel request and wait for a positive cancel outcome before finalizing the job as `aborted`.
- When a remote abort fails, the API must return a failure and the job must not be finalized as successfully aborted.
- When a remote job is aborted, no later `job.completed` terminal state may be persisted for that job.
- When a remote node disconnects or the transport fails mid-run, the job must end in one terminal failure state with a stable error code rather than hanging indefinitely.

### 2. Lease lifecycle must release capacity immediately

**Requirement:** As the scheduler, I need remote leases to leave the active set as soon as the upstream run completes, aborts, or fails so that node capacity is accurate.

**Acceptance criteria:**

- When a remote job reaches `completed`, `failed`, or `aborted`, its lease must be transitioned out of `active` in the same execution flow.
- A released or failed remote lease must stop counting toward capacity immediately; the scheduler must not wait for TTL expiry.
- Lease release must happen in a `finally`-style path so it still occurs when execution throws.
- A second eligible job must be schedulable immediately after the first remote job reaches a terminal state.

### 3. Transport auth and node policy must be enforced in the runnable path

**Requirement:** As an operator, I need approved-node credentials and node policy to be consumed at runtime so that a node is not considered usable merely because it exists in SQLite.

**Acceptance criteria:**

- When a node is approved, the issued short-lived credential must be used by the active remote transport for execution and abort requests.
- When managed-mode certification policy is enabled, nodes missing valid certification metadata must be excluded from scheduling.
- Scheduling must continue to require approval, health, capability, transport compatibility, and isolation-class compatibility.
- When no node satisfies runtime policy, `or3-net` must return a clear scheduling failure rather than falling back to an unsafe path.
- HTTPS and outbound-WSS transports must preserve the same remote execution semantics for execute, abort, and terminal result handling.

### 4. The sandbox SDK must match the real backend contract used by `or3-net`

**Requirement:** As the sandbox-backed adapter, I need `sdk/sandbox` to implement the real `or3-sandbox` wire contract for all flows `or3-net` uses now and in the near-term roadmap.

**Acceptance criteria:**

- Streaming exec must use the real `or3-sandbox` streaming activation mechanism and parse the actual event framing emitted by `sandboxd`.
- SDK request and response types for sandbox creation, exec, files, tunnels, snapshots, runtime info, quotas, and metrics must align with the current `or3-sandbox` API shapes used by `or3-net`.
- The SDK must include all methods needed for current `or3-net` adapter flows and the planned near-term service/preview flows; intentionally deferred endpoints must be explicitly documented.
- SDK tests must cover both JSON endpoints and streaming behavior against the expected wire contract.

### 5. Remote execution must provide normalized streaming behavior

**Requirement:** As a client of `or3-net`, I need local and remote jobs to produce a stable job-event lifecycle even when the upstream backend has different streaming capabilities.

**Acceptance criteria:**

- Remote execution paths must either surface streamed progress events or explicitly normalize the absence of streaming into a consistent `job.started` → terminal event lifecycle.
- Transport-specific frame shapes must be normalized before they reach the host job stream.
- Remote execution must publish one truthful terminal event only once.
- Transport disconnects and remote aborts must produce deterministic terminal job events and cleanup behavior.

## Non-functional constraints

- Keep memory bounded: active remote execution handles and transport correlation state must be pruned immediately after terminal completion.
- Preserve deterministic job-state transitions: one job, one truthful terminal state.
- Preserve SQLite safety and compatibility; prefer additive schema changes only if a missing persisted field is required for runtime correctness.
- Maintain workspace isolation for jobs, nodes, credentials, leases, and transport sessions.
- Avoid secret leakage in logs, responses, SSE payloads, or operator surfaces.
- Keep the design incremental: extend existing `src/execution`, `src/nodes`, `src/scheduler`, `src/api`, and `sdk/sandbox` code rather than adding new services or frameworks.
