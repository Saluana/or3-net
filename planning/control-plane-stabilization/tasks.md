# 1. Lock the lifecycle regressions first

- [ ] [Req 1, 2, 3] Add focused tests in `tests/local-jobs.test.ts`, `tests/nodes.phase3.test.ts`, and `tests/transport.test.ts` for remote abort, terminal-state monotonicity, lease release, and restart repair.
- [ ] [Req 4] Add sandbox contract regressions in `tests/sdk.clients.test.ts` for exec stream framing, files, tunnels, lifecycle, and runtime endpoints used today.
- [ ] [Req 5] Add API tests in `tests/app.phase2.test.ts` for malformed JSON envelopes and idempotent retry behavior on the chosen sensitive flows.

# 2. Make remote execution truthful

- [ ] [Req 1, 3] Refactor `src/nodes/executor.ts` and `src/execution/local-jobs.ts` so remote execution returns a lifecycle-aware handle with stream, abort, and final result paths.
- [ ] [Req 1] Add one terminal-state helper in `src/execution/local-jobs.ts` that persists exactly one terminal outcome and drops later contradictory events.
- [ ] [Req 1, 2] Move lease release into a shared terminal path so success, failure, abort, and startup timeout all clean up the node claim.

# 3. Repair scheduler and transport seams

- [ ] [Req 2, 3] Update `src/scheduler/scheduler.ts` to count only live leases and require usable transport, credentials, and certification posture during candidate selection.
- [ ] [Req 2] Add startup reconciliation in `src/execution/local-jobs.ts` or a nearby execution bootstrap path to repair stuck leases and orphaned remote jobs.
- [ ] [Req 3] Update `src/nodes/transport.ts`, `src/nodes/transport-https.ts`, and `src/nodes/transport-wss.ts` to support execute, stream, abort, heartbeat, and terminal result with issued credentials.

# 4. Freeze the sandbox and operator contracts

- [ ] [Req 4] Correct `sdk/sandbox/types.ts`, `sdk/sandbox/client.ts`, and `src/nodes/adapter-sandbox.ts` to match the real `or3-sandbox` contract for the endpoints `or3-net` already depends on.
- [ ] [Req 5] Add bounded cleanup for preview/service launch state in `src/previews/service.ts` so resolve, revoke, and expiry remove reverse-index entries.
- [ ] [Req 5] Add minimal operator inspection routes in `src/api/app.ts`, matching CLI commands in `cli/index.ts` and thin console views in `src/console/*` for jobs, nodes, previews, and revoke actions.

# 5. Keep cross-repo drift visible

- [ ] [Req 4, 5] Document the supported `or3-net` ↔ `or3-sandbox` contract level in this planning directory and fail CI when contract tests drift.
- [ ] [Req 3, 5] Reconfirm `sdk/intern/*` assumptions against `or3-intern` service mode so `tool_policy`, session aliases, streaming, and abort behavior stay aligned.

# 6. Out of scope

- [ ] Do not add a new broker, worker service, or distributed scheduler.
- [ ] Do not replace the built-in console with a separate frontend.
- [ ] Do not broaden sandbox SDK coverage beyond the endpoints current control-plane flows actually use.
