# OR3 Net Plan — Phased Roadmap

## Phase 0 — External prerequisites

- `or3-intern`: add internal service API for turns, subagents, streams, and abort.
- `or3-sandbox`: confirm the existing API is fully consumable from a TypeScript SDK and document any gaps.

## Phase 1 — Contracts and state

- Finalize host API types, node protocol types, SQLite schema, and SDK packaging layout in `or3-net`.

## Phase 2 — Local execution path

- Build auth, job submission, job state storage, SSE relay, and the thin `or3-intern` wrapper path.

## Phase 3 — Node control plane

- Add node enrollment, approval, credentials, heartbeats, scheduler, and lease lifecycle.

## Phase 4 — Sandbox-backed nodes

- Implement the `or3-sandbox` adapter, warm pool coordination, artifact staging, runtime reset flows, and service launch support via sandbox tunnels.

## Phase 4.5 — Files and preview model

- Add workspace file browsing contracts, static preview registration, live preview descriptors, and the preview launch/revoke model.
- Prefer direct static preview serving for file-backed sites where possible; use temporary tunnels for live services.

## Phase 5 — Chat plugin

- Ship the `or3-chat` plugin UI, token exchange flow, agent management, job submission, streaming job views, node/service launch actions such as `Open Dashboard`, and embedded pane previews with `Open in New Tab` fallback.

## Phase 6 — Harden and stabilize

- Add transport parity tests, workspace-isolation tests, drop/reconnect handling, and managed-mode policy gates.

## Phase 7 — Operator surfaces

- Add the Bun CLI deploy/admin flows and the minimal authenticated web console.

## Shipping notes

- Keep v1 small: one primary `or3-intern` per host, one workspace per host deployment default, and sandbox-backed nodes as the reference backend.
- Cross-package tasks live with the owning repo in `planning/or3-net-plan.md`.
- In v1, browser dashboard access for sandbox-backed services is expected to use `or3-sandbox`'s signed browser tunnel flow wrapped by `or3-net` launch endpoints.
- Static previews should stay in-chat when safe to embed; live dashboards can fall back to external launch when iframe embedding is not appropriate.