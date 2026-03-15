# HTTP API

This document explains the main OR3 Net HTTP API exposed by the control plane.

It is not generated reference documentation.
Instead, it is a practical guide to the route groups, authentication model, and common request flows.

## Base ideas

Most routes are scoped to a workspace:

- `/v1/workspaces/:workspaceId/...`

There are also a few global or quasi-global routes:

- `/v1/auth/exchange`
- `/v1/launch/:token`
- `/v1/jobs/:jobId...`
- `/console`

## Authentication model

OR3 Net accepts bearer auth in the standard `Authorization` header.

```http
Authorization: Bearer <token>
```

Two bearer formats are supported:

- **workspace token**: a signed OR3 token minted by `AuthService`
- **API key**: a stored workspace-scoped key looked up by hash

### Auth exchange

The route for exchanging upstream proof into an OR3 bearer token is:

- `POST /v1/auth/exchange`

It accepts provider-specific `session_proof` data and returns a workspace token.

Use this route when you already have identity proof from another auth system and need an OR3-native bearer token for the control plane.

## Error model

HTTP errors are normalized into a platform error envelope.
A typical response includes:

- `error`
- `code`
- `status`
- `request_id`
- optional `retry_after_ms`

A related `X-Request-Id` header is also included.

## Route groups

### Auth

- `POST /v1/auth/exchange`

Purpose:

- turn external session proof into an OR3 workspace token

### Jobs

- `GET /v1/workspaces/:workspaceId/jobs`
- `POST /v1/workspaces/:workspaceId/jobs`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/stream`
- `POST /v1/jobs/:jobId/abort`

Purpose:

- submit jobs
- list workspace jobs
- inspect a single job
- stream live output
- abort running work

Typical create-job input includes:

- session identity (`network_session_id`, or `client_kind` + `client_session_id`, or `session_key`)
- `message`
- optional `allowed_tools`
- optional metadata
- optional profile name
- execution target

### API keys

- `GET /v1/workspaces/:workspaceId/api-keys`
- `POST /v1/workspaces/:workspaceId/api-keys`
- `POST /v1/workspaces/:workspaceId/api-keys/:apiKeyId/revoke`

Purpose:

- create secondary credentials for workspace-scoped callers
- list issued keys
- revoke old credentials

### Sessions

- `GET /v1/workspaces/:workspaceId/sessions`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId`
- `GET /v1/workspaces/:workspaceId/sessions/:sessionId/events`

Purpose:

- inspect network-session bindings and their retained event history

### Runtime inventory

- `GET /v1/workspaces/:workspaceId/runtimes`
- `GET /v1/workspaces/:workspaceId/runtimes/:runtimeId`
- `GET /v1/workspaces/:workspaceId/runtimes/:runtimeId/nodes`

Purpose:

- inspect registered runtimes and the nodes they expose

### Runtime sessions

- `GET /v1/workspaces/:workspaceId/runtime-sessions`
- `POST /v1/workspaces/:workspaceId/runtime-sessions`
- `GET /v1/workspaces/:workspaceId/runtime-sessions/:sessionId`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/exec`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/stop`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/destroy`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/commit`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/discard`
- `GET /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/staging`
- `GET /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/logs`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-in`
- `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/files:copy-out`

Purpose:

- create and manage execution environments
- run commands inside them
- move files in and out
- inspect logs
- stage, commit, or discard host workspace changes

### Agents

- `GET /v1/workspaces/:workspaceId/agents`
- `POST /v1/workspaces/:workspaceId/agents`
- `GET /v1/workspaces/:workspaceId/agents/:agentId`
- `PUT /v1/workspaces/:workspaceId/agents/:agentId`
- `DELETE /v1/workspaces/:workspaceId/agents/:agentId`

Purpose:

- store reusable agent definitions inside a workspace

### Nodes and node services

- `GET /v1/workspaces/:workspaceId/nodes`
- `POST /v1/workspaces/:workspaceId/nodes/enroll`
- `POST /v1/workspaces/:workspaceId/nodes/:nodeId/approve`
- `GET /v1/workspaces/:workspaceId/nodes/:nodeId/services`
- `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/launch`
- `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/revoke`
- `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/restart`

Purpose:

- enroll and approve remote nodes
- inspect service capabilities published by nodes
- launch, revoke, or restart node-backed services

### Previews and launch tokens

- `GET /v1/workspaces/:workspaceId/previews`
- `POST /v1/workspaces/:workspaceId/previews`
- `POST /v1/workspaces/:workspaceId/previews/:previewId/launch`
- `POST /v1/workspaces/:workspaceId/previews/:previewId/revoke`
- `GET /v1/launch/:token`
- `GET /v1/launch/:token/:path*`

Purpose:

- register preview descriptors
- mint launch capabilities
- resolve file-backed or redirect-backed launch targets
- revoke access when preview state changes

## Common flows

### Flow: exchange auth and submit a job

1. `POST /v1/auth/exchange`
2. store returned bearer token
3. `POST /v1/workspaces/:workspaceId/jobs`
4. `GET /v1/jobs/:jobId/stream`

### Flow: create and use a runtime session

1. `POST /v1/workspaces/:workspaceId/runtime-sessions`
2. `POST /v1/workspaces/:workspaceId/runtime-sessions/:sessionId/exec`
3. optionally `files:copy-in` or `files:copy-out`
4. optionally `commit` or `discard`
5. `destroy`

### Flow: approve a node for remote execution

1. node submits manifest to `nodes/enroll`
2. operator approves via `nodes/:nodeId/approve`
3. control plane issues runtime credential
4. lease scheduler can start assigning jobs to the node

## Request IDs

OR3 Net uses request ids in both success and error paths to make debugging easier.
If a caller already has a request id, it should send `X-Request-Id`.
Otherwise the server creates one.

## Practical advice

- Treat workspace id as required context, not a cosmetic path segment
- Prefer job streaming for live UX, but use job records for durable state
- Use runtime sessions only when you need environment continuity
- Use previews and launch tokens for browser access instead of exposing raw backend URLs

## Related docs

- [Mental Model](../concepts/mental-model.md)
- [Jobs and Sessions](../concepts/jobs-and-sessions.md)
- [Runtimes and Nodes](../concepts/runtimes-and-nodes.md)
- [Intern SDK](../sdk/intern-sdk.md)
- [Sandbox SDK](../sdk/sandbox-sdk.md)
