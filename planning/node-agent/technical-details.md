# OR3 Node Agent Technical Details

## Overview

This document turns the node-agent plan into concrete technical decisions.

It exists to answer questions like:

- what exactly should `or3-node launch` do?
- what state lives on the machine versus in `or3-net`?
- what protocol should exist between the control plane and the agent?
- what should be optimized for user experience, developer experience, and performance?

This file is intentionally more prescriptive than [planning/node-agent/design.md](planning/node-agent/design.md).

One of the main decision filters in this document is: prefer solutions that make the agent fit naturally into existing `or3-net` seams, with the least new control-plane code necessary.

---

## 0. Compatibility and control-plane minimization

### Decision 0.1 — Reuse existing `or3-net` seams first

Before adding any new server-side subsystem, prefer extending what `or3-net` already has:

- `src/contracts/core.ts` for node manifests and lease profiles
- `src/contracts/protocol.ts` for internal node RPC
- `src/nodes/registry.ts` for enrollment, approval, and runtime credentials
- `src/nodes/transport*.ts` for remote transport resolution
- `src/nodes/executor.ts` for remote execution dispatch
- `src/runtime/adapters/remote-node.ts` for remote runtime projection
- `src/api/app.ts` for the existing node and runtime-session public routes

### Why

This gives the best chance of shipping the node agent without rewriting the control plane.

### Decision 0.2 — Do not create a second public API family for machine control

Do not add a new top-level `machine-control` or `node-agent` browser/client API in `or3-net` unless a specific gap is proven.

Prefer:

- existing node admin routes for enrollment/approval/bootstrap support
- existing runtime-session routes for machine-backed session behavior
- existing preview/launch flows for browser-facing service access

### Why

The more new public API surface added to `or3-net`, the more docs, auth, tests, and long-term compatibility burden the project takes on.

### Decision 0.3 — Make most new protocol work internal, not public

If the node agent needs richer verbs, add them inside the existing internal node protocol rather than exposing them directly as new client-facing control-plane APIs.

### Why

Internal protocol evolution is much cheaper than public API expansion.

---

## 1. Product and packaging decisions

### Decision 1.1 — Ship the CLI as `or3-node`

Use:

- package name: `or3-node`
- executable name: `or3-node`
- source project folder: can still be `or3-node-agent/`

### Why

This is the shortest install path and the least confusing command surface.

Good:

```bash
bun install -g or3-node
or3-node launch
```

Less good:

```bash
bun install -g or3-node-agent
or3-node-agent init
or3-node-agent enroll
or3-node-agent run
```

### UX impact

- easier to remember
- easier to document
- looks like a real product, not an internal helper

### DX impact

- source folder can still keep the more precise internal name
- package naming stays decoupled from repo folder layout

### Performance impact

None directly, but simpler packaging reduces install friction and support burden.

---

## 2. CLI shape decisions

### Decision 2.1 — `or3-node launch` is the primary command

The normal lifecycle should begin with `or3-node launch`.

That command should:

1. load config
2. create identity if missing
3. prompt for missing bootstrap inputs or read them from flags/env
4. enroll if needed
5. poll or wait for approval as configured
6. fetch/store runtime credential
7. connect to `or3-net`
8. start the main agent loop

### Why

Users want one obvious command. They do not want to learn your internal state machine before they can control a computer.

### Required flags

At minimum:

- `--url <control-plane-url>`
- `--token <bootstrap-token>`
- `--workspace <workspace-id>` or equivalent if bootstrap flow requires it
- `--foreground`
- `--name <node-display-name>`

### Recommended support commands

- `or3-node launch`
- `or3-node doctor`
- `or3-node status`
- `or3-node reset`
- `or3-node service install`
- `or3-node service uninstall`

### Commands to avoid making mandatory

- `init`
- `enroll`
- `connect`
- `start`

These are fine as debugging tools, but they should not be required for the common flow.

---

## 3. First-run UX decisions

### Decision 3.1 — First run should be interactive by default

If required state is missing, `or3-node launch` should prompt for it.

Prompt only for:

- control-plane URL
- bootstrap token or claim token
- optional node name
- optional allowed root or workspace path

Everything else should have good defaults.

### Why

Users installing on a VPS or laptop want success fast. Prompting for five values is acceptable. Requiring manual config file creation is not.

### Decision 3.2 — Persist config after successful launch

After a successful first launch, write a local config file and local state file.

Recommended locations:

- macOS/Linux config: `~/.config/or3-node/config.json`
- macOS/Linux state: `~/.local/share/or3-node/state.db`
- Windows equivalents via platform-appropriate directories

### Why

- repeat launches become trivial
- service install can reuse the same config
- debugging is easier because the state is inspectable

### Decision 3.3 — `doctor` should be a first-class support command

`or3-node doctor` should answer:

- is config present?
- is identity present?
- is node enrolled?
- is node approved?
- is credential valid?
- can the agent reach `or3-net`?
- is the outbound socket connected?
- what capabilities are currently enabled?

### Why

This is one of the highest-leverage DX and support features in the entire project.

---

## 4. Identity and enrollment decisions

### Decision 4.1 — Generate one persistent node keypair locally

Generate a public/private signing keypair on first run and keep it stable until explicit reset.

Use it for:

- manifest signing
- stable node identity continuity
- debugging and operator trust

### Why

Rotating identity every reinstall or restart makes approval and trust hard to reason about.

### Decision 4.2 — Use short-lived bootstrap tokens for enrollment

Do not make the long-lived agent run with a full workspace bearer token.

Instead:

- `or3-net` issues a short-lived bootstrap token
- `or3-node launch` redeems it once during enrollment
- approved runtime credentials are stored separately afterward

### Why

This sharply limits blast radius while keeping the onboarding flow simple.

### Decision 4.3 — Approval stays manual or explicit in `or3-net`

A newly enrolled node should remain `pending` until approved.

### Why

This keeps trust decisions in the control plane and prevents surprise machine access from any token holder who can reach the bootstrap path.

---

## 5. Runtime credential decisions

### Decision 5.1 — Use a narrow node runtime credential after approval

After approval, the agent should authenticate with a node-specific runtime credential, not the bootstrap token.

### Why

The bootstrap token is for enrollment.
The runtime credential is for ongoing operation.
Mixing them makes rotation and revocation harder.

### Decision 5.2 — Persist credential with expiry metadata

Store:

- token value
- expires_at
- last refresh time
- last auth failure

### Why

This allows:

- proactive refresh
- clear auth debugging
- clean reconnect behavior

### Decision 5.3 — Refresh early

If refresh is supported, attempt refresh when less than 20% of TTL remains.

If refresh is not supported in v1, surface a clear warning and reconnect failure mode instead of silently dying.

### Why

This reduces avoidable downtime without adding much complexity.

---

## 6. Control-plane connection decisions

### Decision 6.1 — Use outbound WSS as the default production transport

The agent should maintain a long-lived outbound authenticated WebSocket to `or3-net`.

### Why

This is the best balance of:

- NAT/firewall compatibility
- low-latency bidirectional communication
- PTY support later
- heartbeat and presence tracking
- simple browser-independent topology

It also minimizes `or3-net` code churn because `outbound-wss` already exists conceptually in the current node transport model.

### Decision 6.2 — Keep HTTPS only as a fallback / dev transport

HTTPS can support:

- simple request/response execution
- testing
- early bring-up

But it should not be the primary shape for connected nodes.

### Why

HTTPS-only polling is worse for:

- presence
- PTY
- streaming latency
- service/tunnel coordination

### Decision 6.3 — Separate connection session from node identity

The node identity is long-lived.
The live WSS session is ephemeral.

Track both distinctly.

Recommended server-side concepts:

- enrolled node record
- approved credential record
- connected session record

### Why

This prevents bugs where disconnects look like identity loss or approval loss.

---

## 7. Server-side connection hub decisions

### Decision 7.1 — Add a real connected-node hub inside `or3-net`

The current `transport-wss` abstraction should become a live hub that:

- authenticates agent sockets
- binds them to `(workspaceId, nodeId)`
- exposes request/reply dispatch
- supports event streaming back into jobs/runtime sessions
- tracks last heartbeat and last disconnect reason

### Why

Without this, `or3-net` cannot treat connected agents as first-class runtime backends.

The key implementation rule is to keep this hub narrow: it should be an execution/transport bridge, not a new scheduler, auth system, or persistence layer.

### Decision 7.2 — One active connection per node by default

If a second connection appears for the same node id:

- either reject it
- or replace the old one explicitly and record the event

Recommended default: replace old, log loudly.

### Why

This avoids ghost sessions and ambiguous routing.

### Decision 7.3 — Route all remote work through the hub

`RemoteNodeExecutor` and `RemoteNodeRuntimeAdapter` should both dispatch through the same connected-node transport hub.

### Why

One transport path means:

- fewer codepaths
- less drift between jobs and runtime sessions
- easier testing

This also prevents a second remote-control pathway from growing beside the existing executor/runtime adapter model.

---

## 8. Agent host-control decisions

### Decision 8.1 — Keep a strict internal `HostControlService` boundary

Even if v1 ships as one binary, the machine-control layer should be isolated behind a small internal interface.

Suggested capabilities:

- exec
- abort
- session create/destroy
- session exec/logs
- file read/write/copy
- PTY open/input/resize/close
- optional service/tunnel open/close

### Why

This gives the best long-term DX because:

- machine-control logic stays testable
- a future split to `sandboxd` stays possible
- platform-specific code stays contained

### Decision 8.2 — `argv` first, shell second

Default execution should use explicit `argv: string[]`.
Shell mode should be opt-in.

### Why

This is safer, more portable, and easier to reason about.

### Decision 8.3 — Track host features as manifest capabilities

Do not assume every installed node supports every operation.

Examples:

- `exec`
- `file-read`
- `file-write`
- `copy-in`
- `copy-out`
- `pty`
- `service-expose`
- `desktop-launch`

### Why

This keeps OR3 Net’s existing capability-driven model intact.

---

## 9. Execution model decisions

### Decision 9.1 — Use bounded, evented exec handles

Each exec should have:

- stable exec id
- start time
- optional session id
- status
- stdout preview
- stderr preview
- truncation flags
- exit code / signal / timeout state

### Why

This supports both live UX and post-hoc debugging.

### Decision 9.2 — Stream stdout/stderr incrementally

The agent should emit incremental output events while also maintaining bounded previews.

Recommended behavior:

- chunk on line boundaries when possible
- flush on timer for long partial lines
- cap total retained bytes per stream

### Why

This improves UX without unbounded memory growth.

### Decision 9.3 — Enforce limits locally in the agent

Do not rely only on `or3-net` to enforce:

- timeout
- stdout cap
- stderr cap
- stdin size cap
- concurrent execs

### Why

The machine-side process is where resource abuse actually happens.

### Decision 9.4 — Prefer spawn-based execution over shell wrappers

Avoid routing normal exec through `sh -lc` or platform equivalents unless shell mode is explicitly requested.

### Why

This avoids quoting bugs, improves portability, and reduces hidden behavior.

---

## 10. Runtime-session decisions

### Decision 10.1 — Reuse one transport path for jobs and runtime sessions

Do not invent a separate networking stack for runtime sessions.

Use the same connected-node channel with distinct internal RPC methods.

### Why

This reduces complexity and keeps remote machine control coherent.

It also avoids large changes in `or3-net`, because both leased jobs and runtime sessions can continue to rely on the same core transport and executor abstractions.

### Decision 10.2 — First remote runtime-session cut should be small

Support only:

- create session
- get session
- destroy session
- exec in session
- get logs

Defer:

- snapshots
n- commit/discard staging semantics unless truly needed
- advanced environment cloning

### Why

The product goal is “control a computer,” not “rebuild a full sandbox platform on day one.”

### Decision 10.3 — Treat remote session continuity as a host-control concern

For machine-backed runtime sessions, continuity should mean:

- stable session id
- stable cwd/environment defaults if configured
- stable process/log context

It does not need to imply a heavyweight VM/container lifecycle.

### Why

This keeps the feature lightweight and fast on real machines.

---

## 11. File access decisions

### Decision 11.1 — Use explicit allowed roots

Default file access should be constrained to configured allowed roots.

Recommended default:

- one operator-chosen workspace root
- optionally the user home directory only if explicitly enabled

### Why

This is the safest way to make file access useful without accidentally turning the agent into a full-disk API.

### Decision 11.2 — Separate text convenience from binary transfer

Recommended API semantics:

- text read/write for small workflow files
- binary copy-in/copy-out for larger payloads

### Why

This simplifies clients and keeps limits easy to understand.

### Decision 11.3 — Stream large transfers

Do not buffer large uploads/downloads fully in memory.

### Why

Better performance, lower RAM usage, fewer failure spikes.

---

## 12. PTY decisions

### Decision 12.1 — PTY should be capability-gated and WSS-only

PTY requires duplex low-latency communication. Use the live socket.

### Why

It is the cleanest protocol fit and avoids bolting interactive behavior onto polling.

### Decision 12.2 — PTY protocol should stay tiny

Client → agent messages:

- `input`
- `resize`
- `close`

Agent → client/control-plane messages:

- `output`
- `exit`
- `error`

### Why

Small protocols are easier to debug and less likely to ossify badly.

### Decision 12.3 — Linux first, platform-gated elsewhere

Support Linux first for the best PTY story.
Keep macOS/Windows explicit about supported shell and PTY behavior.

### Why

Pretending full parity too early creates support pain.

---

## 13. Service exposure decisions

### Decision 13.1 — Do not expose raw host ports as the main UX

The agent can advertise service targets, but browser-facing access should remain controlled by `or3-net` launch tokens and preview flows.

### Why

This preserves the control-plane security model and gives users revocation + expiry.

### Decision 13.2 — Service exposure should be explicit per service, not generic port forwarding by default

Recommended model:

- node advertises named launchable services
- agent resolves service target on request
- `or3-net` mints launch capability

### Why

This is safer and more product-friendly than “open any port you want.”

---

## 14. Storage decisions

### Decision 14.1 — Use simple local SQLite by default

Use SQLite for agent-local state.

Store at least:

- config snapshot
- identity metadata
- credential metadata
- recent exec metadata
- recent connection errors
- optional PTY/session metadata

### Why

- easy to inspect manually
- cross-platform enough for the product
- low operational complexity

### Decision 14.2 — Keep the schema intentionally small

Avoid storing:

- full output forever
- giant execution history forever
- duplicated control-plane source-of-truth records

### Why

Keeps startup fast and storage understandable.

### Decision 14.3 — Use capped retention

Recommended:

- recent exec metadata only
- recent failure logs only
- prune old ephemeral rows on startup and periodically

### Why

Predictable disk usage and faster local queries.

---

## 15. Observability decisions

### Decision 15.1 — Make local status inspectable from the CLI

`or3-node status` should show:

- node id
- control-plane URL
- approval state
- credential expiry
- connection state
- enabled capabilities
- recent error

### Why

Most operators debug via the CLI first.

### Decision 15.2 — Prefer readable logs over fancy telemetry in v1

Structured logs are enough.

Recommended fields:

- timestamp
- component
- node_id
- workspace_id when known
- connection_id
- exec_id / session_id when relevant
- event name
- short error code

### Why

This gives excellent local debuggability without overbuilding metrics infrastructure.

### Decision 15.3 — Distinguish failure classes explicitly

At minimum:

- config error
- bootstrap error
- approval pending
- credential error
- connection error
- exec error
- capability mismatch
- path violation

### Why

Users should not have to reverse-engineer “something failed.”

---

## 16. Performance decisions

### Decision 16.1 — Optimize for low idle overhead

A connected but idle node agent should use:

- one long-lived socket
- minimal timers
- small in-memory registries
- lazy initialization for PTY/tunnel subsystems

### Why

Many agents may sit idle most of the time.

### Decision 16.2 — Avoid unbounded in-memory buffering

Do not keep full stdout/stderr or transfer payloads in RAM.

Use:

- stream forwarding
- capped preview buffers
- streaming file I/O
- bounded queues

### Why

This is the main performance/safety invariant.

### Decision 16.3 — Connection backoff should be jittered

Reconnect attempts should use exponential backoff with jitter.

Recommended envelope:

- start: 1 second
- cap: 30 seconds
- reset backoff after stable connection period

### Why

Prevents thundering herds and noisy logs.

### Decision 16.4 — Use one request/reply dispatcher per connection

Multiplex all live RPCs over the one WSS connection using request ids.

### Why

- lower overhead
- simpler routing
- fewer sockets
- easier pressure control

### Decision 16.5 — Bound concurrency explicitly

The agent should have config for:

- max concurrent execs
- max concurrent PTYs
- max concurrent service launches
- max outbound transfer streams

### Why

This keeps machines responsive and failure behavior predictable.

---

## 17. Cross-platform decisions

### Decision 17.1 — Linux is the reference platform

Linux should get the most complete first implementation:

- exec
- file access
- PTY
- service exposure

### Why

Best fit for servers, containers, and common automation workflows.

### Decision 17.2 — macOS and Windows should support core control first

Initial parity target:

- exec
- bounded file access
- basic status and connectivity

PTY and service exposure can be capability-gated as they mature.

### Why

This is the best balance between product reach and implementation realism.

---

## 18. Developer experience decisions

### Decision 18.1 — Keep protocol contracts in `or3-net`

Canonical protocol schemas should live with the control plane in `src/contracts/**` and be consumed by the agent package.

### Why

Prevents contract drift.

It also keeps the amount of new glue code small because the agent can consume the existing contracts package directly instead of forcing a second contract source of truth.

### Decision 18.2 — Build local fake-agent and fake-control-plane harnesses early

Provide test harnesses for:

- fake connected node
- fake control-plane socket
- fake host-control service

### Why

This will dramatically speed iteration and reduce integration-only bugs.

### Decision 18.3 — Add end-to-end smoke scripts early

Minimum smoke path:

1. install package
2. run `or3-node launch --url ... --token ...`
3. approve node
4. execute command
5. abort command
6. reconnect after restart

### Why

Remote-control products live or die on real-world bring-up.

---

## 19. Recommended v1 implementation order

### Phase A — User-facing install path

- package `or3-node`
- bin entry
- `launch`, `doctor`, `status`, `reset`
- config/state persistence

### Phase B — Trust bootstrap

- keypair generation
- bootstrap token redeem
- node enrollment
- approval + runtime credential retrieval

### Phase C — Live transport

- outbound WSS
- connected-node hub in `or3-net`
- heartbeat + reconnect

Implementation note: this phase should extend the current `src/nodes/transport-wss.ts` and related executor wiring, not replace the node transport system with a brand-new stack.

### Phase D — Real machine control

- exec
- abort
- bounded streaming output
- recent exec status

### Phase E — Runtime-session bridge

- create/get/destroy session
- exec in session
- logs

Implementation note: extend `RemoteNodeRuntimeAdapter` first; do not add a separate remote-machine orchestration layer in `or3-net`.

### Phase F — Nice next capabilities

- file operations
- PTY
- named service exposure

This order gives the fastest path to a useful product while preserving the right architecture.

---

## 20. Final recommendation

If a decision conflicts with raw architectural purity, prefer the option that makes this flow excellent:

```bash
bun install -g or3-node
or3-node launch
```

That is the north star.

The second priority is keeping the control-plane contract coherent so `or3-net` still owns trust, auth, leases, and browser launch.

The third priority is performance through bounded queues, one live socket, stream-based I/O, and low idle overhead.
