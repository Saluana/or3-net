# OR3 Net Plan — Responsibilities

## Purpose

This file turns the long-form requirements into a clear ownership split so implementation work lands in the correct repository.

## Package ownership

### `or3-net`

- Own the public host API, CLI, minimal web console, SQLite control-plane state, node registry, lease scheduler, warm pool coordination, and TypeScript SDK packaging.
- Own the canonical OR3 node protocol definitions and transport adapters.
- Own workspace-scoped job metadata, node approval state, lease state, and API key storage.
- Never replace `or3-intern`'s execution/runtime policy logic.

### `or3-chat`

- Own end-user auth, session resolution, workspace membership, and provider-specific login UX.
- Ship the OR3 Network plugin UI, token exchange client flow, saved network/agent config UX, and streaming job views.
- Never talk directly to nodes or `or3-sandbox`; all execution goes through `or3-net`.

### `or3-intern`

- Remain the execution authority for turns, tool loops, subagent policy, quotas, memory, and audit.
- Add a service-facing API that `or3-net` can call, without turning `or3-intern` into a general public web app.
- Preserve existing CLI-first workflows (`chat`, `serve`, `agent`) while exposing a bounded internal service surface.

### `or3-sandbox`

- Remain the sandbox control plane and runtime manager.
- Continue owning lifecycle, exec, files, TTY, tunnels, snapshots, quotas, and metrics.
- Avoid coupling its public API to `or3-net`-specific concepts; `or3-net` integrates through an adapter/SDK.

## Cross-package boundaries

- `or3-chat -> or3-net`: user-facing auth exchange, agent/job UX, and streaming views.
- `or3-net -> or3-intern`: internal authenticated service API only.
- `or3-net -> or3-sandbox`: typed SDK + sandbox-backed node adapter.
- `or3-net <-> remote nodes`: one transport-agnostic node protocol with HTTPS/WSS and outbound WSS variants.

## Explicit non-goals for v1

- No direct `or3-chat -> or3-intern` orchestration path.
- No node-to-node mesh or peer scheduling.
- No multi-workspace sharing of warm pooled runtimes.
- No redesign of `or3-intern` memory, tool, or audit internals beyond what the service API needs.