# OR3 Node Agent Tasks

## 1. Foundation and scope lock

- [ ] [Req 1, 2, 4, 13] Record the product boundary in docs and code comments: `or3-net` stays the control plane; `or3-node-agent` is the installable machine agent; do not turn `or3-net` into the host daemon.
- [ ] [Req 1] Lock the operator UX target: primary install is `bun install -g or3-node` and primary startup is `or3-node launch`.
- [ ] [Req 13] Lock the integration constraint: prefer the smallest viable `or3-net` changes by extending existing node, executor, transport, and runtime-session codepaths.
- [ ] [Req 7, 11] Lock the v1 scope to direct machine control primitives and explicit capability gating; keep hostile-code isolation and multi-tenant guarantees out of scope.
- [ ] [Req 7] Decide the v1 feature cut for remote machine control: job execution only first, or job execution plus remote runtime-session lifecycle in the first milestone.

## 2. Add node-agent planning and project scaffolding

- [ ] [Req 1] Create the `or3-node` package with a Bun bin entry so `bun install -g or3-node` installs an `or3-node` executable.
- [ ] [Req 1, 13] Create a future project location for the source (for example `or3-node-agent/`) and document why it stays separate from the `or3-net` server runtime even though the shipped CLI name is `or3-node`.
- [ ] [Req 1, 13] Add a short architecture README for the agent project covering launch, bootstrap, connection, execution, and capability advertisement.
- [ ] [Req 1, 11, 13] Define the agent config surface so the common path works without hand-editing config files: URL, bootstrap token source, allowed roots, shell defaults, limits, and capability toggles.

## 3. Build the one-command launch flow first

- [ ] [Req 1, 2, 13] Implement `or3-node launch` as the main entrypoint that loads config, creates identity if needed, handles bootstrap if missing, and then starts the agent loop.
- [ ] [Req 1] Add flag-based non-interactive launch support such as `--url` and `--token` for automation.
- [ ] [Req 1, 13] Add an interactive prompt flow for first-run bootstrap when required inputs are missing.
- [ ] [Req 1, 12, 13] Persist generated config and identity state on first successful launch so restarts do not require repeating setup.
- [ ] [Req 1, 13] Add a simple `or3-node doctor` command to validate config, connectivity, identity, and approval status.

## 4. Bootstrap and enrollment flow

- [ ] [Req 2] Add a short-lived node bootstrap token or claim model to `or3-net` persistence and service wiring.
- [ ] [Req 2, 3] Implement control-plane issuance of bootstrap credentials in the node management surface, likely in `src/nodes/registry.ts` and `src/api/app.ts`.
- [ ] [Req 2] Implement agent-side keypair generation, manifest signing, and bootstrap redemption.
- [ ] [Req 13] Keep bootstrap as a small extension to existing node enrollment rather than a separate onboarding subsystem in `or3-net`.
- [ ] [Req 1, 2, 13] Keep `init` and `enroll` as optional advanced commands only if they are still useful for debugging; do not require them for the normal `launch` flow.
- [ ] [Req 2, 3] Add tests for bootstrap token expiry, invalid tokens, node id reuse, and pubkey mismatch.

## 5. Approval and runtime credential lifecycle

- [ ] [Req 3] Extend `NodeRegistryService` in `src/nodes/registry.ts` so agent-friendly approval and credential handoff are documented and test-covered.
- [ ] [Req 3, 12] Implement agent-side secure storage for the node runtime credential and expiry metadata.
- [ ] [Req 3] Implement credential refresh / re-fetch flow before expiry, or document explicit re-approval behavior if refresh is deferred.
- [ ] [Req 3, 12] Add regression tests covering credential rotation, revocation, and restart behavior.

## 6. Real outbound connection transport

- [ ] [Req 4] Replace the current in-process-only role of `src/nodes/transport-wss.ts` with real connected-agent session management.
- [ ] [Req 4, 13] Add a server-side connection hub that authenticates the node credential and binds a live socket to `(workspaceId, nodeId)`.
- [ ] [Req 13] Keep the hub narrow and reuse the current node transport registry/executor model instead of introducing a parallel remote-control service tree.
- [ ] [Req 4] Implement agent-side outbound WSS connection, reconnect backoff, heartbeat loop, and last-seen updates.
- [ ] [Req 4] Keep `src/nodes/transport-https.ts` as a dev/fallback transport and document the tradeoffs.
- [ ] [Req 4, 13] Add integration tests for connect, disconnect, reconnect, auth failure, and stale-health behavior.

## 7. Agent host-control core

- [ ] [Req 6, 11] Create the internal host-control boundary inside the agent for exec, abort, optional file access, optional PTY, and optional tunnel operations.
- [ ] [Req 6, 11] Implement host exec with argv-first execution, cwd/env controls, timeout enforcement, stdout/stderr caps, stdin caps, and structured terminal states.
- [ ] [Req 11] Add config-driven allowlists for environment passthrough and filesystem roots.
- [ ] [Req 12, 13] Persist enough local execution metadata for restart-safe debugging and recent-failure reporting.
- [ ] [Req 6, 11, 13] Add unit tests for timeout, missing binary, invalid cwd, oversized output, abort, and secrets-safe error handling.

## 8. Wire leased execution into existing OR3 Net nodes flow

- [ ] [Req 6] Implement real `execute`, `heartbeat`, and `abort` handling over the connected WSS transport using the current `src/contracts/protocol.ts` contract as the starting point.
- [ ] [Req 6] Update `src/nodes/executor.ts` to resolve connected agents and dispatch real remote work instead of only in-memory handler shims.
- [ ] [Req 6] Validate that `RemoteNodeExecutor` and job streaming continue to produce normalized OR3 job events.
- [ ] [Req 13] Avoid new job-dispatch subsystems; keep remote leased execution flowing through the current executor path.
- [ ] [Req 6, 13] Add integration tests for lease issue → remote execute → stream → complete, plus abort and disconnected-node failures.

## 9. Grow remote-node runtime sessions beyond exec-only

- [ ] [Req 7] Decide and document the minimum internal RPC extension needed for remote runtime-session support.
- [ ] [Req 7] Extend `src/contracts/protocol.ts` with session-oriented node RPC methods for `create_session`, `get_session`, `destroy_session`, `exec`, and `get_logs`.
- [ ] [Req 7] Implement matching agent-side handlers backed by the host-control service.
- [ ] [Req 7] Extend `src/runtime/adapters/remote-node.ts` to support session creation, execution, destroy, and logs through the agent.
- [ ] [Req 13] Reuse the public runtime-session routes already in `src/api/app.ts`; do not add a second public machine-session API unless a proven gap remains.
- [ ] [Req 7] Add runtime-session integration tests covering capability mismatches, session lifecycle, and log retrieval.

## 10. Add file access support

- [ ] [Req 8] Define file-operation RPC shapes for read, write, copy-in, and copy-out in the internal node protocol.
- [ ] [Req 8, 11] Implement allowed-root validation, size caps, and traversal prevention in the agent host-control layer.
- [ ] [Req 8] Extend `src/runtime/adapters/remote-node.ts` to surface file capabilities when the node manifest advertises them.
- [ ] [Req 8, 13] Add unit and integration tests for valid reads/writes, oversized transfers, invalid paths, and disabled capability behavior.

## 11. Add PTY support

- [ ] [Req 9] Define PTY RPC and event framing over WSS for open, input, resize, close, output, and exit.
- [ ] [Req 9] Implement agent-side PTY lifecycle management with platform checks and session limits.
- [ ] [Req 9] Add OR3 Net server wiring for PTY-capable remote runtime sessions or a scoped machine-control route if runtime-session parity is staged.
- [ ] [Req 9, 13] Add tests for PTY open, resize, exit, disconnect cleanup, and unsupported-platform failures.

## 12. Add service exposure and preview integration

- [ ] [Req 10] Define how the agent advertises launchable local services or tunnel targets without exposing arbitrary raw ports by default.
- [ ] [Req 10] Extend the node execution / remote runtime path to request a controlled service launch from the agent.
- [ ] [Req 10] Keep preview-token minting in `or3-net` and integrate the agent flow with existing preview launch and revoke behavior in `src/api/app.ts` and preview services.
- [ ] [Req 10, 13] Add integration tests for launch, revoke, expiry, and recent-failure reporting.

## 13. Health, info, and observability

- [ ] [Req 5, 13] Add agent-local `info` and `health` reporting including version, platform, arch, capability summary, connection state, and recent error.
- [ ] [Req 13] Surface node connection health cleanly in OR3 Net list and detail routes.
- [ ] [Req 13] Add structured logs on both sides for bootstrap, approval, connect, disconnect, exec start/finish, PTY lifecycle, and service launch.
- [ ] [Req 1, 13] Write manual smoke docs and scripts from `bun install -g or3-node` to first remote command.

## 14. Cross-platform and packaging work

- [ ] [Req 5, 9, 11] Define the supported matrix for Linux, macOS, and Windows, including which capabilities are enabled on each platform for v1.
- [ ] [Req 1, 13] Make global Bun install the primary packaging story and add service-manager guidance only as a follow-up path (for example `launchd`, `systemd`, or Windows service documentation).
- [ ] [Req 11] Document clearly that host mode is trusted-machine control, not hostile-code isolation.

## 15. Validation and release gate

- [ ] [Req 1, 2, 3, 4, 6, 13] Run Bun typecheck, lint, and a focused automated suite covering bootstrap, approval, connect, remote execute, reconnect, and first-launch UX.
- [ ] [Req 7, 8, 9, 10] Add staged release gates for runtime-session parity, file access, PTY, and service launch rather than treating them as hidden stretch work.
- [ ] [Req 12, 13] Validate restart behavior for identity persistence, credential revocation, and stale-connection recovery.
- [ ] [Req 1, 13] Add end-to-end smoke scripts that prove `bun install -g or3-node`, `or3-node launch`, approval, and first remote command work on a real machine.

## 16. Out of scope for the first cut

- [ ] Do not turn `or3-net` itself into the installed host daemon.
- [ ] Do not introduce a second sandbox daemon in the first implementation unless the internal host-control boundary proves insufficient.
- [ ] Do not promise hostile multi-tenant isolation on the host.
- [ ] Do not build a broad cluster scheduler redesign as part of the node-agent project.
- [ ] Do not require browser desktop support for the first usable release.
