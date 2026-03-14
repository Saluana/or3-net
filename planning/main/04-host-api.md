# OR3 Net Plan — Host API

## API style

- Versioned HTTP API under `/v1`.
- JSON for command/query endpoints.
- SSE for live job output.
- Workspace-scoped bearer auth for end users and API clients.

## Auth endpoints

### `POST /v1/auth/exchange`

Exchanges an OR3 Chat session proof for a short-lived workspace token.

Request:

- provider/session proof payload
- optional desired workspace hint

Response:

- bearer token
- workspace id
- expiry
- granted scopes

## Workspace file and preview endpoints

### `GET /v1/workspaces/:workspaceId/files`

Lists files and directories within the workspace sandbox boundary.

This endpoint is for workspace-owned storage, not arbitrary host filesystem access.

### `GET /v1/workspaces/:workspaceId/files/*path`

Reads or downloads a file from the workspace sandbox.

### `GET /v1/workspaces/:workspaceId/previews`

Returns static and live preview descriptors for the workspace.

Typical preview entries include:

- static site output suitable for pane embedding
- generated artifact previews
- live web services that can be launched externally or embedded when allowed

### `POST /v1/workspaces/:workspaceId/previews`

Registers a static or known previewable output for the workspace.

### `POST /v1/workspaces/:workspaceId/previews/:previewId/launch`

Returns preview launch metadata, including whether the preview should be embedded in a pane or opened externally.

Response fields may include:

- `launch_url`
- `embed_url`
- `delivery_mode`
- `supports_iframe`
- `supports_new_tab`
- `expires_at`

### `POST /v1/workspaces/:workspaceId/previews/:previewId/revoke`

Revokes the current preview launch capability or preview exposure.

## Node endpoints

### `GET /v1/workspaces/:workspaceId/nodes`

Returns visible nodes and approval/health metadata for the workspace.

### `POST /v1/workspaces/:workspaceId/nodes/enroll`

Accepts a signed `NodeManifest` and stores it as `pending` until approved.

### `POST /v1/workspaces/:workspaceId/nodes/:nodeId/approve`

Approves a node and issues short-lived node credentials.

### `GET /v1/workspaces/:workspaceId/nodes/:nodeId/services`

Returns the services/apps that `or3-net` knows how to expose for the selected node, including readiness and launchability metadata.

Typical entries:

- `openclaw` dashboard on a known target port
- future sandbox-backed app UIs exposed by explicit service descriptors

### `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/launch`

Mints a short-lived launch URL for a known node-backed service.

Request:

- optional launch mode hint (`new_tab`, `pane`, `external_browser`)
- optional path hint when the service contract explicitly allows subpaths

Response:

- `launch_url`
- `expires_at`
- `reused_tunnel`
- `service_status`

For sandbox-backed nodes in v1, this endpoint creates or reuses a private `or3-sandbox` tunnel and returns a signed browser URL rather than exposing raw sandbox tunnel credentials directly to the browser.

## Agent endpoints

### `GET /v1/workspaces/:workspaceId/agents`

Lists saved agent definitions for the workspace.

### `POST /v1/workspaces/:workspaceId/agents`

Creates or updates an agent definition with instructions, tool policy, and node requirements.

## Job endpoints

### `POST /v1/workspaces/:workspaceId/jobs`

Creates a job, selects local or remote execution, and returns the accepted job handle.

### `GET /v1/jobs/:jobId`

Returns status, timestamps, routing metadata, and final result metadata when complete.

### `GET /v1/jobs/:jobId/stream`

SSE stream for text deltas, tool/progress events, terminal completion, and error/abort events.

### `POST /v1/jobs/:jobId/abort`

Requests cancellation and returns the current terminal or transitional state.

## Service launch semantics

- The public API is service-oriented, not tunnel-oriented, for normal end-user flows.
- `or3-net` may still expose operator/admin tunnel management endpoints later, but the primary browser UX should be `launch service`.
- `launch_url` is intentionally opaque so `or3-net` can change its backing implementation later (direct sandbox signed URL in v1, `or3-net`-fronted proxy in a future hardened deployment).
- OpenClaw is the reference case: the launch URL should be browser-ready, including any app-specific fragment/bootstrap data required for first load.
- Static previews may expose both `embed_url` and `launch_url`, allowing `or3-chat` to keep users in a pane app when iframe embedding is allowed.

## Event model

Minimum stream event set:

- `job.accepted`
- `job.started`
- `text.delta`
- `tool.call`
- `tool.result`
- `job.completed`
- `job.aborted`
- `job.failed`

## Tunnel and launch events

Recommended audit-visible event set for service launches:

- `service.launch.requested`
- `service.launch.ready`
- `service.launch.failed`
- `service.tunnel.created`
- `service.tunnel.reused`
- `service.tunnel.revoked`

## v1 constraints

- Keep the host API thin; execution policy remains inside `or3-intern`.
- Do not expose raw sandbox control routes on the public host API.
- Prefer explicit job polling + SSE over a large custom real-time protocol.
- Prefer launching known services/apps over exposing generic port-forwarding UX to normal users.