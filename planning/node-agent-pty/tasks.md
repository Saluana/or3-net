# OR3 Node Agent PTY Tasks

## 1. Lock scope and correct stale planning assumptions

- [ ] [Req 1, 2, 6, 7] Record the implementation decision in docs: Bun Terminal API is the default PTY backend for Linux/macOS; Windows PTY remains disabled for this phase.
- [ ] [Req 2, 7] Update stale docs in `or3-node` and related planning notes so they stop implying PTY is already fully implemented.
- [ ] [Req 6] Confirm there is no hidden requirement for Windows PTY in the current release target; if that changes, spin a follow-up plan that swaps the backend to `node-pty`.

## 2. Replace the fake PTY backend in `or3-node`

- [ ] [Req 1, 5] Refactor `or3-node/src/host-control/pty.ts` so PTY sessions are backed by `Bun.spawn({ terminal })` on Linux/macOS.
- [ ] [Req 1, 5] Preserve a narrow backend seam so a future `node-pty` backend can be introduced without changing the caller contract.
- [ ] [Req 1, 5] Reuse cwd and environment safety checks from the existing host-control path so PTY launch respects configured boundaries.
- [ ] [Req 5] Enforce max concurrent PTY sessions and deterministic cleanup on close, exit, and shutdown.

## 3. Finish PTY event handling in the agent loop

- [ ] [Req 3, 5] Update `or3-node/src/transport/agent-loop.ts` so PTY output and exit are emitted as explicit node event frames tied to `pty_id`.
- [ ] [Req 3] Remove placeholder logic around PTY output wiring and replace it with real output/exit callbacks from `HostPtyService`.
- [ ] [Req 3, 5] Ensure socket disconnect, agent stop, and PTY process exit all clean up in-memory PTY sessions.
- [ ] [Req 2] Re-enable PTY capability advertisement in `or3-node/src/runtime-capabilities.ts` only when the real backend is supported and enabled.
- [ ] [Req 2] Wire the PTY service into the default launch/runtime path in `or3-node/src/cli/index.ts` once the backend is real.

## 4. Extend the node protocol in `or3-net`

- [ ] [Req 3] Add PTY-specific event variants to `or3-net/src/contracts/protocol.ts` for streamed output and exit signaling.
- [ ] [Req 3] Keep the existing `pty_open`, `pty_input`, `pty_resize`, and `pty_close` request shapes stable unless implementation reveals a concrete missing field.
- [ ] [Req 3, 6] Update any node transport parsing, forwarding, or validation paths that currently assume only exec-style output events.

## 5. Add PTY surface to the runtime adapter contract

- [ ] [Req 4, 6] Extend `or3-net/src/contracts/runtime/adapter.ts` with optional PTY methods and PTY event/result types.
- [ ] [Req 4] Keep the PTY surface session-scoped and workspace-scoped so it fits the current runtime-session model.
- [ ] [Req 4, 6] Avoid a brand-new top-level machine-control API family if the existing runtime-session service and routes can expose the PTY calls.

## 6. Implement PTY projection in `RemoteNodeRuntimeAdapter`

- [ ] [Req 2, 4] Update `or3-net/src/runtime/adapters/remote-node.ts` so node capability projection includes `pty` only when the manifest advertises it.
- [ ] [Req 4] Implement PTY open/input/resize/close forwarding through the connected-node request path.
- [ ] [Req 3, 4] Implement PTY output and exit streaming back through the runtime-session layer.
- [ ] [Req 4, 5] Map disconnected-node, revoked-node, missing-session, and missing-PTY failures to clear runtime errors.

## 7. Expose PTY through existing runtime-session routes

- [ ] [Req 4, 6] Extend the current runtime-session API/service path in `or3-net/src/api/**` and related runtime session services to support PTY operations.
- [ ] [Req 4] Keep authorization and workspace scoping identical to existing runtime-session operations.
- [ ] [Req 4, 6] Ensure non-PTY adapters remain unaffected because the PTY methods are optional and capability-gated.

## 8. Add focused regression coverage

- [ ] [Req 7] Update `or3-node/tests/host-control-pty.test.ts` to validate real PTY contract behavior rather than the current pipe-backed scaffold.
- [ ] [Req 7] Add `or3-node/tests/agent-loop.test.ts` coverage for PTY output events, resize, close, and disconnect cleanup.
- [ ] [Req 7] Add `or3-net/tests/runtime/adapters/remote-node.test.ts` coverage for PTY capability gating and request forwarding.
- [ ] [Req 7] Add cross-repo or integration coverage for session create -> PTY open -> input -> resize -> close -> exit.
- [ ] [Req 7] Add an unsupported-platform regression so Windows continues to fail clearly and stays hidden.

## 9. Update docs and release checks

- [ ] [Req 2, 7] Update `or3-node/README.md` and any smoke or operations docs with the supported PTY matrix and verification steps.
- [ ] [Req 7] Update release validation docs so PTY is exercised on Linux/macOS and explicitly expected to be unavailable on Windows.
- [ ] [Req 7] Mark the original broad PTY task in `or3-net/planning/node-agent/tasks.md` as superseded or note that the real implementation is tracked in this plan.

## 10. Out of scope for this phase

- [ ] [Req 2, 6] Do not add Windows PTY support in this phase.
- [ ] [Req 6] Do not add PTY session persistence or resumable PTYs across restart.
- [ ] [Req 6] Do not create a separate public machine-control API family if runtime-session routes can carry the feature.
- [ ] [Req 6] Do not introduce `node-pty` unless Bun PTY fails against an in-scope POSIX requirement or the support matrix expands to require Windows PTY.
