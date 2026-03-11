# Control Plane Hardening — Tasks

## 1. Lock the regression coverage first

- [ ] [Req 1, 2] Add failing tests in `tests/local-jobs.test.ts` for remote abort invoking an upstream abort path, suppressing later `job.completed`, and releasing the associated lease.
- [ ] [Req 2] Add a scheduler regression in `tests/local-jobs.test.ts` or `tests/nodes.phase3.test.ts` proving a second remote job can start immediately after the first completes, fails, or aborts.
- [ ] [Req 3] Add a malformed-JSON API test in `tests/app.phase2.test.ts` for `POST /v1/workspaces/:workspaceId/previews/:previewId/launch` returning `400` with a stable client-facing error.
- [ ] [Req 4] Add preview capability cleanup tests in `tests/previews.phase45.test.ts` for expiry pruning, revoke pruning, and bounded repeated launch/revoke cycles.
- [ ] [Req 5, 6, 7] Add or tighten SDK/transport regressions in `tests/sdk.clients.test.ts`, `tests/transport.test.ts`, and `tests/nodes.phase3.test.ts` for sandbox wire parity, transport auth, and scheduling eligibility.
- [ ] [Req 8] Add failing API/CLI/console tests for job list and API-key-management surfaces in `tests/app.phase2.test.ts`, `tests/cli.test.ts`, and `tests/console.test.ts`.

## 2. Fix remote execution correctness in `src/execution`

- [ ] [Req 1, 2] Refactor `src/execution/local-jobs.ts` so the remote path tracks an in-memory remote execution handle keyed by `jobId` instead of only supporting local `backendJobIds`.
- [ ] [Req 1] Change `abortJob()` so remote jobs call the active remote abort path before returning success, and do not finalize abort locally when upstream cancellation fails.
- [ ] [Req 1] Preserve a pending-abort path only for jobs that have not yet acquired a usable upstream handle, and prevent later terminal completion from overwriting a confirmed abort.
- [ ] [Req 2] Capture the issued lease record in `runRemoteTask()` and release it in a `finally` block for remote completion, failure, and abort.
- [ ] [Req 2] Add a small lease-release helper in `src/execution/local-jobs.ts` or `src/scheduler/scheduler.ts` so lease terminal transitions are consistent and testable.

## 3. Strengthen the scheduler and DB handoff

- [ ] [Req 2, 7] Update `src/scheduler/scheduler.ts` so candidate selection only counts truly active leases and remains compatible with explicit `released` transitions.
- [ ] [Req 2] Reuse or extend `src/db/client.ts` lease persistence helpers so lease release does not duplicate SQL or accidentally reattach released leases to terminal jobs.
- [ ] [Req 7] Add scheduler-side eligibility checks for transport/auth/certification policy without weakening the existing approval and health filters.

## 4. Normalize malformed JSON at the API boundary

- [ ] [Req 3] Update `src/api/app.ts` `readOptionalJson()` to convert malformed JSON into `HttpError(400, "invalid JSON body")`.
- [ ] [Req 3] Verify `handleAppRequest()` preserves stable `400` responses for body-parse errors and does not leak engine-specific parser details.
- [ ] [Req 3] Review other optional-body routes in `src/api/app.ts` and route them through the same helper for consistent behavior.

## 5. Bound preview launch capability memory growth

- [ ] [Req 4] Add a single capability-deletion helper in `src/previews/service.ts` that removes a token from `launchCapabilities`, `previewLaunchTokens`, and `scopedLaunchTokens`.
- [ ] [Req 4] Call the helper from expiry handling in `resolveLaunchCapability()`.
- [ ] [Req 4] Call the helper from preview revoke and scope revoke flows instead of only flipping a `revoked` flag.
- [ ] [Req 4] Review service-launch capability reuse paths to ensure repeated mint/revoke cycles do not leave dead reverse-index entries behind.

## 6. Bring `sdk/sandbox` into parity with `or3-sandbox`

- [ ] [Req 5] Compare `sdk/sandbox/types.ts` against the real `or3-sandbox` API models and update the types that currently diverge.
- [ ] [Req 5] Fix `sdk/sandbox/client.ts` streaming exec support so it uses the real streaming endpoint/query semantics and parses the actual stream payload shape.
- [ ] [Req 5] Add missing SDK methods required by current `or3-net` adapter/service flows, prioritizing files, tunnels, snapshots, runtime, quota, and metrics endpoints already assumed by planning docs.
- [ ] [Req 5] Keep the SDK surface incremental: implement what `or3-net` needs now and document any deferred endpoint coverage instead of shipping incorrect stubs.

## 7. Make remote-node transport and executor lifecycle-aware

- [ ] [Req 1, 6] Refactor `src/nodes/executor.ts` so remote execution returns a handle/run object with an abort path rather than only a final `Promise<JobResult>`.
- [ ] [Req 6] Update `src/nodes/transport.ts` to model execution and abort explicitly, or add a start/abort lifecycle API that the executor can depend on.
- [ ] [Req 6, 7] Update `src/nodes/transport-https.ts` to send approved-node credentials and support remote abort calls.
- [ ] [Req 6] Replace the current one-shot outbound WSS handler model in `src/nodes/transport-wss.ts` with request correlation suitable for long-running execution and abort.
- [ ] [Req 6, 7] Ensure transport failures surface as execution failures that still let `LocalJobService` publish one truthful terminal state and release the lease.

## 8. Enforce node credential and certification policy in the runnable path

- [ ] [Req 7] Trace how issued credentials from `src/nodes/registry.ts` are resolved at execution time and wire them into the active transport path.
- [ ] [Req 7] Introduce an additive managed-mode policy check for `manifest.certification` expiry/presence in scheduler candidate filtering.
- [ ] [Req 7] Add clear error paths when a node is approved in storage but unusable at runtime because its credential, certification, or supported transport is missing.

## 9. Fill the missing operator surfaces

- [ ] [Req 8] Add a workspace job-list route to `src/api/app.ts`, backed by existing `src/db/client.ts` query helpers.
- [ ] [Req 8] Add the minimal API-key-management HTTP routes needed for operator workflows, reusing existing auth/database primitives if present instead of inventing a new subsystem.
- [ ] [Req 8] Extend `cli/index.ts` with job-list and API-key-management commands that mirror the new HTTP routes.
- [ ] [Req 8] Extend `src/console/index.ts` so the built-in console can list jobs, inspect or switch active job streams, show node approval state, and perform API-key operations.
- [ ] [Req 8] Keep the console thin and authenticated; do not introduce a separate frontend stack.

## 10. Align `or3-net` with upstream service contracts

- [ ] [Req 9] Review `sdk/intern/types.ts` and client calls against the current `or3-intern` service API so `allowed_tools`, `tool_policy`, and event-shape assumptions are either aligned or explicitly adapted.
- [ ] [Req 9] Decide whether `/internal/v1/subagents` is treated as required, capability-gated, or optional-with-fallback, and reflect that in `or3-net` integration logic and docs.
- [ ] [Req 9] Cross-check the corrected sandbox SDK behavior against the real `or3-sandbox` HTTP routes before depending on it for more remote features.
- [ ] [Req 9] If upstream contract mismatches cannot be fixed immediately, document the compatibility shim and pin tests to the current supported behavior.

## 11. Documentation and rollout notes

- [ ] [Req 5, 6, 7, 8, 9] Update the relevant `or3-net/planning` summary docs if any contract or phase assumptions materially change after remediation.
- [ ] [Req 8, 9] Update `README.md` or operator docs only where new CLI/API workflows need discoverability.
- [ ] [Req 1, 2, 5, 6, 9] Record any remaining cross-repo blockers in the relevant `or3-intern` or `or3-sandbox` planning notes instead of baking unsupported assumptions into `or3-net`.

## 12. Out of scope

- [ ] Do not redesign `or3-net` into a new multi-service control plane.
- [ ] Do not replace the built-in console with a separate SPA.
- [ ] Do not change token formats, workspace scoping rules, or SQLite table ownership unless a concrete incompatibility forces an additive migration.
- [ ] Do not broaden remote streaming or node protocol features beyond what is needed to make current execution, abort, auth, and operator flows correct and testable.
