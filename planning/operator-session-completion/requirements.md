# Operator Session Completion — Requirements

## Overview

This plan covers priorities 4–5 from the status report:

4. build missing operator surfaces
5. define the actual OR3-wide session model

The goal is to make `or3-net` operable as a real coordination layer, not just a job relay. That requires two things at the same time:

- operator-visible control-plane workflows for jobs, keys, nodes, and previews
- a shared session contract that explicitly links `or3-chat`, `or3-net`, and `or3-intern`

Scope includes:

- new host API, CLI, and console coverage
- session identifiers, ownership boundaries, and resumption semantics
- durable session/job event projections that let operators and client surfaces inspect what happened

Assumptions:

- `or3-chat` remains the user/session authority.
- `or3-intern` remains the execution and memory authority.
- `or3-net` becomes the canonical coordination layer for network session bindings, job routing, and operator-visible job/session state.
- Existing workspace isolation, job IDs, and session keys must remain backward-compatible.

## Requirements

### 1. `or3-net` must expose the minimum operator workflows over HTTP

**Requirement:** As an operator or SDK client, I need to list and manage the main control-plane resources without reading SQLite directly.

**Acceptance criteria:**

- The host API must expose workspace-scoped job listing with filterable terminal/running states.
- The host API must expose API key create/list/revoke flows for workspace operators.
- The host API must expose node approval state and basic node health visibility in a way the console and CLI can consume without bespoke SQL.
- The host API must expose enough preview/service visibility to answer which user-facing launch surfaces currently exist for a workspace.

### 2. The CLI and built-in console must cover the same operator workflows

**Requirement:** As an operator, I need CLI and console coverage for the minimum control-plane loops so that `or3-net` is supportable without custom scripts.

**Acceptance criteria:**

- The CLI must support job list, job inspect, job abort, API key create/list/revoke, and node approval visibility.
- The built-in console must show an authenticated overview of jobs, nodes, API keys, and previews/services.
- Console actions must call the same host API routes used by CLI/SDK consumers rather than bypassing auth or service layers.
- The console must let an operator answer: what is running, what failed, which nodes are approved, and which credentials or launch surfaces are active.

### 3. The OR3-wide session model must be explicit and durable

**Requirement:** As the OR3 platform, I need a shared session model so that chat, control plane, and execution all refer to the same session lifecycle instead of relying on convention.

**Acceptance criteria:**

- A canonical session contract must define the relationship between:
  - workspace ID
  - chat-side client session or thread identity
  - `or3-net` coordination session identity
  - `or3-intern` execution `session_key`
  - jobs launched under that session
- `or3-net` must persist a session binding or equivalent durable record that allows an existing session to be resumed after process restarts.
- A submitted job must be attributable to a resolved session binding rather than only carrying a raw `session_key` string with no host-side context.
- The session contract must define what resets and what persists across retries, reconnects, and workspace switches.

### 4. Session state must expose durable task and execution history

**Requirement:** As a user and operator, I need a durable session-visible task history so that restarts or disconnected clients do not erase what `or3-net` knows about work already performed.

**Acceptance criteria:**

- `or3-net` must persist normalized job/session events or an equivalent durable event projection for the events it emits to clients.
- The durable projection must allow reconstruction of a session’s recent task history, including job started/completed/failed/aborted transitions and normalized tool/progress output retained by policy.
- Session-aware inspection APIs must allow a client or operator to fetch recent jobs and event history for a session without replaying a live SSE stream.
- The durable projection must remain workspace-scoped and bounded by explicit retention limits.

### 5. Ownership boundaries across repos must be documented and enforced in code

**Requirement:** As a developer, I need a precise ownership model so that session, memory, and history do not drift between `or3-chat`, `or3-net`, and `or3-intern`.

**Acceptance criteria:**

- The session model must document which data is canonical in each repo:
  - `or3-chat` for user-facing thread/workspace identity and UI state
  - `or3-net` for network session binding, job routing, and operator-visible execution history
  - `or3-intern` for conversation history, memory retrieval, and execution internals
- `or3-net` must avoid duplicating `or3-intern` memory or full conversation storage while still keeping enough session linkage to support resume and inspection.
- Cross-repo docs must explain how `workspace switch`, `token exchange`, `job retry`, and `session resume` behave.

## Non-functional constraints

- Preserve backward compatibility for existing job routes, session keys, and workspace auth flows.
- Keep SQLite use simple and deterministic; prefer one additive session-binding/event-log model over multiple overlapping stores.
- Keep retained session/job event data bounded in volume and retention period.
- Maintain workspace isolation for sessions, events, jobs, nodes, previews, and API keys.
- Avoid leaking secrets, provider session proofs, raw node credentials, or sensitive tool outputs into broad operator surfaces.
- Reuse existing `src/api`, `src/db`, `src/execution`, `cli`, and `src/console` layers rather than introducing a separate admin service.
