# Mental Model

This document explains how to think about OR3 Net without needing to read the whole codebase first.

## The one-sentence model

OR3 Net is a **workspace-scoped execution control plane**.

It accepts authenticated requests, stores control-plane state, and routes execution to one of several runtime backends.

## The major layers

OR3 Net is easiest to understand as five layers.

### 1. Contracts

Contracts are the stable shapes used across the system.

Examples:

- job contracts
- runtime-session contracts
- platform auth and error envelopes
- preview contracts

These live under [src/contracts](../../src/contracts).

### 2. Control-plane services

These are the stateful services that coordinate behavior.

Examples:

- `AuthService`
- `LocalJobService`
- `SessionBindingService`
- `PreviewService`
- `RuntimeSessionService`
- `NodeRegistryService`
- `LeaseScheduler`

These mostly live under [src](../../src).

### 3. Persistence

OR3 Net persists control-plane state in SQLite through `ControlPlaneDatabase` and `WorkspaceStore`.

Persisted records include:

- workspaces
- jobs
- job events
- API keys
- network sessions
- runtime sessions
- runtime artifacts
- nodes and node credentials
- leases
- previews
- idempotency records

See [src/db/client.ts](../../src/db/client.ts) and [src/db/schema.ts](../../src/db/schema.ts).

### 4. Runtime backends

Execution does not happen inside the control plane itself.
The control plane delegates to runtime adapters.

Built-in adapters include:

- local container
- sandbox
- remote node

See [src/runtime/adapters](../../src/runtime/adapters).

### 5. External surfaces

These are how other systems talk to OR3 Net.

- the Bun HTTP API under `/v1/...`
- the built-in console at `/console`
- the package exports from [src/index.ts](../../src/index.ts)
- the SDKs under [sdk](../../sdk)

## The most important boundaries

### Workspace is the main isolation boundary

Almost everything important belongs to a workspace.

That includes:

- jobs
- API keys
- sessions
- nodes
- previews
- runtime sessions

This is why many routes start with `/v1/workspaces/:workspaceId/...`.

### Job and runtime session are different things

A **job** is a request to do work.
A **runtime session** is an execution environment.

A job might use a runtime session, but they are not the same abstraction.

### Network session and runtime session are different things

A **network session** represents the caller relationship.
It helps group jobs by client session identity.

A **runtime session** represents the environment where execution happens.

Do not treat them as interchangeable.

### Node and runtime adapter are different things

A **runtime adapter** is a control-plane integration surface.
A **node** is a remote execution worker.

For example:

- the remote-node adapter knows how to use approved nodes
- an individual approved node is the worker that actually runs something

## A typical flow

Here is the normal path from request to execution.

1. A caller authenticates or provides an existing OR3 bearer token.
2. OR3 Net resolves the caller to a workspace principal.
3. A job submission is validated and persisted.
4. A network session binding is resolved or created.
5. The control plane chooses a backend:
   - local intern flow
   - sandbox-backed flow
   - remote node flow
6. Stream events and terminal state are persisted.
7. The caller reads job state, stream output, or resulting artifacts.

## Why this architecture exists

This split gives OR3 Net a few important properties:

- **stable contracts** even when execution backends differ
- **local persistence** for observability and recovery
- **pluggable runtimes** through the runtime adapter interface
- **workspace scoping** for security and multi-tenant behavior
- **replayable control-plane state** such as jobs, sessions, and events

## What OR3 Net deliberately does not try to be

OR3 Net is not:

- a model provider SDK
- a frontend framework
- a universal cluster scheduler
- a replacement for sandbox or Intern services

It coordinates those systems rather than replacing them.

## Recommended reading order

- [Jobs and Sessions](jobs-and-sessions.md)
- [Runtimes and Nodes](runtimes-and-nodes.md)
- [HTTP API](../api/http-api.md)
