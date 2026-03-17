# OpenSandbox Migration — Tasks

## 1. Freeze the migration boundary

- [ ] [Req 1, 2, 7] Record the provider decision in active migration docs: `OpenSandbox` first, `Cloudflare Sandboxes` later as managed option, `OpenShell` later as optional provider.
- [ ] [Req 1, 4, 6] Audit and list every remaining `or3-sandbox` dependency in `src/`, `tests/`, and `docs/`.
- [ ] [Req 2] Confirm Bun compatibility for `@alibaba-group/opensandbox` or document a wrapper fallback path that talks to the server API directly.
- [ ] [Req 3, 4, 5] Record the OpenSandbox parity assumptions that matter for `or3-net`: lifecycle, command execution, file staging, endpoint lookup, preview security posture, and missing archive transport.

## 2. Introduce provider-neutral seams in `or3-net`

- [ ] [Req 1, 4] Replace `SandboxNodeAdapter` dependencies in `src/api/app.ts`, `src/execution/local-jobs.ts`, and `src/server.ts` with a provider-neutral node execution interface.
- [ ] [Req 1, 6] Replace `SandboxRequestError` and `normalizeSandboxError()` dependencies with a provider-neutral or OpenSandbox-specific error normalization boundary.
- [ ] [Req 1] Remove any remaining assumption in application services that the sandbox backend is named `sandbox` or `or3-sandbox` rather than selected by implementation.

## 3. Add the OpenSandbox wrapper under `sdk/opensandbox`

- [ ] [Req 2] Create `sdk/opensandbox/types.ts` for the subset of OpenSandbox operations `or3-net` actually uses.
- [ ] [Req 2] Create `sdk/opensandbox/client.ts` as a thin internal wrapper around `@alibaba-group/opensandbox`.
- [ ] [Req 2, 6] Implement normalized provider error handling with status, code, retry metadata, and preserved cause details.
- [ ] [Req 2] Implement wrapper methods for create, connect, list, get, pause, resume, renew, and kill.
- [ ] [Req 2, 4] Implement wrapper methods for command execution with incremental stdout and stderr delivery.
- [ ] [Req 2, 4] Implement wrapper methods for file staging and readback.
- [ ] [Req 2, 5] Implement wrapper methods for endpoint lookup and URL resolution.

## 4. Implement `OpenSandboxRuntimeAdapter`

- [ ] [Req 3] Add `src/runtime/adapters/opensandbox.ts` implementing `RuntimeAdapter`.
- [ ] [Req 3] Map OpenSandbox lifecycle state to runtime session state.
- [ ] [Req 3, 6] Map OpenSandbox command results and streaming output into OR3 runtime execution results.
- [ ] [Req 3] Implement stop and destroy semantics using OpenSandbox lifecycle operations.
- [ ] [Req 3] Implement workspace staging transport capabilities with file-based transport first; only add archive transport if proven.
- [ ] [Req 3, 7] Define the runtime adapter manifest and configuration surface for `opensandbox`.

## 5. Implement `OpenSandboxNodeAdapter`

- [ ] [Req 4] Add `src/nodes/adapter-opensandbox.ts` to replace sandbox-backed task execution behavior.
- [ ] [Req 4] Implement artifact staging from `TaskPackage` into the OpenSandbox filesystem.
- [ ] [Req 4, 6] Implement command execution with event normalization into OR3 job stream events.
- [ ] [Req 4] Implement service discovery based on node manifest `service:*` capabilities.
- [ ] [Req 4, 5] Implement `prepareServiceLaunch()` using OpenSandbox endpoint resolution and OR3 preview metadata generation.
- [ ] [Req 4, 5] Implement `restartService()` and `revokeServiceLaunch()` with clear provider-side semantics.
- [ ] [Req 4] Attach OR3 metadata such as workspace, node, job, and service ids to provider instances where supported.

## 6. Cut application wiring over to OpenSandbox

- [ ] [Req 3, 4] Update `src/server.ts` to register `OpenSandboxRuntimeAdapter` instead of the removed sandbox adapter when OpenSandbox config is present.
- [ ] [Req 4, 5] Update `src/api/app.ts` node service routes to depend on the new node execution adapter.
- [ ] [Req 4, 6] Update `src/execution/local-jobs.ts` to execute sandbox-style remote jobs through the new adapter and preserve stream normalization.
- [ ] [Req 6] Update `src/contracts/platform/compat.ts` and any route-level error branches to use OpenSandbox provider errors.
- [ ] [Req 7] Add explicit OpenSandbox configuration loading and startup validation.

## 7. Remove legacy `or3-sandbox` code

- [ ] [Req 1] Delete `sdk/sandbox/client.ts`.
- [ ] [Req 1] Delete `sdk/sandbox/types.ts`.
- [ ] [Req 1] Delete `sdk/sandbox/index.ts`.
- [ ] [Req 1] Delete `src/runtime/adapters/sandbox.ts`.
- [ ] [Req 1] Delete `src/nodes/adapter-sandbox.ts`.
- [ ] [Req 1] Delete `src/scheduler/warmpool.ts`.
- [ ] [Req 1] Remove legacy exports from `src/index.ts`, `src/runtime/adapters/index.ts`, and any other barrels.

## 8. Replace tests

- [ ] [Req 8] Replace `tests/sdk.clients.test.ts` sandbox client coverage with OpenSandbox wrapper coverage.
- [ ] [Req 8] Replace `tests/runtime/adapters/sandbox.test.ts` with `OpenSandboxRuntimeAdapter` tests.
- [ ] [Req 8] Delete or replace `tests/warmpool.test.ts` based on the decision to remove warm-pool behavior from the first OpenSandbox cut.
- [ ] [Req 8] Update `tests/runtime.phase7.integration.test.ts` to cover OpenSandbox runtime registration and lifecycle behavior.
- [ ] [Req 8] Update `tests/local-jobs.test.ts` to use the OpenSandbox-backed node execution path.
- [ ] [Req 8] Update `tests/previews.phase45.test.ts` to validate OpenSandbox-backed service launch and revoke behavior.
- [ ] [Req 8] Replace `tests/contracts/sandbox-sdk.contract.test.ts` with contract tests for the OpenSandbox wrapper surface actually used by `or3-net`.

## 9. Rewrite documentation and active planning references

- [ ] [Req 1, 8] Replace or remove `docs/sdk/sandbox-sdk.md`.
- [ ] [Req 8] Update `docs/README.md`, `docs/getting-started.md`, `docs/api/http-api.md`, and `docs/concepts/runtimes-and-nodes.md` to describe OpenSandbox instead of `or3-sandbox`.
- [ ] [Req 1, 7, 8] Update active `or3-net` planning docs that still describe `or3-sandbox` as the first or default backend.
- [ ] [Req 7] Remove stale `OR3_SANDBOX_*` deployment guidance from active `or3-net` docs and replace it with OpenSandbox configuration guidance.

## 10. Validation and release gate

- [ ] [Req 2, 8] Run Bun typecheck, lint, and the updated test suite after the migration cutover.
- [ ] [Req 3, 4, 8] Validate runtime session create/exec/destroy against a real or mocked OpenSandbox environment.
- [ ] [Req 4, 5, 8] Validate service launch, preview open, revoke, and expiry behavior against the chosen endpoint exposure model.
- [ ] [Req 1, 8] Confirm no remaining `or3-sandbox` references exist in active `or3-net` production code, tests, and docs.

## 11. Out of scope for this plan

- [ ] Do not implement `Cloudflare Sandboxes` in the same migration.
- [ ] Do not implement `OpenShell` in the same migration.
- [ ] Do not rebuild warm-pool or provider pooling behavior before the OpenSandbox path is stable.
- [ ] Do not change `or3-intern` contracts as part of this backend migration.
- [ ] Do not expose raw OpenSandbox provider credentials or raw provider admin URLs directly to browser clients.
