# Control Plane Hardening — Requirements

## Overview

This plan addresses the execution, scheduler, API-boundary, preview-lifecycle, SDK, transport, and operator-surface issues documented in `dumb-issues.md`.

Scope:

- Fix correctness bugs where `or3-net` reports success without actually canceling or releasing remote work.
- Close API and in-memory lifecycle gaps that currently misclassify client errors or retain dead state indefinitely.
- Bring the sandbox SDK, remote-node transport, and operator-facing surfaces up to the minimum contract implied by the existing codebase and planning docs.
- Track the cross-repo contract work in `or3-intern` and `or3-sandbox` that `or3-net` depends on.

Assumptions:

- `or3-net` remains a Bun/TypeScript control plane with SQLite persistence.
- The fix should prefer localized changes in existing packages over introducing new daemons, services, or frameworks.
- Existing workspace isolation, auth token formats, SQLite data, and test patterns must remain backward-compatible.

## Requirements

### 1. Remote abort must cancel real work

**Requirement:** As an API client, I need `POST /v1/jobs/:jobId/abort` to stop remote execution rather than only marking host-side state as aborted.

**Acceptance criteria:**

- When a job is executing through the remote path, `abortJob()` must route cancellation through a remote execution handle or backend-specific abort call before returning success.
- When a remote job is aborted before its remote handle is available, the job may be marked as pending-abort internally, but it must not be finalized as aborted until the upstream cancel path is acknowledged or the job is prevented from starting.
- When remote abort succeeds, `or3-net` must not persist a later `job.completed` terminal state for the same job.
- When remote abort fails, `or3-net` must return a failure to the caller rather than silently pretending the job was canceled.

### 2. Remote lease lifecycle must release scheduler capacity promptly

**Requirement:** As the scheduler, I need leases for remote jobs to transition out of `active` as soon as remote execution ends or aborts.

**Acceptance criteria:**

- When a remote job completes, fails, or aborts, its associated lease must be marked `released` (or another explicit non-active terminal state) during the same execution flow.
- A released remote lease must no longer count toward scheduler capacity.
- A second eligible job must be schedulable immediately after a first remote job reaches a terminal state, without waiting for lease TTL expiry.
- Lease release must happen in a `finally`-style path so it also runs after thrown errors.

### 3. Invalid JSON bodies must be treated as client errors

**Requirement:** As an API client, I need malformed JSON requests to return stable `400` errors instead of `500` responses with parser internals.

**Acceptance criteria:**

- `readOptionalJson()` and any equivalent request-body helpers must translate malformed JSON into an explicit `400` request error.
- `POST /v1/workspaces/:workspaceId/previews/:previewId/launch` with malformed JSON must return `400`.
- The response body for malformed JSON must be a stable client-facing error string and must not include engine-specific parser text.

### 4. Preview launch capability state must be bounded in memory

**Requirement:** As a long-running `or3-net` process, I need expired and revoked preview launch capabilities to be removed from in-memory indexes.

**Acceptance criteria:**

- Expired capabilities must be pruned from `launchCapabilities` and reverse indexes during lookup or cleanup.
- Preview revoke and scope revoke flows must delete token references from both the main map and reverse indexes.
- Repeated launch/revoke cycles must not grow internal token sets without bound.
- Capability resolution after expiry or revoke must still return the correct client-facing `410`/`403` behavior.

### 5. The sandbox SDK must match the real `or3-sandbox` v1 API

**Requirement:** As the sandbox-backed node adapter, I need the TypeScript SDK in `or3-net` to speak the same HTTP, streaming, and payload contracts as `or3-sandbox`.

**Acceptance criteria:**

- Streaming exec requests must use the real `or3-sandbox` streaming contract, including the required query parameters and event framing semantics.
- SDK request and response types must match the current `or3-sandbox` model shapes for sandboxes, exec, files, tunnels, snapshots, runtime info, quota, and metrics endpoints used by `or3-net`.
- Missing SDK methods required by current or planned adapter/service flows must be implemented or explicitly deferred behind documented feature gates.
- SDK tests must cover both normal JSON endpoints and streaming behavior against the expected wire protocol.

### 6. Remote transport must support execution, streaming, abort, and node auth coherently

**Requirement:** As `or3-net`, I need the remote-node execution stack to preserve control over remote jobs across both configured transports.

**Acceptance criteria:**

- The remote executor must expose an execution lifecycle that supports both result delivery and abort.
- HTTPS transport must send the issued node credential or equivalent auth material required by approved nodes.
- Outbound WSS transport must support request correlation for long-running execution and abort messages, not just a one-shot injected function.
- Remote execution paths must be able to surface streamed progress or explicitly normalize the lack of streaming without breaking job-state correctness.

### 7. Scheduling must enforce node approval, health, and certification policy consistently

**Requirement:** As an operator, I need the scheduler to refuse nodes that are approved-in-name only but not eligible under transport/auth/certification policy.

**Acceptance criteria:**

- Scheduler candidate selection must continue to require approval and healthy-enough node state.
- When managed-mode certification policy is enabled, uncertified or expired-certified nodes must not receive leases.
- Issued node credentials must be consumed by the active transport path rather than only stored in SQLite.
- Scheduling must fail clearly when no eligible node satisfies capabilities, transport, auth, and certification requirements.

### 8. Operator surfaces must expose the minimum control-plane workflows

**Requirement:** As an operator or SDK client, I need the API, CLI, and built-in console to expose the key control-plane workflows that already exist in storage and scheduling layers.

**Acceptance criteria:**

- The HTTP API must provide a jobs listing route for workspace-scoped operational visibility.
- The HTTP API must provide the minimal API-key-management surface needed for create/list/revoke or equivalent operator workflows.
- The CLI must expose commands for job listing and API-key management in addition to the existing node and job commands.
- The console must expose an authenticated overview that covers at least node approval visibility, job list/selection, and API key operations rather than only the current narrow action set.

### 9. `or3-net`’s external contracts must align with `or3-intern` and `or3-sandbox`

**Requirement:** As `or3-net`, I need its SDK and integration assumptions to match the actual upstream service contracts so the control plane does not depend on stale or imaginary behavior.

**Acceptance criteria:**

- The `sdk/intern` contract must either align with the current `or3-intern` service API or include a documented compatibility adapter with tests.
- The plan to move from `allowed_tools` toward `tool_policy` must be explicit so `or3-net` does not freeze the wrong public contract.
- The conditional availability of `/internal/v1/subagents` must be surfaced either as a capability check or a documented dependency, rather than assumed universal behavior.
- The sandbox SDK contract must be validated against the real `or3-sandbox` API shape before new remote features depend on it.

## Non-functional constraints

- Preserve workspace isolation for jobs, leases, nodes, previews, API keys, and launch capabilities.
- Preserve SQLite safety and compatibility; prefer additive or query-level changes over schema churn unless a missing persistence field is proven necessary.
- Keep active execution and preview state bounded in memory; do not introduce unbounded in-process maps or queues.
- Keep job-state transitions deterministic; a job must not publish conflicting terminal states.
- Avoid leaking parser internals, credentials, or transport secrets in API responses, logs, or console output.
- Prefer incremental fixes inside `src/execution`, `src/scheduler`, `src/api`, `src/previews`, `src/nodes`, `sdk`, `cli`, and `src/console` rather than adding new architectural layers.
