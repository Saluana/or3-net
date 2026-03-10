# OR3 Net Plan — Chat Plugin

## Goal

Ship OR3 Network as an `or3-chat` plugin, not as a core workflow rewrite.

## User-facing scope

- Sidebar entry for OR3 Network.
- Agent create/edit UI.
- Job submission form.
- Recent jobs list with live status/output.
- Nodes/services view for opening approved dashboards such as OpenClaw.
- Embedded pane previews for static sites and generated web output.
- Saved network/agent config objects for reuse.

## Integration model

- Use existing provider-agnostic session resolution in `or3-chat`.
- Exchange the active chat session for a short-lived `or3-net` token.
- Call only `or3-net` host APIs from the plugin.
- Keep workspace switching aligned with the existing workspace/session flow.
- Open service dashboards through `or3-net` launch endpoints, not by creating raw browser tunnels in the client.
- Mount static previews inside a pane app when `or3-net` marks them as iframe-safe, with `Open in New Tab` as a standard fallback.

## Plugin responsibilities

- Token acquisition and refresh.
- Agent/job CRUD calls.
- SSE subscription and reconnect UX for running jobs.
- Abort action and terminal-state handling.
- Service launch actions such as `Open Dashboard`, `Restart Service`, and `Revoke Access` when the user has permission.
- Embedded preview pane lifecycle (`Preview in Pane`, `Open in New Tab`, `Refresh`, `Revoke`).
- Local UI storage for filters, selected host, and saved presets when appropriate.

## Preview UX

- Static sites should usually open inside an `or3-chat` pane app first.
- The pane should host a secure iframe for workspace-owned previews when the preview descriptor says embedding is allowed.
- Every embedded preview should still expose `Open in New Tab` in the pane header.
- Live services and dashboards may still prefer or require external launch.

This gives users an in-chat preview workflow without forcing every app to work inside an iframe.

## Nodes and services UX

- The plugin should present node-backed UIs as `services/apps`, not as transport plumbing.
- A typical flow is:
	- user selects a node
	- sees `OpenClaw` listed as an available service
	- clicks `Open Dashboard`
	- plugin calls `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/openclaw/launch`
	- plugin opens the returned `launch_url`
- This keeps the UX simple while leaving room for deeper operator tooling later.

## Why not direct tunnel management first?

- Raw tunnel creation exposes too much transport detail to normal users.
- A service-oriented launch API is easier to secure and audit.
- `or3-sandbox` already has a robust signed browser tunnel flow; `or3-net` should wrap it rather than duplicating it in the browser.
- The same `launch service` UX can later target non-sandbox nodes without changing the plugin model.

## Boundaries

- No direct node enrollment transport in the browser.
- No direct `or3-intern` or `or3-sandbox` calls from the plugin.
- No auth-provider-specific logic beyond existing session/provider adapters.
- No generic user-facing `enter a port and open a tunnel` flow in v1.
- No embedding of arbitrary third-party URLs; pane previews should only use workspace-scoped preview URLs issued by `or3-net`.

## Testing focus

- Session exchange across auth providers.
- Workspace switch + token refresh behavior.
- Expired token recovery.
- Job streaming and abort UX.
- Service launch flow, short-lived launch URL handling, and permission-gated node/service actions.
- Embedded static preview behavior, iframe denial fallback, and pane-to-new-tab transitions.