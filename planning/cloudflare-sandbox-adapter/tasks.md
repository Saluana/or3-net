# Cloudflare Sandbox Adapter — Tasks

## 1. Freeze the integration boundary

- [x] [Req 1, 2] Record that `Cloudflare Sandbox` is a managed-provider path implemented through a Worker bridge, not a direct Bun SDK dependency.
- [x] [Req 1, 4, 5] Record the first-cut lifecycle decision: one OR3 runtime/job/service environment maps to one named Cloudflare sandbox.
- [x] [Req 5, 6] Record the preview-domain requirement and `.workers.dev` limitation in the active plan and future operator docs.

## 2. Define the Worker bridge contract

- [x] [Req 2, 3] Define the minimal HTTP endpoints for sandbox lifecycle, exec, files, processes, ports, and health.
- [x] [Req 2, 7] Define the bridge error envelope and retry metadata shape expected by the Bun wrapper.
- [x] [Req 2, 5] Define the preview routing behavior, including `proxyToSandbox()` ownership and hostname requirements.
- [x] [Req 2, 8] Decide where the bridge code lives in the repo or provider package structure.

## 3. Add `sdk/cloudflare-sandbox` wrapper

- [x] [Req 2] Create `sdk/cloudflare-sandbox/types.ts` for the subset of bridge operations `or3-net` uses.
- [x] [Req 2, 7] Create `sdk/cloudflare-sandbox/client.ts` for authenticated bridge calls and error normalization.
- [x] [Req 3] Implement wrapper methods for sandbox create/get/destroy.
- [x] [Req 3] Implement wrapper methods for exec, process start/status/kill, and process logs.
- [x] [Req 3] Implement wrapper methods for file write/read/mkdir.
- [x] [Req 3, 5] Implement wrapper methods for expose/unexpose/list ports and preview metadata.

## 4. Build the Cloudflare Worker bridge

- [x] [Req 2, 3] Add Worker-side request handlers that call `@cloudflare/sandbox`.
- [x] [Req 2, 5] Add preview routing via `proxyToSandbox()` at the top of the Worker fetch handler.
- [x] [Req 3] Implement named sandbox provisioning and destruction.
- [x] [Req 3] Implement command execution and file operations.
- [x] [Req 3] Implement process lifecycle and log retrieval.
- [x] [Req 5] Implement port expose/unexpose/list behavior with explicit custom-domain validation.
- [x] [Req 6] Add health endpoint(s) that surface preview capability readiness separately from basic exec readiness.

## 5. Implement `CloudflareRuntimeAdapter`

- [x] [Req 1, 3] Add `src/runtime/adapters/cloudflare-sandbox.ts` implementing `RuntimeAdapter`.
- [x] [Req 3, 4] Provision one named sandbox per OR3 runtime session.
- [x] [Req 3, 7] Map command execution and file transport into OR3 runtime contracts.
- [x] [Req 3] Implement stop/destroy semantics with clear provider-side cleanup.
- [x] [Req 1, 6] Register the adapter in runtime wiring only when Cloudflare config is present.

## 6. Implement `CloudflareNodeAdapter`

- [x] [Req 1, 3] Add `src/nodes/adapter-cloudflare-sandbox.ts` implementing `NodeExecutionAdapter`.
- [x] [Req 4] Stage task artifacts into `/workspace` before execution.
- [x] [Req 7] Normalize stdout/stderr/result events into the OR3 job stream model.
- [x] [Req 4, 5] Add service launch support using process start, readiness checks, and port exposure.
- [x] [Req 5] Make revoke idempotent by unexposing ports and cleaning up sandbox/process state conservatively.

## 7. Cut application wiring over

- [x] [Req 1] Update `src/server.ts` to register Cloudflare runtime/node adapters behind explicit configuration.
- [x] [Req 1, 7] Update `src/api/app.ts` and `src/execution/local-jobs.ts` only through existing provider-neutral seams.
- [x] [Req 6, 7] Extend provider error normalization in platform compatibility code for Cloudflare bridge errors.

## 8. Add tests

- [x] [Req 8] Add contract tests for the Bun wrapper request/response mapping.
- [x] [Req 8] Add Worker bridge tests for lifecycle, files, processes, ports, and preview-domain failures.
- [x] [Req 8] Add runtime adapter tests for create/exec/copy/destroy.
- [x] [Req 8] Add node adapter tests for artifact staging, job streaming, service launch, and revoke.
- [x] [Req 8] Add degraded-mode tests proving preview launch is unavailable without valid custom-domain configuration.

## 9. Document and validate

- [x] [Req 6, 8] Write operator docs for bridge deployment, auth, custom domains, and preview routing.
- [x] [Req 8] Update `docs/concepts/runtimes-and-nodes.md` and related runtime docs to list Cloudflare as a managed provider option.
- [x] [Req 8] Validate the adapter against a real Cloudflare test environment or a bridge test harness before merging.

## 10. Explicitly out of scope for v1

- [ ] Do not make Cloudflare the default backend.
- [ ] Do not add archive workspace transport in the first cut unless clearly needed.
- [ ] Do not depend on explicit sub-session port exposure behavior that the docs do not support.
- [ ] Do not ship raw provider preview URLs as the only access-control layer.
- [ ] Do not implement advanced Cloudflare-only features such as bucket mounts, browser terminals, or desktop automation in the initial adapter.