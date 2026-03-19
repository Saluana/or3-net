# OR3 Network v1 — Requirements

> Migration note: OpenSandbox is now the selected sandbox-style provider for `or3-net`. Older `or3-sandbox` wording in this requirements doc is retained only where historical prerequisite context still matters.

## Introduction

OR3 Network (`or3-net`) is a Bun/TypeScript control and communications layer that sits between client applications (starting with `or3-chat`) and the OR3 execution infrastructure (`or3-intern` + `or3-sandbox`). It provides:

- Workspace-scoped node registry and job scheduling
- Authenticated API wrapper around `or3-intern`'s agent execution
- TypeScript SDKs for `or3-intern`, `or3-sandbox`, and the OR3 node protocol
- CLI, minimal web console, and streaming job output
- A token-exchange auth model that supports `or3-chat` as the first client but is not coupled to it

Target deployment: internet-accessible private network, deployable on home computers, VPS, Docker containers, or any environment where Bun runs.

One workspace maps to one `or3-net` host and one primary `or3-intern` instance.

---

## Phase 0 — Prerequisites in Other Repos

> [!IMPORTANT]
> Before any `or3-net` implementation can begin, the following changes must ship in `or3-intern` and `or3-sandbox`.

### P0.1 or3-intern Internal Service API

**As** `or3-net`, **I want** to submit agent turns, spawn subagents, stream job output, and abort running jobs via a well-defined HTTP API on `or3-intern`, **so that** `or3-net` can orchestrate agent execution without being compiled into the same Go binary.

**Current state:** `or3-intern` is a Go CLI application with only in-process Go calls. There is no HTTP listener for programmatic turn submission. The `serve` command starts channel listeners and heartbeat, but does not expose a service API.

**Acceptance Criteria:**

- WHEN `or3-intern` is started in service mode, THEN it SHALL expose an authenticated HTTP API on a configurable port.
- WHEN `POST /internal/v1/turns` is called with a valid session key, message, and optional tool policy, THEN `or3-intern` SHALL execute a full agent turn (model call → tool loop → response) and return the result.
- WHEN `POST /internal/v1/subagents` is called with a valid task, prompt snapshot, and tool policy, THEN `or3-intern` SHALL enqueue and execute a bounded subagent turn.
- WHEN `GET /internal/v1/jobs/:jobId/stream` is called, THEN `or3-intern` SHALL stream the turn output as SSE events (text deltas, tool call events, completion).
- WHEN `POST /internal/v1/jobs/:jobId/abort` is called, THEN `or3-intern` SHALL cancel the running turn and return a confirmation.
- WHEN an unauthenticated or malformed request arrives, THEN `or3-intern` SHALL reject it with an appropriate HTTP error.
- The service API SHALL be authenticated by a shared secret or internal token, not exposed to end users.

### P0.2 or3-sandbox TypeScript SDK

**As** `or3-net`, **I want** a TypeScript client SDK that wraps the `or3-sandbox` HTTP API, **so that** the node adapter can manage sandbox lifecycles, execute commands, stream output, and transfer files from Bun/TypeScript code.

**Current state:** `or3-sandbox` exposes a complete REST API (`/v1/sandboxes`, `/v1/sandboxes/:id/exec`, `/v1/sandboxes/:id/tty`, `/v1/sandboxes/:id/files/*`, tunnels, snapshots, runtime health, capacity, quotas) with static-token and JWT auth. There is no TypeScript SDK — only the Go CLI `sandboxctl`.

**Acceptance Criteria:**

- The SDK SHALL provide typed clients for all `or3-sandbox` v1 API endpoints:
  - Sandbox CRUD: `create`, `list`, `get`, `delete`
  - Lifecycle: `start`, `stop`, `suspend`, `resume`
  - Execution: `exec` (sync and streaming), `tty` (WebSocket)
  - Files: `readFile`, `writeFile`, `deleteFile`, `mkdir`
  - Tunnels: `createTunnel`, `listTunnels`, `revokeTunnel`
  - Snapshots: `createSnapshot`, `listSnapshots`, `getSnapshot`, `restoreSnapshot`
  - Runtime: `runtimeInfo`, `runtimeHealth`, `runtimeCapacity`
  - Quotas: `getQuota`
  - Metrics: `getMetrics`
- The SDK SHALL support both static-token and JWT authentication.
- The SDK SHALL support SSE streaming for `exec` responses.
- The SDK SHALL support WebSocket connections for TTY sessions.
- The SDK SHALL be published as a standalone npm package (`@or3/sandbox-sdk`) or included in `or3-net` as an internal package.

### P0.3 or3-intern TypeScript SDK

**As** `or3-net`, **I want** a TypeScript client SDK that wraps the new `or3-intern` internal service API, **so that** `or3-net` can submit turns, spawn subagents, and stream job output from TypeScript.

**Acceptance Criteria:**

- The SDK SHALL provide typed clients for all `or3-intern` internal API endpoints:
  - `submitTurn(sessionKey, message, toolPolicy?)` → turn result
  - `spawnSubagent(task, promptSnapshot, toolPolicy)` → subagent job handle
  - `streamJob(jobId)` → async iterable of SSE events
  - `abortJob(jobId)` → confirmation
- The SDK SHALL handle SSE streaming natively.
- The SDK SHALL support shared-secret authentication.

---

## 1. Contracts & SDKs

### 1.1 Core Type Definitions

**As a** developer integrating with OR3 Network, **I want** well-defined TypeScript types for all OR3 Network contracts, **so that** I can develop against stable interfaces.

**Acceptance Criteria:**

- WHEN importing from `@or3/net`, THEN the following types SHALL be available:
  - `NodeManifest`: `node_id`, `pubkey`, `signature`, `adapter_kind`, `capabilities`, `isolation_class`, `supports_transports`, `resource_limits`, `lease_policy`, `certification`, `version`
  - `TaskPackage`: `workspace_id`, `job_id`, `kind`, `instructions`, `artifacts`, `tool_policy`, `timeout`, `lease_profile`, `subagent_policy`
  - `Lease`: `lease_id`, `node_id`, `profile`, `ttl`, `reset_required`, `state`
  - `Job`: `job_id`, `workspace_id`, `status`, `node_id`, `created_at`, `started_at`, `completed_at`, `result`
  - `Agent`: `agent_id`, `workspace_id`, `name`, `instructions`, `tool_policy`, `node_requirements`
  - `Workspace`: `workspace_id`, `name`, `created_at`
  - `AuthToken`: `token`, `workspace_id`, `expires_at`, `scopes`

### 1.2 SQLite Control-Plane State

**As** `or3-net`, **I want** lightweight control-plane state persisted in SQLite, **so that** workspace config, node registrations, job history, and lease state survive restarts.

**Acceptance Criteria:**

- WHEN `or3-net` starts, THEN it SHALL create or migrate the SQLite database.
- WHEN a node enrolls, THEN its manifest, approval status, and credentials SHALL be stored in SQLite.
- WHEN a job is submitted, THEN its metadata (workspace, node, status, timestamps) SHALL be tracked in SQLite.
- WHEN a lease is issued, THEN its profile, TTL, state, and reset status SHALL be stored in SQLite.
- WHEN `or3-net` restarts, THEN it SHALL reconcile in-progress jobs and expired leases.

---

## 2. or3-intern Wrapper Service

### 2.1 Authenticated Turn Submission

**As a** client (or3-chat plugin, CLI, SDK), **I want** to submit agent turns through `or3-net`'s API, **so that** I never need direct access to `or3-intern`.

**Acceptance Criteria:**

- WHEN `POST /v1/workspaces/:workspaceId/jobs` is called with a valid workspace token and job spec, THEN `or3-net` SHALL forward the turn to `or3-intern` via the internal SDK.
- WHEN the job completes, THEN `or3-net` SHALL record the result in SQLite and return it.
- IF the workspace token is invalid or expired, THEN the request SHALL be rejected with 401.

### 2.2 Job Streaming

**As a** client, **I want** to stream real-time output from a running job, **so that** I can show live progress to the user.

**Acceptance Criteria:**

- WHEN `GET /v1/jobs/:jobId/stream` is called, THEN `or3-net` SHALL proxy the SSE stream from `or3-intern`.
- WHEN the job completes or is aborted, THEN the stream SHALL terminate with a final status event.
- WHEN the client disconnects, THEN `or3-net` SHALL clean up the proxy connection.

### 2.3 Job Abort

**As a** client, **I want** to abort a running job, **so that** I can cancel long-running or stuck agent turns.

**Acceptance Criteria:**

- WHEN `POST /v1/jobs/:jobId/abort` is called with a valid token, THEN `or3-net` SHALL forward the abort to `or3-intern`.
- WHEN the abort succeeds, THEN the job status SHALL be updated to `aborted` in SQLite.

---

## 3. Node Agent/Adapter Layer

### 3.1 or3-sandbox Adapter

**As** `or3-net`, **I want** an adapter that wraps `or3-sandbox` to implement the OR3 node protocol, **so that** sandbox-backed environments can serve as the first node backend.

**Acceptance Criteria:**

- WHEN `or3-net` receives a job targeting a sandbox-backed node, THEN it SHALL:
  - Acquire a sandbox from the warm pool or create a new one
  - Write the task package artifacts to the sandbox workspace
  - Execute the instructions within the sandbox
  - Stream output back to the caller
  - Clean up the sandbox after completion
- WHEN the node protocol requires exec capability, THEN the adapter SHALL use the sandbox exec API.
- WHEN the node protocol requires file transfer, THEN the adapter SHALL use the sandbox file API.

### 3.2 OR3 Node RPC Schema

**As a** node implementer, **I want** a canonical RPC schema for the node protocol, **so that** I can build compatible nodes in any language.

**Acceptance Criteria:**

- The node RPC schema SHALL define the following operations:
  - `handshake(manifest)` → enrollment acknowledgment
  - `execute(task_package)` → execution stream
  - `heartbeat()` → node health status
  - `abort(job_id)` → abort confirmation
- The schema SHALL be transport-agnostic (works over HTTPS/WSS and outbound WSS).

---

## 4. Node Enrollment & Scheduling

### 4.1 Node Enrollment

**As a** node operator, **I want** to enroll my node with `or3-net` by submitting a signed manifest, **so that** the workspace administrator can review and approve it.

**Acceptance Criteria:**

- WHEN `POST /v1/workspaces/:workspaceId/nodes/enroll` is called with a signed `NodeManifest`, THEN `or3-net` SHALL:
  - Verify the manifest signature
  - Store the manifest with `pending` approval status
  - Pin the node's public key fingerprint
- IF the manifest signature is invalid, THEN the enrollment SHALL be rejected.
- IF the node ID already exists with a different public key, THEN the enrollment SHALL be rejected.

### 4.2 Manifest Approval

**As a** workspace administrator, **I want** to approve or reject enrolled nodes, **so that** only trusted nodes can execute jobs.

**Acceptance Criteria:**

- WHEN `POST /v1/workspaces/:workspaceId/nodes/:nodeId/approve` is called, THEN the node status SHALL change to `approved`.
- WHEN a node is approved, THEN `or3-net` SHALL issue short-lived credentials to the node.
- IF a previously approved node's manifest changes, THEN its status SHALL revert to `pending` and require re-approval.

### 4.3 Lease Scheduler

**As** `or3-net`, **I want** a lease scheduler that assigns jobs to available approved nodes based on capability matching and resource limits, **so that** jobs are dispatched efficiently.

**Acceptance Criteria:**

- WHEN a job is submitted, THEN the scheduler SHALL:
  - Match job requirements against node capabilities
  - Select a node with available capacity
  - Issue a lease with a bounded TTL
  - Track the lease state in SQLite
- WHEN a lease expires, THEN the node SHALL be reclaimed and the job marked as failed or retried.
- WHEN a node drops mid-job, THEN the lease SHALL recover cleanly and streams SHALL terminate predictably.

### 4.4 Short-Lived Credentials

**As** `or3-net`, **I want** to issue short-lived credentials to approved nodes after enrollment, **so that** nodes authenticate with time-bounded tokens instead of long-lived secrets.

**Acceptance Criteria:**

- WHEN a node is approved, THEN `or3-net` SHALL issue credentials with a configurable TTL.
- WHEN credentials expire, THEN the node SHALL re-authenticate before accepting new jobs.
- WHEN credentials are rotated, THEN existing leases SHALL not be interrupted.

### 4.5 Warm Pool Management

**As** `or3-net`, **I want** a warm pool of pre-reset sandbox nodes, **so that** jobs can start quickly without cold-start overhead.

**Acceptance Criteria:**

- WHEN a sandbox finishes a job, THEN `or3-net` SHALL hard-reset it before returning it to the warm pool:
  - Process kill
  - Filesystem/workspace scrub
  - Credential rotation
  - Health check before lease return
- WHEN a warm pool sandbox is leased, THEN it SHALL be verified healthy before assignment.
- Warm pools SHALL be scoped to a single workspace — never shared across workspaces.

### 4.6 Dual Transport Support

**As a** node operator, **I want** to connect my node using either host-dials-node (HTTPS/WSS) or node-dials-host (outbound WSS), **so that** nodes behind NAT or in home-lab environments can participate.

**Acceptance Criteria:**

- WHEN a node manifest declares `supports_transports: ["https"]`, THEN `or3-net` SHALL connect to the node over HTTPS/WSS.
- WHEN a node manifest declares `supports_transports: ["outbound-wss"]`, THEN `or3-net` SHALL accept the node's outbound WSS connection.
- Both transports SHALL produce identical behavior for the same node RPC contract.

---

## 5. Authentication & Authorization

### 5.1 Token Exchange

**As** an `or3-chat` user, **I want** to exchange my active OR3 Chat session for a short-lived `or3-net` workspace token, **so that** I can access `or3-net` APIs without managing separate credentials.

**Acceptance Criteria:**

- WHEN `POST /v1/auth/exchange` is called with a valid session proof from any OR3 Chat auth provider (Clerk, Supabase, etc.), THEN `or3-net` SHALL:
  - Validate the session against the issuing provider
  - Map the user to a workspace
  - Issue a short-lived `or3-net` bearer token
- WHEN the exchanged token expires, THEN the client SHALL re-exchange.
- The exchange endpoint SHALL be provider-agnostic — it validates session proofs, not specific JWT formats.

### 5.2 API Key Authentication

**As a** non-chat SDK/API client, **I want** to authenticate with `or3-net` using an API key, **so that** I can use `or3-net` without an `or3-chat` account.

**Acceptance Criteria:**

- WHEN an API request includes a valid `Authorization: Bearer <api-key>` header, THEN `or3-net` SHALL authenticate the request against the workspace's API key store.
- API keys SHALL be workspace-scoped and support configurable scopes/permissions.
- API keys SHALL be managed via the CLI or web console.

### 5.3 Workspace Isolation

**As a** workspace administrator, **I want** strict isolation between workspaces, **so that** one workspace cannot access another's nodes, jobs, or data.

**Acceptance Criteria:**

- WHEN Workspace A makes a request, THEN it SHALL NOT see, lease, or stream jobs from Workspace B.
- WHEN a node is enrolled in Workspace A, THEN it SHALL NOT be visible or schedulable by Workspace B.
- All node access SHALL be workspace-scoped.

---

## 6. or3-chat Plugin

### 6.1 Plugin Sidebar — Agent & Job Management

**As an** `or3-chat` user, **I want** a sidebar page for creating agents and submitting jobs to `or3-net`, **so that** I can manage my network agents from within OR3 Chat.

**Acceptance Criteria:**

- WHEN the user opens the OR3 Network sidebar, THEN they SHALL see:
  - A list of defined agents with their configurations
  - A form to create/edit agents (name, instructions, tool policy, node requirements)
  - A form to submit new jobs (select agent, provide input, configure timeout)
  - A list of recent jobs with status indicators
- WHEN the user creates a job, THEN the plugin SHALL call `or3-net`'s API with the exchanged workspace token.

### 6.2 Plugin Pane App — Live Job Output

**As an** `or3-chat` user, **I want** a pane app that shows live streaming output from running jobs, **so that** I can monitor agent execution in real time.

**Acceptance Criteria:**

- WHEN a job is running, THEN the pane app SHALL display live-streamed text output via SSE.
- WHEN the job completes, THEN the pane app SHALL show the final result with status.
- WHEN multiple jobs are running, THEN the user SHALL be able to switch between job streams.

### 6.3 Plugin Dashboard Settings

**As a** workspace administrator, **I want** a dashboard settings page for managing network configuration, **so that** I can approve nodes, manage API keys, and configure workspace settings from OR3 Chat.

**Acceptance Criteria:**

- WHEN the admin opens the Network settings, THEN they SHALL see:
  - Node approval queue (pending enrollments)
  - Approved nodes with status and capabilities
  - API key management (create, revoke)
  - Workspace network configuration

### 6.4 Custom Post Type — Saved Configs

**As a** user, **I want** to save network agent configurations, approved node presets, and deployment targets as custom posts in OR3 Chat, **so that** I can reuse and share them.

**Acceptance Criteria:**

- WHEN a user saves a network config, THEN it SHALL be stored as a custom post type in `or3-chat`.
- WHEN a user loads a saved config, THEN it SHALL pre-populate the job submission form.

---

## 7. Remote Subagents

### 7.1 Bounded Remote Subagent Execution

**As** `or3-net`, **I want** to execute bounded subagent turns on remote certified nodes, **so that** the primary agent can delegate work to specialized environments.

**Acceptance Criteria:**

- WHEN the primary agent issues a subagent turn, THEN `or3-net` SHALL:
  - Verify the target node is an approved certified node class
  - Bound the subagent with host-issued tool, host, path, timeout, and quota limits
  - Execute the turn on the remote node
  - Return the result to the primary agent
- Remote subagents SHALL NOT run as independent long-lived peer agents.
- Remote subagent execution SHALL be limited to approved node classes only.

### 7.2 Managed-Mode Allowlists

**As** `or3-net` in managed (or3-chat) mode, **I want** to enforce certified node class allowlists, **so that** only trusted node types can execute subagent turns.

**Acceptance Criteria:**

- WHEN running in managed mode, THEN only certified node manifests SHALL be schedulable.
- WHEN running in OSS mode, THEN any manually approved node SHALL be schedulable.
- WHEN an uncertified node type attempts to accept a job in managed mode, THEN the request SHALL be blocked.

---

## 8. CLI & Web Console

### 8.1 CLI

**As a** developer, **I want** a CLI for managing `or3-net` workspaces, nodes, jobs, and deployments, **so that** I can operate the network from the terminal.

**Acceptance Criteria:**

- The CLI SHALL support the following commands:
  - `or3-net init` — initialize a new workspace/config
  - `or3-net serve` — start the `or3-net` daemon
  - `or3-net nodes list` — list enrolled nodes
  - `or3-net nodes approve <nodeId>` — approve a pending node
  - `or3-net nodes revoke <nodeId>` — revoke a node
  - `or3-net jobs submit <agentId> <input>` — submit a job
  - `or3-net jobs list` — list jobs
  - `or3-net jobs stream <jobId>` — stream live output
  - `or3-net jobs abort <jobId>` — abort a running job
  - `or3-net agents create` — create an agent definition
  - `or3-net agents list` — list agents
  - `or3-net keys create` — create an API key
  - `or3-net keys list` — list API keys
  - `or3-net keys revoke <keyId>` — revoke an API key
  - `or3-net deploy` — deploy/manage the `or3-net` server
- The CLI SHALL use the same auth token flow as the API.

### 8.2 Minimal Web Console

**As an** operator, **I want** a minimal authenticated web console, **so that** I can monitor and manage `or3-net` without a CLI.

**Acceptance Criteria:**

- WHEN the operator accesses the web console URL, THEN they SHALL see:
  - Workspace overview (active nodes, running jobs)
  - Node management (enrollment queue, approved nodes)
  - Job list with status and streaming output
  - API key management
- The web console SHALL require authentication (API key or session token).
- The web console SHALL be served by the `or3-net` daemon itself (no separate frontend build required for v1).

---

## Non-Functional Requirements

### NF.1 Security

- All API communication SHALL use TLS in production.
- No full workspace mirroring to nodes — only explicit task packages.
- All node access SHALL be workspace-scoped.
- Credentials SHALL be short-lived and rotatable.

### NF.2 Reliability

- `or3-net` SHALL continue operating if a node drops mid-job.
- Leases SHALL recover cleanly on node failure.
- Streams SHALL terminate predictably on abort, timeout, or node failure.
- Job state SHALL survive `or3-net` restarts.

### NF.3 Performance

- SQLite with WAL mode for predictable low-overhead operations.
- Warm pools SHALL reduce job startup latency.
- Streaming SHALL have sub-second latency for text deltas.

### NF.4 Deployment

- `or3-net` SHALL be deployable as a single Bun binary.
- `or3-net` SHALL run on home computers, VPS instances, Docker containers, and cloud VMs.
- Configuration SHALL be file-based (JSON/TOML) with env var overrides.
