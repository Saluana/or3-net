# OR3 Net Plan — Files, Tunnels, and Previews

## Why this needs its own plan

OR3 Network is not only about dispatching jobs to nodes. Once an agent can create files, start services, and expose UI, the platform needs a consistent model for:

- persistent workspace files
- generated sites and artifacts
- temporary browser access to running services
- embedded previews inside `or3-chat`
- safe fallback to external browser windows when embedding is not appropriate

This is large enough to treat as a first-class feature area rather than a side effect of tunnel support.

---

## Product model

The user-facing mental model should be:

- **Workspace Files** — persistent files owned by the workspace sandbox; this acts like a cloud drive scoped to that workspace.
- **Previews** — user-viewable representations of generated output such as static sites or rendered artifacts.
- **Services** — running processes that expose an HTTP/WebSocket UI or API and can optionally be launched for the user.

The user should not need to think in terms of `ports`, `proxy tokens`, or `raw tunnels` for normal flows.

---

## Workspace files as cloud drive

### Goal

If an agent creates files in the workspace sandbox, the user should be able to:

- browse them
- open them
- download them
- use them as source for static previews or live services

### Boundary

This should mean access to the **workspace sandbox**, not the entire physical host machine.

- Good model: `the workspace owns everything inside its sandbox root`
- Bad model: `the workspace owns the whole host filesystem`

That keeps the system local-first and user-owned while preserving isolation.

### Examples

- static website files in `/workspace/site/dist`
- generated reports in `/workspace/reports`
- project repo files the agent edited in `/workspace/app`
- build artifacts the user wants to preview or download

---

## Two preview classes

### 1. Static preview

Used when the output is a directory of files that can be served directly.

Examples:

- generated HTML/CSS/JS site
- documentation site output
- artifact bundle with an `index.html`

Characteristics:

- no live backend process required
- can often be served more simply and safely than a tunnel
- ideal for embedding in `or3-chat`

### 2. Live service preview

Used when a process is actively serving content.

Examples:

- OpenClaw dashboard
- dev server for a generated app
- app that needs WebSocket or server-side rendering

Characteristics:

- requires lifecycle tracking and service readiness
- usually backed by a temporary tunnel for sandbox-backed nodes
- may or may not be suitable for iframe embedding

---

## Preview delivery modes

### Embedded pane preview

Default when the target is safe and compatible for embedding.

Behavior:

- `or3-chat` opens a pane app.
- The pane hosts an iframe pointing at a preview URL returned by `or3-net`.
- The top bar includes actions like:
  - `Open in New Tab`
  - `Refresh`
  - `Stop Preview` or `Revoke`

Best for:

- static sites
- simple read-only previews
- workspace-owned web output where staying inside chat is valuable

### External browser launch

Fallback or explicit choice when embedding is unsuitable.

Best for:

- auth-heavy dashboards
- apps that resist framing
- apps that need top-level navigation
- complex WebSocket/control-plane UIs

OpenClaw remains the reference example for this path in v1.

---

## Recommended preview descriptor

`or3-net` should describe previews/services with explicit metadata rather than forcing the UI to guess.

Suggested shape:

- `preview_id`
- `workspace_id`
- `node_id`
- `kind`: `static-site | web-app | dashboard | artifact-preview`
- `delivery_mode`: `embedded | external | embedded-preferred | external-preferred`
- `source_type`: `files | live-service`
- `path` or `port`
- `entry_path`
- `service_id` (optional)
- `status`
- `embed_url` (optional)
- `launch_url`
- `expires_at`
- `supports_iframe`
- `supports_new_tab`

The important part is not the exact type name; it is that `or3-net` explicitly tells `or3-chat` whether a preview should be embedded, opened externally, or offered both ways.

---

## Suggested host API additions

### Workspace file / preview endpoints

- `GET /v1/workspaces/:workspaceId/files`
  - list files/directories within the workspace sandbox boundary
- `GET /v1/workspaces/:workspaceId/files/*path`
  - read/download a workspace file
- `GET /v1/workspaces/:workspaceId/previews`
  - list available static previews and live services exposed as previews

### Preview launch endpoints

- `POST /v1/workspaces/:workspaceId/previews`
  - register a static preview from files or a known build output
- `POST /v1/workspaces/:workspaceId/previews/:previewId/launch`
  - return preview launch metadata, including embedded/external capability
- `POST /v1/workspaces/:workspaceId/previews/:previewId/revoke`
  - revoke the preview or its current launch tokens

### Node service launch endpoints

Node-backed app UIs can still use:

- `GET /v1/workspaces/:workspaceId/nodes/:nodeId/services`
- `POST /v1/workspaces/:workspaceId/nodes/:nodeId/services/:serviceId/launch`

In practice, `services` and `previews` can share storage and implementation if that keeps the design simpler.

---

## How previews are created

### Static previews

Possible creation paths:

1. agent declares a known output directory
2. runtime notices a successful build artifact and registers it
3. user selects a folder and asks for a preview

Example:

- agent builds a site into `/workspace/site/dist`
- `or3-net` registers that folder as a `static-site` preview
- `or3-chat` shows `Preview in Pane` and `Open in New Tab`

### Live service previews

Possible creation paths:

1. agent starts a service and emits metadata (`service_id`, port, app kind)
2. node adapter recognizes a known app contract
3. operator/user marks a service as launchable

Example:

- agent starts a dev server on port `3000`
- `or3-net` tracks it as a live service preview
- if sandbox-backed, `or3-net` creates or reuses a private tunnel for launch

---

## Embedded pane preview design

### Why iframe is the right first step

- minimal custom rendering logic
- reuses existing browser/app behavior
- keeps the preview inside `or3-chat`
- preserves an easy fallback to new-tab launch

### Security constraints

Iframe embedding should only be allowed when the preview layer explicitly permits it.

Recommended controls:

- `frame-ancestors` restricted to the `or3-chat` origin
- short-lived preview URLs
- workspace-scoped authorization before URL issuance
- restrictive iframe `sandbox` attributes by default
- explicit allowlist for any additional capabilities

The preview should be embedded from a URL controlled by `or3-net` or the approved preview/tunnel layer, not from arbitrary third-party origins.

### When iframe should not be used

- app requires top-level navigation
- app uses OAuth or popup login flows
- app sets anti-framing headers intentionally
- app is unstable when embedded
- app requires looser browser privileges than the pane should allow

In these cases, the pane should show a clear message and a prominent `Open in New Tab` button.

---

## Tunnel usage under the hood

Tunnels remain an implementation detail for live services, especially sandbox-backed ones.

### For static previews

Prefer serving files directly when possible rather than spinning up a live tunnel.

### For live service previews

Use temporary private tunnels and short-lived launch URLs.

This gives the best tradeoff:

- static output gets the simplest delivery path
- live apps still work through the proven tunnel model

---

## Where live services run by default

This needs to be explicit:

- **Default:** generated live services run inside a workspace sandbox or sandbox-backed node.
- **Not default:** generated live services do not bind directly on the raw `or3-intern` host machine.

Examples that should default to sandbox-backed execution:

- an API the agent created for the user
- a dev server for a generated app
- a dashboard or control UI the user needs to open in a browser

Why this default matters:

- the workspace sandbox is the user's owned execution boundary
- files, processes, previews, and cleanup stay aligned to one workspace scope
- revocation, reset, and preview expiry are easier to reason about
- agent-generated code does not get ambient access to the infrastructure host by default

### Dev-only host execution

Host-local service execution can still exist as a narrowly-scoped escape hatch for trusted local development, but it should be:

- explicit and opt-in
- clearly marked as development-only
- outside the default product flow
- not the assumed path for preview, service launch, or user-facing hosting

If this mode exists later, it should be treated as a convenience feature, not the main architecture.

---

## Role of `or3-intern`

`or3-intern` may create the files or start the process, but it should not own the preview/browser mediation path.

- `or3-intern` creates output and runs jobs
- `or3-net` decides how those outputs become previews or launchable services
- `or3-chat` renders the preview UI
- `or3-sandbox` provides tunnel transport where needed

In particular, when a live service needs to exist for the user, `or3-intern` should normally hand off to `or3-net`'s sandbox/service orchestration rather than hosting that service directly on the `or3-intern` machine.

---

## UX recommendations

### In `or3-chat`

Add three related surfaces:

- **Files**
  - browse workspace files
- **Previews**
  - list static previews and generated sites
- **Services**
  - list live services like OpenClaw or dev servers

Common actions:

- `Preview in Pane`
- `Open in New Tab`
- `Refresh`
- `Revoke`
- `Stop Service`

### Keep the language high-level

Use labels like:

- `Open Preview`
- `Open Dashboard`
- `View Files`

Avoid making normal users think about:

- tunnel IDs
- auth modes
- target ports
- signed query params

---

## Security and lifecycle rules

- previews are workspace-scoped
- preview URLs are short-lived by default
- embedded preview URLs should be revocable
- live preview access ends when the service stops or the lease expires
- static preview access ends when the preview is revoked or expires
- no preview path should grant generic sandbox control-plane access

---

## v1 recommendation

Ship this in a narrow but useful form:

1. workspace sandbox files are treated as user-owned workspace storage
2. static site previews can be embedded in an `or3-chat` pane app via secure iframe when allowed
3. all previews also offer `Open in New Tab`
4. live services use the existing tunnel-launch model under the hood
5. OpenClaw remains the reference external launch case
6. generated live services run in workspace sandboxes by default; host-local execution is development-only and opt-in

That gives a coherent product story without overbuilding a full IDE or generalized hosting platform in v1.

---

## Implementation checklist

- define preview metadata and storage in `or3-net`
- add preview list/launch/revoke endpoints
- support static file-backed previews separately from live service-backed previews
- add iframe embedding policy and preview descriptors for `or3-chat`
- add pane preview UI with `Open in New Tab` fallback
- keep sandbox tunnel mechanics behind `or3-net` for live services
- add docs and tests for preview expiry, iframe eligibility, and revoke behavior
