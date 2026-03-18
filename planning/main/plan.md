# OR3 Network v1 Plan

> Migration note: OpenSandbox is now the primary sandbox-style backend for `or3-net`. Historical references to `or3-sandbox` in this plan should be read as superseded unless a section explicitly discusses prior architecture.

## Summary

- Build `or3-net` as a Bun/TypeScript control and communications layer with:
  - a thin authenticated wrapper around `or3-intern`
  - a workspace-scoped node registry and scheduler
  - TypeScript SDKs for `or3-intern`, `or3-sandbox`, and the OR3 node protocol
  - a CLI plus a minimal authenticated web console
- Target deployment is an internet-accessible private network.
- One workspace maps to one `or3-net` host and one primary `or3-intern` host runtime.
- `or3-chat` remains the identity source for its own users/workspaces, but `or3-net` must also support non-chat SDK/API clients.
- `or3-chat` integration ships as a plugin only: sidebar page, pane app, dashboard settings, and a custom post type for saved network/agent configs.
- `or3-chat` integration should support both embedded pane previews for static output and external launch flows for heavier live services.

## Repo Responsibilities

- `or3-chat`
  - Own user auth, workspace membership, and provider-agnostic session resolution.
  - Ship an OR3 Network plugin that exchanges the active OR3 Chat session for a short-lived `or3-net` workspace token.
  - Provide UI for agent creation, approved-node selection, job status, and saved network config objects.
  - Never call nodes directly.
- `or3-net`
  - Own the external host API, CLI, minimal web console, node registry, manifest approval flow, lease scheduler, job routing, deployment metadata, and TS SDKs.
  - Persist lightweight control-plane state in its own SQLite database.
  - Supervise or connect to the workspace’s `or3-intern` instance through an internal SDK/API.
  - Expose an open node protocol for OSS, while enforcing certified allowlists in managed OR3 Chat environments.
- `or3-intern`
  - Remain the execution authority for agent turns, tool loops, quotas, profile enforcement, subagent policies, and audit.
  - Add a service-facing API/SDK surface for `or3-net`; do not expose raw node control directly to `or3-chat`.
- `or3-sandbox`
  - Remain a per-node sandbox control plane.
  - Serve as the first concrete backend behind the OR3 node protocol via an adapter, not as the long-term public node contract.

## Communication Design

- `or3-chat plugin -> or3-net`: authenticated HTTP plus SSE/WebSocket streaming.
- `or3-net -> or3-intern`: internal authenticated service API; loopback by default when co-located.
- `or3-net <-> nodes`: one canonical OR3 node RPC schema with two transports in v1:
  - host-dials-node over HTTPS/WSS
  - node-dials-host over outbound WSS for NAT/home-lab cases
- `or3-net -> sandbox-backed node`: through a Bun adapter that wraps the `or3-sandbox` SDK.
- Task dispatch uses explicit task packages only: instructions, selected artifacts, bounded context, declared tool allowances, timeout, and lease requirements.
- Remote nodes may run bounded host-issued subagent turns, but not independent long-lived peer agents.

## Security Model

- Node enrollment requires:
  - a mandatory signed manifest
  - manual operator approval
  - pinned node public key/fingerprint
  - short-lived issued credentials after approval
- Managed OR3 Chat only schedules to certified node classes/manifests; OSS protocol remains open.
- Reusable runtimes use warm pools with hard reset before reuse:
  - process kill
  - filesystem/workspace scrub
  - credential rotation
  - health check before lease return
- No full workspace mirroring to nodes.
- All node access is workspace-scoped; nodes are never shared across workspaces.
- Remote subagents are allowed only on approved node classes and must inherit host-issued tool, host, path, timeout, and quota bounds.

## Public APIs / Contracts

- `or3-net` host API
  - `POST /v1/auth/exchange`
  - `GET /v1/workspaces/:workspaceId/nodes`
  - `POST /v1/workspaces/:workspaceId/nodes/enroll`
  - `POST /v1/workspaces/:workspaceId/nodes/:nodeId/approve`
  - `POST /v1/workspaces/:workspaceId/agents`
  - `POST /v1/workspaces/:workspaceId/jobs`
  - `GET /v1/jobs/:jobId`
  - `GET /v1/jobs/:jobId/stream`
  - `POST /v1/jobs/:jobId/abort`
- `or3-intern` service API additions
  - `POST /internal/v1/turns`
  - `POST /internal/v1/subagents`
  - `GET /internal/v1/jobs/:jobId/stream`
  - `POST /internal/v1/jobs/:jobId/abort`
- OR3 node contract
  - `NodeManifest`: `node_id`, `pubkey`, `signature`, `adapter_kind`, `capabilities`, `isolation_class`, `supports_transports`, `resource_limits`, `lease_policy`, `certification`, `version`
  - `TaskPackage`: `workspace_id`, `job_id`, `kind`, `instructions`, `artifacts`, `tool_policy`, `timeout`, `lease_profile`, `subagent_policy`
  - `Lease`: `lease_id`, `node_id`, `profile`, `ttl`, `reset_required`, `state`
- `or3-chat` plugin data model
  - custom saved config post type for network agents, approved node presets, and deployment targets

## Implementation Phases

1. Define contracts in `or3-net`, build TS SDKs, and add SQLite-backed control-plane state.
2. Add `or3-intern` internal service API and `or3-net` wrapper service.
3. Implement OR3 node agent/adapter layer with `or3-sandbox` as the first backend.
4. Add node enrollment, manifest approval, short-lived credentials, lease scheduler, and streaming jobs.
5. Ship the `or3-chat` plugin UI and provider-agnostic token exchange.
6. Add bounded remote subagent execution on certified node classes.
7. Add CLI deploy flows and the minimal web console.

## Planning Files To Create In `or3-net`

- `planning/01-responsibilities.md`
- `planning/02-communication-architecture.md`
- `planning/03-security-model.md`
- `planning/04-host-api.md`
- `planning/05-node-protocol.md`
- `planning/06-chat-plugin.md`
- `planning/07-phased-roadmap.md`
- `planning/08-files-tunnels-previews.md`
- `planning/tasks.md`

## Cross-Package Planning Files

- `or3-chat/planning/or3-net-plan.md`
- `or3-intern/planning/or3-net-plan.md`
- `or3-sandbox/planning/or3-net-plan.md`

## Tests And Acceptance

- OR3 Chat auth exchange works with every existing OR3 Chat auth provider.
- Workspace A cannot see, lease, or stream jobs from Workspace B.
- Unapproved or manifest-changed nodes are rejected.
- Both transports behave identically for the same node RPC contract.
- Warm pooled workers are scrubbed before reassignment.
- Explicit task-package limits are enforced; undeclared workspace data never reaches nodes.
- `or3-sandbox` adapter can run deterministic jobs and bounded remote subagent turns.
- `or3-net` continues operating if a node drops mid-job; leases recover cleanly and streams terminate predictably.
- Managed-mode allowlist blocks uncertified node types while OSS mode allows manual approval.

## Assumptions And Defaults

- `or3-net` is Bun/TypeScript.
- `or3-net` owns lightweight control-plane state in SQLite for v1.
- `or3-chat` integration is plugin-first; no core workflow executor refactor in the first shipping plan.
- `or3-net` is a thin wrapper around `or3-intern`, not a replacement for it.
- Remote subagents are bounded, host-issued, and certified-node-only.
- Warm pools are allowed within one workspace host only, never across workspaces.
