# OR3-Net Status Report — 2026-03-11

## Executive Summary

`or3-net` is no longer just an idea. It already has a real Bun/TypeScript control-plane core with:

- stable contract types and validation
- SQLite-backed control-plane persistence
- auth exchange and workspace token enforcement
- local job submission, streaming, and abort against `or3-intern`
- node enrollment, approval, and lease issuance
- a sandbox-backed execution adapter
- preview/file/service-launch primitives
- a basic CLI, SDKs, and operator console
- a passing Bun test suite

That said, it is **not yet the fully integrated OR3 coordination layer** described in the broader platform vision.

The biggest current gap is that `or3-net` is strongest at **control-plane storage and basic APIs**, but still weak at **remote-node runtime control**, **cross-repo end-to-end integration**, **operator visibility**, and a **shared session model that spans OR3 Chat, OR3 Intern, and sandbox-backed execution**.

My current assessment:

- **Local control plane**: solid early v1 foundation
- **Remote node execution**: partial and not yet trustworthy enough for production scheduling
- **Cross-repo integration**: still incomplete
- **Observability/operator workflows**: partial
- **Security model**: good design direction, incomplete enforcement in remote paths

Overall: **`or3-net` looks like an advanced foundation / late prototype, not a complete unified platform yet.**

---

## How This Assessment Was Derived

This report is based on the current `or3-net` repository state as of 2026-03-11, including:

- planning docs in `planning/`
- control-plane implementation under `src/`
- SDKs under `sdk/`
- CLI in `cli/`
- Bun tests in `tests/`
- current hardening notes in `dumb-issues.md`

---

## What OR3-Net Already Has

### 1. Clear control-plane scope and contracts

The repo has a coherent planned shape and the implementation broadly follows it.

Shipped pieces include:

- core contract schemas for jobs, leases, agents, nodes, workspaces, task packages, and auth tokens
- package exports for app/server/auth/db/execution/nodes/previews/workspace file surfaces
- phase-based planning docs that match the implemented package structure reasonably well

This is important because `or3-net` already behaves like a control plane with explicit contracts rather than a pile of ad hoc handlers.

### 2. Real SQLite-backed state

The SQLite layer is one of the strongest parts of the repo.

It already persists:

- workspaces
- API keys
- nodes
- node credentials
- jobs
- leases
- agents
- previews

It also includes startup reconciliation and workspace-scoped stores, which is a strong base for tenant isolation and recoverability.

### 3. Auth exchange and scoped access control

`or3-net` already supports:

- short-lived workspace bearer tokens via `POST /v1/auth/exchange`
- workspace-scoped API key auth
- per-route scope enforcement for jobs, nodes, agents, files, previews, and services

This means the identity boundary exists in code already, even if the full multi-product identity story is not finished.

### 4. A working local job path

For the local path through `or3-intern`, `or3-net` already provides:

- job submission
- job persistence
- streaming via SSE
- abort forwarding to `or3-intern`
- event normalization into host job events

This is enough to prove the central “submit → run → stream → finish” control-plane loop.

### 5. Node registry and scheduler basics

There is already meaningful control-plane logic for remote execution preparation:

- signed manifest enrollment
- node approval
- credential issuance and rotation of older credentials
- scheduler lease selection based on approval/health/capabilities/isolation class

This is more than planning; it is a real first-pass node control plane.

### 6. Sandbox-backed execution and launch primitives

The sandbox adapter already supports:

- acquiring/releasing warm-pool sandboxes
- writing artifact text into a sandbox
- executing a shell task
- listing service capabilities from node manifests
- preparing service launches via sandbox tunnels
- restart flows for node-backed services

The preview/file side also exists and works for basic launch/revoke flows.

### 7. Tests are present and meaningful

This repo is not test-empty. It has targeted Bun tests for:

- auth + app routes
- contracts
- DB behavior
- local jobs
- nodes/scheduler
- previews/files/service launches
- SDK client parsing
- transports and warm pools

That materially increases confidence in the foundation.

---

## Where OR3-Net Is Still Incomplete

## 1. Unified session model is still thin

Your requested system view expects a session to unify:

- conversation history
- task state
- tool outputs
- execution logs
- saved memory

`or3-net` does **not** own that full session model today.

Current reality:

- `or3-net` knows about `workspace_id`, job IDs, API scopes, and an input `session_key`
- `or3-intern` still owns the actual execution session semantics
- `or3-chat` is still expected to own user-facing session/workspace identity
- no cross-repo durable session contract is visible here for shared state resumption, memory linkage, or conversation continuity

So the session story is currently **coordinated by convention**, not by a platform-wide shared contract.

### What that means

`or3-net` can coordinate execution requests, but it is not yet the authoritative glue for all user-visible session continuity. That remains a major integration gap.

---

## 2. Remote job control is still not production-safe

This is the highest-risk current gap.

The local path is decent, but the remote execution path still has major correctness issues:

- remote abort is still host-local only in `LocalJobService`
- remote execution handles are not tracked
- leases for remote jobs are issued but not released on completion/abort in the same flow
- the remote executor currently does a one-shot `execute` request and returns a result, with no durable streamed lifecycle control

### Why this matters

This breaks one of the most important promises of `or3-net`: that it can reliably mediate execution on remote nodes.

Right now, for remote work, the control plane can say “aborted” or “done” without actually owning the full lifecycle strongly enough.

That means OR3-Net is **not yet a trustworthy remote execution coordinator**, even though the storage and API layers are in place.

---

## 3. The node transport layer is still mostly skeletal

The transport abstraction exists, but it is still too thin for the architecture you described.

Current limitations:

- HTTPS transport posts JSON requests but does not consume issued node credentials
- outbound WSS is effectively just an injected handler abstraction
- streaming and abort semantics are not modeled as a first-class remote lifecycle
- transport parity is not truly established for long-running execution

### Result

The repo has the *shape* of dual-transport support, but not the full operational contract needed for a strong OR3 network.

---

## 4. Sandbox SDK coverage is far below the planned contract

The internal TypeScript sandbox SDK is currently a minimal slice, not a full `or3-sandbox` v1 client.

What exists today:

- create/get/delete sandbox
- exec + execStream
- writeFile
- createTunnel/listTunnels

What is still missing relative to the plan:

- list sandboxes
- lifecycle operations like start/stop/suspend/resume
- file read/delete/mkdir APIs
- tunnel revoke
- snapshots
- runtime info/health/capacity
- quota + metrics
- TTY/WebSocket support
- full wire compatibility verification against the live `or3-sandbox` API

This means the first backend adapter is useful for a narrow happy path, but the SDK is not yet a real authoritative wrapper for the sandbox platform.

---

## 5. Operator surfaces are still narrow

The project has a CLI and a built-in console, but both are currently limited.

### API gaps

Missing or incomplete operator-facing surfaces include:

- workspace-scoped job listing route
- API key create/list/revoke endpoints
- richer operational inspection routes for control-plane state

### CLI gaps

The CLI currently supports:

- auth exchange
- nodes list/enroll/approve
- jobs submit/get/stream
- agents list

But it does not yet expose:

- job list
- job abort
- API key management
- broader operator/admin workflows

### Console gaps

The console is currently a thin HTML page with:

- list nodes
- list agents
- list previews
- submit job
- launch/revoke/restart service

That is useful for smoke testing, but it is not yet the operational dashboard described in the vision.

---

## 6. Observability exists, but only at the control-plane minimum

You identified observability as central, and you were right.

Today `or3-net` has some observability primitives:

- job status persistence
- event streams for jobs
- node health state fields
- preview launch/revoke state

But it does **not yet deliver** the broader operator transparency model you outlined:

- no unified audit log surface
- no clear event timeline across auth, scheduling, node dispatch, tool execution, and preview/service launches
- no cost accounting model
- no built-in metrics/health dashboard for the network as a whole
- no clear “what changed?” operator narrative beyond low-level state reads

So observability is **present as raw mechanisms, not yet as a product surface**.

---

## 7. Security direction is good, but enforcement is uneven

The design direction is strong:

- scoped bearer tokens and API keys
- signed node manifests
- approval gating
- short-lived launch capabilities
- workspace-scoped storage
- managed-vs-OSS security planning

But several important policies are still not fully enforced end-to-end:

- node credentials are issued but not consumed by active transports
- certification data exists in the contract but is not used by the scheduler
- preview launch capability cleanup is still unbounded in memory
- malformed JSON still returns 500s in some cases instead of normalized 400s
- remote abort / lease lifecycle correctness is incomplete

So security architecture is **ahead of security completion**.

---

## Readiness Against The Requested Integration Requirements

## 1. Unified identity and permission model

**Status: Partially implemented**

What exists:

- token exchange boundary
- API key support
- scoped route checks
- workspace isolation in the DB layer

What is missing:

- end-to-end identity flow with `or3-chat`
- node credential use in transport
- full managed-mode certification enforcement
- stronger cross-repo permission alignment

Assessment: the permission model exists at the control-plane API layer, but not yet across the entire OR3 product path.

## 2. Clear session model

**Status: Not solved in `or3-net` yet**

What exists:

- job records
- streaming state
- `session_key` pass-through

What is missing:

- durable cross-product session contract
- resume semantics across UI/control-plane/execution
- memory linkage
- persistent execution-log/session-state model that spans repos

Assessment: this is still mostly an external dependency and architecture task.

## 3. Stable agent-sandbox tool contract

**Status: Partially implemented, not fully stable**

What exists:

- task package schema
- sandbox adapter
- basic SDK
- execution path for sandbox-backed jobs

What is missing:

- full `or3-sandbox` SDK coverage
- verified streaming compatibility
- robust remote abort + lifecycle handling
- transport/auth parity

Assessment: strong start, but not stable enough yet to be the critical platform contract.

## 4. Observability and transparency

**Status: Early foundation only**

What exists:

- job streaming
- status persistence
- basic console

What is missing:

- operator-grade job listing and inspection
- audit/event surfaces
- unified timeline view
- metrics/cost reporting

Assessment: enough for development, not enough for production trust.

---

## Cross-Repo Dependencies Still Blocking A Fully Integrated OR3-Net v1

## 1. `or3-chat` integration is still planning-level here

The v1 vision assumes `or3-chat` is the main user-facing client. In `or3-net`, that integration is still mostly represented as:

- planning assumptions
- token exchange design
- plugin-oriented route shapes

What is not visible here yet is the complete working product loop from chat UI → token exchange → job creation → stream view → service/preview open → abort → session resume.

## 2. `or3-intern` is still the owner of real session execution semantics

`or3-net` wraps `or3-intern`, but it does not replace its execution model. That means integration quality depends heavily on:

- the internal service API staying stable
- event semantics being locked down
- abort behavior being strong
- subagent capabilities being consistently available

Right now those contracts appear usable, but not completely frozen.

## 3. `or3-sandbox` API parity is still unfinished

The adapter depends on a smaller sandbox client than the planning docs expect. Until the SDK matches the real sandbox API better, the sandbox backend remains narrower than intended.

---

## Recommended Priority Order To “Bring The System Together”

## Priority 1 — Fix remote execution correctness

This is the top engineering priority.

Specifically:

- add real remote execution handles
- wire remote abort to actual backend cancellation
- ensure remote leases release in `finally` paths
- prevent conflicting terminal states after abort
- make remote streaming a first-class lifecycle, not a one-shot result

Without this, OR3-Net cannot safely be the network coordination layer for real remote work.

## Priority 2 — Finish transport/auth policy enforcement

- consume issued node credentials in active transports
- make outbound WSS a real correlated protocol path
- enforce certification policy in scheduling when managed mode is enabled
- fail clearly when policy eliminates all nodes

This closes the gap between “node registry exists” and “network execution is trustworthy.”

## Priority 3 — Bring sandbox SDK up to actual v1 scope

- align the SDK with the real `or3-sandbox` wire contract
- add missing lifecycle/file/tunnel/snapshot/runtime/quota/metrics methods
- verify streaming and TTY behavior

This is required if the sandbox is going to be the reference node backend.

## Priority 4 — Build missing operator surfaces

- add jobs list route
- add API key create/list/revoke routes
- extend the CLI for operator workflows
- expand the console into a real authenticated operations view

This is necessary for observability, supportability, and user trust.

## Priority 5 — Define the actual OR3-wide session model

This is the main architectural integration task across repos.

It should explicitly define:

- session ownership boundaries between chat, net, and intern
- durable identifiers and resumption semantics
- how tool outputs, logs, and memory references are preserved
- what state is canonical where

Until this is done, OR3 will still feel like integrated subsystems rather than one product.

## Priority 6 — Complete end-to-end chat integration

- implement and test the real `or3-chat` plugin flow
- verify token exchange across auth providers
- exercise live job/abort/preview flows end-to-end
- validate user-facing status visibility and permission boundaries

This is what will turn OR3-Net from a control-plane package into a product integration layer.

---

## Bottom Line

`or3-net` is already a **real control-plane codebase** with strong foundations in contracts, persistence, auth, and basic workflow routing.

It is **not** yet fully realized as the thing that makes OR3 feel like a single coherent platform.

Today it is best described as:

- a credible v1 foundation
- a functioning local execution wrapper
- a partial node control plane
- an incomplete remote execution coordinator
- an early operator surface

The system comes together once the following are true at the same time:

1. remote execution is lifecycle-correct
2. transports actually enforce auth/policy
3. the sandbox SDK matches reality
4. operator observability is much stronger
5. the OR3-wide session model is explicitly defined and integrated with `or3-chat` and `or3-intern`

Until then, OR3-Net is **promising and substantial**, but still short of the “single unified OR3 platform” goal.

---

## Suggested Next Work Items

If this report is used as the near-term execution guide, the next concrete tasks should be:

1. implement real remote abort + lease release
2. normalize malformed JSON to stable 400s
3. prune preview launch capability state
4. add jobs list + API key management HTTP routes
5. extend CLI and console to expose those routes
6. align the sandbox SDK with the live `or3-sandbox` API
7. lock the `or3-intern` tool-policy/session contract
8. build cross-repo end-to-end tests with `or3-chat`

