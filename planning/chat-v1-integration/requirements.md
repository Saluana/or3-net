# Chat V1 Integration — Requirements

## Overview

This plan covers priority 6 from the status report:

6. complete end-to-end chat integration

The goal is to make OR3 feel like one product from the user’s perspective by completing the `or3-chat` → `or3-net` → `or3-intern` / `or3-sandbox` path.

Scope includes:

- `or3-chat` plugin integration
- token exchange and workspace-aware auth
- session-aware job creation, streaming, and abort UX
- node service launch and preview UX
- end-to-end tests across the integrated flow

Assumptions:

- `or3-chat` remains plugin-first and must continue to work without `or3-net` enabled.
- `or3-net` host API is the only browser-facing backend for this feature.
- `or3-intern` and `or3-sandbox` are never called directly from the browser.
- The operator/session plan provides the durable session contract the chat plugin binds to.

## Requirements

### 1. `or3-chat` must integrate with `or3-net` as a plugin, not a core rewrite

**Requirement:** As a user, I need OR3 Network features to appear inside `or3-chat` without breaking static mode or requiring a new app shell.

**Acceptance criteria:**

- The OR3 Network UI must be delivered as an `or3-chat` plugin or plugin-like surface gated by configuration.
- When no `or3-net` host is configured, the plugin must remain inactive without affecting the rest of `or3-chat`.
- The integration must reuse existing workspace/session flows in `or3-chat` rather than introducing a parallel auth system.

### 2. Token exchange and workspace switching must be seamless

**Requirement:** As a signed-in `or3-chat` user, I need my current workspace session to exchange into a short-lived `or3-net` token and refresh automatically across workspace changes.

**Acceptance criteria:**

- The plugin must exchange the current OR3 Chat session for a workspace-scoped `or3-net` bearer token using `POST /v1/auth/exchange`.
- The token must be cached in memory only and refreshed automatically on expiry or 401 responses.
- When the user switches workspaces, the plugin must invalidate the old `or3-net` token, acquire a new one, and rebind network session state to the new workspace.
- The integration must work with the provider-agnostic session model already used by `or3-chat`.

### 3. Job creation, streaming, and abort must work end to end

**Requirement:** As a user, I need to submit jobs from `or3-chat`, watch them stream live, and abort them reliably from the same UI.

**Acceptance criteria:**

- The plugin must create jobs through `or3-net` using the canonical session model from the operator/session plan.
- The plugin must display recent jobs and their current status for the active workspace/session.
- The plugin must stream live output from `GET /v1/jobs/:jobId/stream` and recover cleanly from disconnects using status re-fetch or replay APIs.
- The plugin must provide an abort action that updates local UI state correctly after `POST /v1/jobs/:jobId/abort`.
- Session resume after refresh or reconnect must rebind to the correct job/session history for the current workspace.

### 4. Node services and previews must feel like product features, not raw transport plumbing

**Requirement:** As a user, I need to open node-backed dashboards and file-backed previews through simple product actions rather than manually managing ports or tunnels.

**Acceptance criteria:**

- The plugin must list approved node-backed services/apps relevant to the current workspace.
- Service actions such as `Open Dashboard`, `Restart Service`, and `Revoke Access` must call `or3-net` host API routes and use opaque launch URLs.
- Static or iframe-safe previews must open inside an `or3-chat` pane when `or3-net` marks them as embeddable.
- Every embedded preview must still support `Open in New Tab` fallback.
- Non-embeddable services and previews must present a clear external-launch flow.

### 5. The integrated flow must have end-to-end regression coverage

**Requirement:** As a maintainer, I need end-to-end tests proving the `or3-chat` plugin can authenticate, submit work, observe progress, and launch outputs through `or3-net`.

**Acceptance criteria:**

- Automated tests must cover token exchange, workspace switch rebind, job submit/get/stream/abort, and preview/service launch flows.
- Tests must prove the browser client never calls `or3-intern` or `or3-sandbox` directly.
- Tests must include failure cases for expired tokens, missing permissions, expired launch URLs, and session/workspace mismatch.
- The test plan must span both repos as needed: browser/plugin tests in `or3-chat`, host API tests in `or3-net`, and compatibility assertions against upstream contracts.

## Non-functional constraints

- Preserve static builds and plugin-first architecture in `or3-chat`.
- Keep tokens and session proofs out of `localStorage`; use in-memory caching only.
- Maintain workspace isolation and same-origin safety for preview/service launch URLs.
- Use bounded reconnect/retry behavior for streaming and token refresh.
- Avoid direct browser exposure of raw node credentials, sandbox bearer tokens, or internal service secrets.
- Reuse existing composables, plugin registration patterns, and pane/preview models in `or3-chat` instead of creating a new frontend subsystem.
