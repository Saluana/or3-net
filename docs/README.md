# OR3 Net Documentation

This folder explains OR3 Net from three angles:

- **Concepts**: the mental model, architecture, and core entities
- **HTTP API**: what the control plane exposes over `/v1/...`
- **SDKs**: how to talk to Intern and Sandbox services from TypeScript

If you are new to the project, start here:

1. [Getting Started](getting-started.md)
2. [Mental Model](concepts/mental-model.md)
3. [Jobs and Sessions](concepts/jobs-and-sessions.md)
4. [Runtimes and Nodes](concepts/runtimes-and-nodes.md)
5. [HTTP API](api/http-api.md)
6. [Intern SDK](sdk/intern-sdk.md)
7. [Sandbox SDK](sdk/sandbox-sdk.md)

## What OR3 Net is

OR3 Net is a Bun/TypeScript control plane for workspace-scoped execution.
It sits between callers and execution backends.

At a high level it is responsible for:

- exchanging external session proof for OR3 bearer tokens
- accepting jobs inside a workspace
- persisting jobs, sessions, leases, nodes, previews, and runtime sessions
- routing work to local, sandbox, or remote-node runtimes
- exposing a stable HTTP API and reusable TypeScript SDK contracts

## Documentation map

- [Getting Started](getting-started.md)
- [Concepts](concepts/mental-model.md)
- [Jobs and Sessions](concepts/jobs-and-sessions.md)
- [Runtimes and Nodes](concepts/runtimes-and-nodes.md)
- [HTTP API](api/http-api.md)
- [Intern SDK](sdk/intern-sdk.md)
- [Sandbox SDK](sdk/sandbox-sdk.md)

## Design principles

These docs follow a few simple rules:

- explain **why** a concept exists before listing fields or methods
- keep the difference between **control plane**, **runtime**, **node**, and **SDK** explicit
- prefer realistic request and usage examples over abstract definitions
- call out important constraints, not just happy-path behavior

## Source of truth

The documentation in this folder is meant to match the current codebase, especially:

- [src/index.ts](../src/index.ts)
- [src/server.ts](../src/server.ts)
- [src/api/app.ts](../src/api/app.ts)
- [src/runtime/index.ts](../src/runtime/index.ts)
- [sdk/intern](../sdk/intern)
- [sdk/sandbox](../sdk/sandbox)
