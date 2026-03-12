# Remote Execution Completion — Tasks

## 1. Lock the regressions first

- [x] [Req 1, 2] Add failing tests in `tests/local-jobs.test.ts` for remote abort using an upstream handle, suppressing later completion, and releasing leases for remote success/failure/abort.
- [x] [Req 2, 3] Add scheduler regressions in `tests/nodes.phase3.test.ts` proving capacity is restored immediately after remote terminal states and managed-mode eligibility excludes invalid runtime candidates.
- [x] [Req 3, 5] Extend `tests/transport.test.ts` to cover execute/abort parity and connection-loss behavior for HTTPS and outbound-WSS transports.
- [x] [Req 4] Expand `tests/sdk.clients.test.ts` with sandbox wire-contract regressions for streaming exec, file methods, tunnel methods, and runtime endpoints.

## 2. Refactor remote execution into a lifecycle-aware path

- [x] [Req 1, 2, 5] Refactor `src/nodes/executor.ts` so remote execution returns a `RemoteExecutionRun` handle rather than only `Promise<JobResult>`.
- [x] [Req 1, 2, 5] Update `src/execution/local-jobs.ts` to track active remote runs by `jobId`, publish truthful remote lifecycle events, and clear handle state in terminal `finally` paths.
- [x] [Req 1] Update `abortJob()` in `src/execution/local-jobs.ts` so remote jobs call upstream abort before finalizing `job.aborted`.
- [x] [Req 2] Add a small lease-release helper in `src/execution/local-jobs.ts` or `src/scheduler/scheduler.ts` so all remote terminal paths apply the same release logic.

## 3. Make the transports execution-aware

- [x] [Req 3, 5] Replace the thin `request()/stream()` transport contract in `src/nodes/transport.ts` with a lifecycle-oriented execution interface.
- [x] [Req 3] Update `src/nodes/transport-https.ts` to include approved-node credentials and support explicit remote abort.
- [x] [Req 3, 5] Replace the current one-shot handler approach in `src/nodes/transport-wss.ts` with correlated request/run tracking suitable for long-running execution.
- [x] [Req 3] Update `src/nodes/transport-registry.ts` to resolve only transports that satisfy runtime policy for the selected node.

## 4. Enforce runtime node policy where scheduling actually happens

- [x] [Req 3] Update `src/scheduler/scheduler.ts` to require approval, health, capabilities, isolation compatibility, usable transport, usable credential, and managed-mode certification when enabled.
- [x] [Req 3] Add clear scheduler errors for “approved in storage but unusable at runtime” cases.
- [x] [Req 3] Wire issued credentials from `src/nodes/registry.ts` into runtime execution resolution rather than leaving them unused in SQLite.

## 5. Bring `sdk/sandbox` to the required v1 surface

- [x] [Req 4] Compare `sdk/sandbox/types.ts` to the current `or3-sandbox` API and update the request/response types used by `or3-net`.
- [x] [Req 4] Fix `sdk/sandbox/client.ts` streaming exec support to use `?stream=1` and parse the actual `stdout`/`stderr`/`result` event framing.
- [x] [Req 4] Add the missing file, tunnel, runtime, quota, and metrics methods required by current and near-term `or3-net` flows.
- [x] [Req 4] Add snapshot methods only if they are required by warm-pool or preview/service launch work in the current roadmap; otherwise document them as explicitly deferred.
- [x] [Req 4] Update `src/nodes/adapter-sandbox.ts` to consume the corrected SDK methods and preserve current warm-pool and service-launch behavior.

## 6. Preserve a stable host job stream

- [x] [Req 5] Normalize remote transport progress into existing host-side `JobStreamEvent` shapes in `src/execution/local-jobs.ts`.
- [x] [Req 5] Ensure remote jobs still emit a deterministic `job.started` and exactly one terminal event even when the upstream backend has no progress stream.
- [x] [Req 5] Add stable error codes for remote abort failure, transport disconnect, and remote execution startup failure.

## 7. Cross-repo contract validation

- [x] [Req 3, 4] Re-validate the corrected sandbox client against `/Users/brendon/Documents/or3-sandbox/planning/or3-net-plan.md` and current `sandboxd` behavior.
- [x] [Req 1, 5] Reconfirm that remote lifecycle normalization still matches the existing `or3-intern` local path contract so local and remote jobs behave consistently to clients.
- [x] [Req 3] Update planning notes if runtime policy or transport assumptions materially change.

## 8. Out of scope

- [ ] Do not redesign `or3-net` into a distributed broker or multi-host scheduler.
- [ ] Do not move execution ownership out of `or3-intern`.
- [ ] Do not introduce a brand-new public node protocol version unless wire incompatibility makes it unavoidable.
- [ ] Do not widen SDK scope with speculative endpoints that `or3-net` does not consume.
