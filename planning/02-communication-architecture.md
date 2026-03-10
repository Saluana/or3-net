# OR3 Net Plan — Communication Architecture

## Topology

`or3-net` sits between user-facing clients and execution infrastructure:

- Clients: `or3-chat` plugin, CLI, third-party SDK/API users.
- Execution backends: primary `or3-intern` plus approved nodes.
- First node backend: sandbox-backed nodes via `or3-sandbox`.

## Primary flows

### 1. Chat-driven execution

1. `or3-chat` resolves the active session/workspace.
2. The plugin exchanges that session proof for a short-lived `or3-net` workspace token.
3. The plugin submits an agent job to `or3-net`.
4. `or3-net` stores job metadata, schedules execution, and streams status/output back over SSE.

### 2. Local execution via `or3-intern`

1. `or3-net` validates the workspace token.
2. The scheduler determines the job should run on the workspace's primary `or3-intern`.
3. `or3-net` calls the internal `or3-intern` service API.
4. `or3-intern` executes the turn and streams events back to `or3-net`.
5. `or3-net` persists final status and relays the stream/result to the client.

### 3. Remote execution via approved nodes

1. `or3-net` matches job requirements against approved node manifests.
2. It issues a bounded lease and builds a task package.
3. The selected node receives `execute(task_package)` over the canonical node protocol.
4. `or3-net` proxies execution events back to the client and updates job/lease state in SQLite.

For user-facing generated apps and APIs, the intended default is that the running process lives inside the workspace sandbox boundary (or sandbox-backed node), not on the raw `or3-intern` host.

### 4. Browser service launch via sandbox tunnel

1. A user in the `or3-chat` plugin selects a running node-backed service such as OpenClaw and clicks `Open Dashboard`.
2. `or3-chat` calls a workspace-authenticated `or3-net` launch endpoint rather than talking to the node or `or3-sandbox` directly.
3. `or3-net` verifies the user can access that workspace, node, and service instance.
4. For sandbox-backed nodes, `or3-net` creates or reuses a private tunnel in `or3-sandbox` for the target port.
5. `or3-net` asks `or3-sandbox` for a short-lived signed browser URL so the browser receives only a tunnel-scoped capability, not raw sandbox credentials.
6. `or3-net` returns an opaque `launch_url` to `or3-chat`, which opens it in a new tab or pane.
7. The browser lands on the sandbox tunnel bootstrap flow, receives the narrow capability cookie, and is redirected into the app.

This keeps the browser-facing mental model at the `service/app` layer while using `or3-sandbox` tunnels under the hood.

## Transport choices

- Client API: HTTPS + SSE, with WebSocket only where interactive streaming requires it later.
- `or3-net -> or3-intern`: internal HTTP + SSE on a shared-secret authenticated service API.
- `or3-net <-> node`: same RPC contract over either host-dials-node HTTPS/WSS or node-dials-host outbound WSS.
- `or3-net -> or3-sandbox`: typed HTTP/SSE/WebSocket SDK.
- Browser service access: short-lived launch URL returned by `or3-net`; tunnel proxying is handled by `or3-sandbox` in v1 for sandbox-backed nodes.

## Communication rules

- Streams are end-to-end relayable: no custom per-client event format unless needed for stability.
- Job submission is synchronous for acceptance and asynchronous for execution progress.
- Abort is explicit and best-effort but must produce a terminal job state.
- Tokens are always workspace-scoped; node credentials are separate from user/workspace tokens.
- Browser launches are app-scoped, not sandbox-admin-scoped: users open a service UI, not an arbitrary raw tunnel by default.
- `or3-intern` is normally outside the browser service-launch path; `or3-net` owns the service/tunnel metadata and authorization layer.

## Design guardrails

- Keep the protocol surface small: jobs, streams, abort, enrollment, approval, heartbeats.
- Prefer loopback/private-network defaults for `or3-intern` service traffic.
- Preserve deterministic SQLite-backed state transitions in `or3-net` even when streams disconnect.
- Prefer `or3-net` launch endpoints over exposing direct tunnel creation UX to end users; tunnel mechanics stay behind a service-oriented API.