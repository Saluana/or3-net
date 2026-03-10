# OR3 Network v1 — Tasks

## 1. External prerequisites

- [x] [Req P0.1] Track the `or3-intern` internal service API work in `/Users/brendon/Documents/or3-intern/planning/or3-net-plan.md` and keep `or3-net` assumptions aligned with the final endpoint/auth shape.
- [ ] [Req P0.2] Confirm the existing `or3-sandbox` HTTP API is sufficient for a TypeScript SDK; record any missing contract or documentation gaps in `/Users/brendon/Documents/or3-sandbox/planning/or3-net-plan.md`.
- [ ] [Req P0.3] Finalize the `or3-intern` TypeScript SDK surface in `or3-net` only after the service API event model and auth header scheme are frozen.

## 2. Contracts and project skeleton

- [ ] [Req 1.1] Create the `or3-net` package layout for contracts, SDKs, host API handlers, scheduler, node registry, CLI, and console.
- [ ] [Req 1.1, 3.2] Define and export stable TypeScript contracts for `NodeManifest`, `TaskPackage`, `Lease`, `Job`, `Agent`, `Workspace`, and `AuthToken`.
- [ ] [Req 1.1, 3.2] Add validation and serialization rules for host API payloads and node protocol payloads.
- [ ] [Req 1.1, 6.1] Define preview/file contracts for workspace file entries, preview descriptors, launch metadata, and iframe eligibility.

## 3. SQLite control-plane state

- [ ] [Req 1.2] Define SQLite schema and migrations for workspaces, API keys, nodes, node credentials, jobs, leases, and agent definitions.
- [ ] [Req 1.2, 4.3] Implement startup reconciliation for in-progress jobs, expired leases, and stale node heartbeats.
- [ ] [Req 1.2, 5.3] Add workspace-scoped query helpers so every state transition is tenant-safe by construction.
- [ ] [Req 1.2, 6.1] Add storage for preview descriptors, preview expiry/revocation state, and file-backed preview metadata.

## 4. Host auth and public API

- [ ] [Req 2.1, 5.1, 5.2] Implement auth middleware for exchanged workspace tokens and workspace API keys.
- [ ] [Req 5.1] Implement `POST /v1/auth/exchange` with provider-agnostic session proof validation hooks.
- [ ] [Req 2.1, 2.2, 2.3] Implement job create/get/stream/abort routes and durable status transitions.
- [ ] [Req 4.1, 4.2, 4.4] Implement node list/enroll/approve routes and short-lived credential issuance.
- [ ] [Req 6.1] Implement agent CRUD routes sized for the first chat plugin workflow.
- [ ] [Req 6.1] Implement node service list/launch routes so `or3-chat` can open dashboards like OpenClaw via an opaque `launch_url`.
- [ ] [Req 6.1] Implement workspace file list/read routes and preview list/launch/revoke routes for static and live previews.

## 5. Scheduler and node lifecycle

- [ ] [Req 4.3] Implement capability matching, node selection, lease issuance, and lease timeout handling.
- [ ] [Req 4.5] Implement warm pool tracking, hard-reset workflow, health verification, and failed-reset quarantine.
- [ ] [Req 4.6] Implement transport abstraction so HTTPS/WSS and outbound WSS share one RPC contract and scheduler path.

## 6. Execution backends

- [ ] [Req 2.1, 2.2, 2.3] Implement the `or3-intern` wrapper path for local execution and SSE relay.
- [ ] [Req 3.1] Implement the sandbox-backed node adapter using the `or3-sandbox` SDK for lifecycle, exec, file staging, and cleanup.
- [ ] [Req 3.1, 3.2] Build task-package assembly and execution-event normalization for local and remote backends.
- [ ] [Req 3.1, 6.1] Implement sandbox service launch support: create/reuse private tunnels, request short-lived signed browser URLs, and return browser-ready launch metadata.
- [ ] [Req 6.1] Implement static preview serving or registration for file-backed sites so generated output can be embedded without requiring a live service tunnel.
- [ ] [Req 6.1] Treat sandbox-backed execution as the default for generated live services; if host-local service execution is ever supported, gate it behind an explicit development-only opt-in.

## 7. Client surfaces

- [ ] [Req 6.1] Build the Bun CLI for auth, node administration, job submission, and streaming inspection.
- [ ] [Req 6.1] Build the minimal authenticated web console for operators and workspace admins.
- [ ] [Req 6.1] Coordinate plugin delivery through `/Users/brendon/Documents/or3/or3-chat/planning/or3-net-plan.md` rather than embedding chat-specific UX work in `or3-net`.
- [ ] [Req 6.1] Add service-oriented node actions (`Open Dashboard`, `Revoke Access`, optional `Restart Service`) before exposing any lower-level tunnel management UI.
- [ ] [Req 6.1] Add embedded pane preview support for static sites with `Open in New Tab` fallback for apps that cannot or should not be framed.

## 8. Security and policy hardening

- [ ] [Req 4.1, 4.2, 4.4, 5.3] Enforce signature verification, approval gates, workspace isolation, and credential rotation.
- [ ] [Req 3.2, 4.5] Enforce explicit task-package boundaries and reset-before-reuse safeguards.
- [ ] [Req 5.1, 5.2] Add scope checks and expiry handling for exchanged tokens and API keys.
- [ ] [Req 5.3, 6.1] Ensure launch endpoints mint only short-lived browser capabilities and never return raw sandbox bearer credentials to end-user clients.
- [ ] [Req 5.3, 6.1] Enforce iframe embedding rules, preview URL expiry, frame-ancestor restrictions, and revocation semantics for embedded previews.

## 9. Tests and acceptance

- [ ] [Req P0.3, 2.2, 2.3] Add SDK and host API tests for job submit/stream/abort flows.
- [ ] [Req 4.1, 4.2, 4.6] Add node enrollment, manifest change, credential expiry, and transport parity tests.
- [ ] [Req 5.3] Add workspace isolation regression tests across jobs, nodes, leases, and streams.
- [ ] [Req 4.3, 4.5] Add scheduler and warm-pool recovery tests for node drop, lease expiry, and reset failures.
- [ ] [Req 6.1] Add end-to-end tests covering chat plugin token exchange, job creation, live stream viewing, and abort.
- [ ] [Req 6.1] Add end-to-end tests for service launch: authorized dashboard open, expired launch URL, revoked tunnel, and workspace/user mismatch rejection.
- [ ] [Req 6.1] Add end-to-end tests for static previews in pane mode, `Open in New Tab` fallback, iframe denial cases, and preview revoke/expiry handling.

## 10. Out of scope for v1

- [ ] Do not add multi-host federation, node-to-node mesh execution, or broad public runtime management APIs.
- [ ] Do not move execution policy, memory, or audit ownership out of `or3-intern`.
- [ ] Do not assume agent-generated user-facing services run on the raw `or3-intern` host by default.