# OR3 Node Agent PTY Requirements

## Overview

This plan covers proper PTY support across `or3-node` and `or3-net` so remote runtime sessions can drive an actual terminal instead of the current pipe-backed placeholder.

Scope:

- replace the current fake PTY behavior in `or3-node` with a real PTY backend
- carry PTY lifecycle and streamed PTY events through the existing connected-node transport in `or3-net`
- expose PTY operations through the existing runtime-session path instead of inventing a second public machine-control API
- normalize PTY capability through the control plane as the extension capability `ext:or3:pty` while still accepting the node-side PTY signal from `or3-node`
- keep PTY capability-gated and truthful by platform

Assumptions:

- Context7 research shows Bun's Terminal API can provide real PTY behavior on Linux and macOS using `Bun.spawn({ terminal })`, `proc.terminal.write(...)`, `proc.terminal.resize(...)`, and `proc.terminal.close()`
- Bun's Terminal API does not support Windows, so Bun-only PTY cannot satisfy a full cross-platform PTY matrix
- the current repo stance already hides PTY on Windows, so the smallest correct implementation is Bun-only PTY for POSIX now and continued PTY disablement on Windows
- `node-pty` is only required if Windows PTY support becomes an in-scope requirement

## Requirements

### Req 1. Real PTY semantics on supported platforms

As a user, I want PTY-backed remote sessions to behave like a real terminal on supported hosts.

Acceptance criteria:

- `or3-node` PTY sessions allocate a real PTY on Linux and macOS instead of using `stdio: "pipe"`
- PTY-backed commands observe TTY semantics such as `isatty`, colored output, line editing, and interactive prompt behavior
- terminal resize requests change the PTY size used by the child process
- PTY close requests terminate or detach the terminal session according to documented behavior
- the implementation does not advertise PTY capability on unsupported platforms

### Req 2. Truthful capability and platform gating

As OR3 Net, I want PTY capability advertisement to match what the agent can actually run.

Acceptance criteria:

- `or3-node` only advertises `pty` when a real PTY backend is available and enabled
- Linux and macOS can advertise PTY once the Bun backend is wired end-to-end
- Windows keeps PTY disabled in manifests, info output, and runtime node capability projection for this phase
- unsupported PTY requests fail with explicit capability errors instead of hanging or silently degrading to pipes
- docs state clearly that Bun-only PTY is POSIX-only and that Windows PTY remains out of scope for this phase

### Req 3. End-to-end PTY control-plane transport

As the system, I want PTY open/input/resize/close/output/exit to flow across the existing node transport consistently.

Acceptance criteria:

- the node protocol supports request/response handling for `pty_open`, `pty_input`, `pty_resize`, and `pty_close`
- the node event protocol includes first-class PTY streaming events for output and exit, instead of relying on ambiguous exec-style output frames
- `or3-node` sends PTY output and PTY exit events over the live socket while the session is active
- `or3-net` validates, routes, and normalizes these PTY events without confusing them with one-shot exec streams
- disconnect cleanup closes or invalidates orphaned PTY sessions deterministically

### Req 4. Runtime-session integration through existing surfaces

As a user, I want PTY operations to be reachable through the existing runtime-session model in OR3 Net.

Acceptance criteria:

- `or3-net` extends the runtime adapter contract with optional PTY operations instead of adding a parallel remote-machine API family
- `or3-net` normalizes the control-plane PTY capability as `ext:or3:pty` while still projecting the node-side PTY signal from `or3-node`
- `RemoteNodeRuntimeAdapter` projects PTY only for nodes whose manifests advertise `pty`
- PTY open/input/resize/close operations are scoped to an existing runtime session and workspace
- the adapter returns clear errors for missing sessions, revoked nodes, disconnected agents, and unsupported capabilities
- existing non-PTY session behavior remains backward-compatible

### Req 5. Safe PTY defaults and bounded behavior

As an operator, I want PTY support to remain safe by default on trusted machines.

Acceptance criteria:

- PTY sessions respect configured cwd validation, environment allowlists, and max concurrent session limits
- PTY output is bounded or backpressured so long-lived sessions cannot grow memory without limit
- local logs do not leak secrets through debugging noise beyond current host-control policy expectations
- abrupt process exit, agent shutdown, and socket disconnect all trigger PTY cleanup
- the implementation documents what state is and is not recoverable after restart

### Req 6. Minimal control-plane and persistence churn

As a maintainer, I want PTY support added with the smallest viable architectural change.

Acceptance criteria:

- no new top-level public API family is introduced when existing runtime-session routes can own the behavior
- no SQLite schema migration is required unless a real persistence gap is discovered during implementation
- the design reuses current node transport, remote executor, and runtime adapter seams
- PTY state remains in-memory unless a specific restart or auditing requirement justifies persistence
- the plan calls out any intentionally deferred work, especially Windows PTY support

### Req 7. Regression coverage and operator documentation

As a developer, I want PTY implementation risks covered by focused tests and docs.

Acceptance criteria:

- `or3-node` has PTY tests that validate open, input, resize, exit, cleanup, and unsupported-platform behavior against the real backend contract
- `or3-net` has adapter and protocol tests that validate PTY capability gating, event routing, disconnect cleanup, and session-scoped authorization
- docs replace any stale implication that PTY is already fully implemented
- smoke docs describe how to verify PTY on Linux/macOS and how Windows is expected to behave
- release validation includes an interactive PTY pass on at least one supported POSIX host

## Non-functional constraints

- Prefer Bun-only implementation for this phase because it satisfies the current Linux/macOS support goal without introducing a native addon dependency
- Do not add `node-pty` unless the required support matrix expands to include Windows PTY or Bun proves insufficient in implementation
- Keep memory bounded for long-lived PTY sessions and avoid unbounded output buffering
- Preserve the current single-agent, low-complexity process model in `or3-node`
- Keep capability failures explicit and deterministic across reconnects and disconnects
- Reuse existing OR3 Net runtime-session and node transport seams instead of adding a new machine-control subsystem
