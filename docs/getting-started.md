# Getting Started with OR3 Net

This guide is for developers who want to understand what OR3 Net does and how to run it locally.

## The short version

OR3 Net is a control plane.
It does not do the actual model inference or sandboxing by itself.
Instead, it coordinates:

- **authentication**
- **workspace-scoped jobs**
- **network sessions**
- **runtime session lifecycle**
- **remote node enrollment and leasing**
- **preview and service-launch capabilities**

If you remember one thing, remember this:

> OR3 Net receives a request in the context of a workspace, persists the request as control-plane state, and then routes execution to the right backend.

## Install

```bash
bun install
```

## Validate the repo

```bash
bun run typecheck
bun run lint
bun test
```

## Common entry points

### Package entry

The public package surface re-exports from [src/index.ts](../src/index.ts).

### HTTP server

The simplest server entry point is [src/server.ts](../src/server.ts).
It exposes:

- `createServerApp(...)`
- `startServer(...)`

### CLI

The repo also includes a CLI entry under [cli](../cli).
This is useful for manual auth, job, and node workflows.

## First concepts to learn

Before diving into endpoints or classes, understand these concepts:

- **Workspace**: the isolation boundary for jobs, API keys, sessions, previews, and runtimes
- **Job**: a unit of work submitted to the control plane
- **Network session**: a durable binding between a caller and related jobs
- **Runtime session**: an execution environment managed through the runtime adapter contract
- **Node**: a remote execution worker that can be enrolled and approved
- **Lease**: a short-lived assignment of a node to a job
- **Preview**: a launchable URL or file-backed browser target

Read these next:

- [Mental Model](concepts/mental-model.md)
- [Jobs and Sessions](concepts/jobs-and-sessions.md)
- [Runtimes and Nodes](concepts/runtimes-and-nodes.md)

## Typical local development flow

A practical local setup usually looks like this:

1. create a `ControlPlaneDatabase`
2. create an `AuthService`
3. create a `LocalJobService`
4. optionally register runtime adapters such as local container or sandbox
5. start the HTTP server with `startServer(...)`

In other words, the control plane is assembled from services rather than hidden behind global state.

## Where to look next

- For route-level behavior, see [HTTP API](api/http-api.md)
- For internal-turn and subagent requests, see [Intern SDK](sdk/intern-sdk.md)
- For sandbox lifecycle and exec APIs, see [Sandbox SDK](sdk/sandbox-sdk.md)
