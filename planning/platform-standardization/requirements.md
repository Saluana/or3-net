# Cross-Project Platform Standardization — Requirements

## Overview

Standardize the platform at the boundaries between `or3-chat`, `or3-net`, `or3-intern`, and `or3-sandbox` without collapsing repo ownership or forcing shared runtime code. The goal is one coherent platform contract with adapters at repo boundaries.

Current state:

- `or3-chat` is the identity and workspace authority (Clerk/basic-auth → workspace token exchange).
- `or3-net` is the public control plane with its own `WorkspacePrincipal`, job routing, node scheduling, and preview lifecycle.
- `or3-intern` is the execution/memory authority keyed by bare `session_key` strings.
- `or3-sandbox` is the isolation/runtime authority scoped by `tenant_id`.

Each repo uses its own vocabulary, error shapes, auth models, and streaming conventions. Cross-repo integration works today but relies on implicit conventions and hand-maintained compatibility assumptions.

This plan creates explicit, testable contracts for every cross-repo boundary.

---

## 1. Canonical Platform Vocabulary

**As** a platform developer, **I want** a single canonical vocabulary for tenancy, identity, and session concepts, **so that** cross-repo conversations, types, docs, and audit trails use the same terms.

**Acceptance criteria:**

- WHEN a platform-level document, type, or API references the external tenancy unit, THEN it SHALL use `workspace_id`, not `tenant_id`, `org_id`, or `project_id`.
- WHEN a platform-level document references the authenticated actor, THEN it SHALL use `subject`.
- WHEN `or3-chat` references its internal user ID vs provider user ID, THEN it SHALL keep both distinct, and only the internal user ID SHALL scope workspace data.
- WHEN a caller-owned session identity is referenced, THEN it SHALL be called `client_session_id`.
- WHEN the durable control-plane coordination identity is referenced, THEN it SHALL be called `network_session_id`.
- WHEN the execution-session identity inside `or3-intern` is referenced, THEN it SHALL be called `session_key`.
- WHEN `or3-sandbox` references its internal storage/runtime isolation unit, THEN `tenant_id` SHALL remain an internal implementation detail and SHALL NOT be used as a public platform synonym for `workspace_id`.
- WHEN a platform glossary or ADR is published, THEN it SHALL enumerate these terms, their owners, and their mapping rules.

## 2. Unified Auth and Session Contracts

**As** a platform integrator, **I want** one documented auth and session contract set, **so that** every cross-repo boundary uses the same claim names, scope format, and principal shape.

**Acceptance criteria:**

- WHEN `or3-net` issues or validates a workspace token, THEN the claims SHALL include `subject`, `workspace_id`, `scopes`, `auth_type`, `issued_at`, and `expires_at`.
- WHEN `or3-net` resolves a request identity, THEN it SHALL produce a `WorkspacePrincipal` with the canonical fields above.
- WHEN `or3-net` binds a session to `or3-intern`, THEN a `PlatformSessionRef` SHALL carry `workspace_id`, `client_kind`, `client_session_id`, `network_session_id`, and `session_key`.
- WHEN a browser or external client authenticates, THEN it SHALL authenticate only to `or3-net`, never directly to `or3-intern` or `or3-sandbox`.
- WHEN `or3-chat` exchanges session proof for a workspace token, THEN the exchange input format and workspace-switch invalidation behavior SHALL be frozen and documented.
- WHEN `or3-net` calls `or3-intern` or `or3-sandbox`, THEN it SHALL use separate internal service auth, never forwarding browser credentials.
- WHEN `or3-intern` receives a job from `or3-net`, THEN `session_key` SHALL remain the canonical execution identity, but `or3-net` SHALL always bind it to a `network_session_id`.
- WHEN `or3-sandbox` services are presented upstream, THEN they SHALL appear as workspace-scoped capabilities, never raw tunnel or admin credentials.

## 3. Secret Classification and Transfer Rules

**As** a platform operator, **I want** explicit secret classes and transfer rules, **so that** secrets are never leaked across boundaries or exposed to browsers.

**Acceptance criteria:**

- WHEN a secret is classified, THEN it SHALL belong to exactly one of: user-local, control-plane, service-bootstrap, or ephemeral-capability.
- WHEN a user-local secret exists (e.g., OpenRouter API key stored in browser), THEN it SHALL remain browser-local and SHALL NOT be uploaded implicitly.
- WHEN a control-plane secret exists (e.g., HMAC signing keys, service auth tokens), THEN it SHALL be encrypted at rest, server-side only, and used only by `or3-net` and trusted backend services.
- WHEN a service-bootstrap secret exists (e.g., JWT secrets, DB paths), THEN it SHALL be env/file mounted only and SHALL NOT be exposed through APIs.
- WHEN an ephemeral capability secret exists (e.g., launch URLs, signed tunnel URLs), THEN it SHALL be short-lived, scoped, and revocable.
- WHEN secrets cross repo boundaries, THEN transfer SHALL use either server-to-server trust or a short-lived scoped capability, never raw secret copying unless the receiver is the long-term owner.
- WHEN logs, error payloads, SSE streams, persisted job events, or audit summaries are emitted, THEN secret material SHALL be redacted by default.
- WHEN a secret reference type is used, THEN it SHALL follow a common naming scheme (`SecretRef`) even if storage backends differ.

## 4. Capability Token Lifecycle

**As** an API client, **I want** capability tokens for previews, tunnels, and service launches to have a well-defined lifecycle, **so that** capabilities are bounded, revocable, and never unbounded in memory or storage.

**Acceptance criteria:**

- WHEN a capability is minted, THEN it SHALL carry `capability_id`, `workspace_id`, `kind`, `scope`, and `expires_at`.
- WHEN a capability is revoked, THEN it SHALL have `revoked_at` set and SHALL be immediately unresolvable.
- WHEN a capability expires, THEN it SHALL be pruned from memory/storage indexes during the next lookup or cleanup cycle.
- WHEN a capability is resolved after expiry, THEN the response SHALL be `410 Gone` with the standard error envelope.
- WHEN a capability is resolved after revocation, THEN the response SHALL be `403 Forbidden` with the standard error envelope.
- WHEN capability creation or launch is retried, THEN the operation SHALL be idempotent or safely deduplicated.
- WHEN repeated mint/revoke cycles occur, THEN internal token sets and reverse indexes SHALL NOT grow without bound.

## 5. Standardized Error Envelope

**As** an API client, **I want** all non-streaming `4xx/5xx` responses to use one stable error envelope, **so that** error handling code works across all platform APIs.

**Acceptance criteria:**

- WHEN a non-streaming error response is returned from any public or operator `or3-net` API, THEN it SHALL use the `ErrorEnvelope` shape: `{ error, code, status, request_id }` with optional `retry_after_ms`.
- WHEN a `401`, `403`, `404`, `409`, or `429` is returned, THEN the error SHALL carry a stable `code` string from a documented error code registry.
- WHEN a `429` is returned, THEN it SHALL include `retry_after_ms` as a structured field rather than looking like a generic failure.
- WHEN a `5xx` is returned, THEN internal parser output, stack traces, and engine-specific error text SHALL NOT be exposed.
- WHEN `or3-sandbox` returns errors through `or3-net`, THEN `or3-net` SHALL normalize them into the platform error envelope before forwarding to clients.
- WHEN `or3-intern` returns errors through `or3-net`, THEN `or3-net` SHALL normalize them into the platform error envelope.
- WHEN an error is returned from a streaming endpoint, THEN it SHALL be emitted as an `error` SSE event with the same envelope fields.

## 6. Standardized Wire and Streaming Conventions

**As** an API client, **I want** consistent wire format and streaming event conventions, **so that** client libraries and parsers work across all platform endpoints.

**Acceptance criteria:**

- WHEN a public JSON API returns data, THEN field names SHALL be `snake_case`.
- WHEN a public API returns timestamps, THEN they SHALL be ISO 8601 format.
- WHEN resource IDs are generated, THEN they SHALL use stable prefixes per resource type (e.g., `job_`, `ws_`, `node_`, `cap_`).
- WHEN `or3-net` exposes a job stream to upstream clients, THEN it SHALL use a normalized event set: `job.accepted`, `job.started`, `text.delta`, `tool.call`, `tool.result`, `job.completed`, `job.failed`, `job.aborted`, `error`.
- WHEN `or3-sandbox` emits runtime-specific events (e.g., `stdout`, `stderr`, `result`), THEN `or3-net` adapters SHALL translate them before exposing upstream.
- WHEN a stream is opened, THEN it SHALL emit at most one terminal event (`job.completed`, `job.failed`, `job.aborted`, or `error`).
- WHEN a stream supports resume/reconnect, THEN the semantics SHALL be documented per endpoint (e.g., offset-based, last-event-id).

## 7. Retry and Idempotency Rules

**As** an API client, **I want** sensitive operations to be safely retryable, **so that** transient failures and network retries do not cause duplicate side effects.

**Acceptance criteria:**

- WHEN auth exchange is retried, THEN `or3-net` SHALL return the same token or a new valid token without creating duplicate sessions.
- WHEN job submit is retried with the same idempotency key, THEN `or3-net` SHALL return the existing job rather than creating a duplicate.
- WHEN job abort is retried, THEN `or3-net` SHALL return success if the job is already terminal.
- WHEN preview launch or service launch is retried, THEN the operation SHALL either return the existing capability or be safely deduplicated.
- WHEN a `429` response is received, THEN the client SHALL use `retry_after_ms` from the error envelope to schedule retry timing.

## 8. Audit and Correlation Metadata

**As** a platform operator, **I want** a consistent audit context attached to all cross-repo operations, **so that** I can trace a request from browser to sandbox.

**Acceptance criteria:**

- WHEN a request enters `or3-net`, THEN an `AuditContext` SHALL be created carrying `request_id`, `workspace_id`, and `subject`.
- WHEN `or3-net` calls `or3-intern`, THEN the audit context SHALL include `network_session_id` and `session_key`.
- WHEN `or3-net` calls `or3-sandbox`, THEN the audit context SHALL include `sandbox_id`.
- WHEN a job is created or reaches a terminal state, THEN `job_id` SHALL be part of the audit context.
- WHEN audit events are persisted, THEN they SHALL use the canonical vocabulary (Requirement 1) and be correlatable across repos by `request_id`, `workspace_id`, and `network_session_id`.

## 9. Configuration and Env Naming

**As** a platform operator, **I want** predictable env var naming and secret source precedence across repos, **so that** deployment configuration is not surprising.

**Acceptance criteria:**

- WHEN env vars are used across repos, THEN naming SHALL follow a documented convention (e.g., `OR3_NET_*` for `or3-net`, `OR3_INTERN_*` for `or3-intern`, `OR3_SANDBOX_*` for `or3-sandbox`).
- WHEN multiple secret sources exist (env, file, runtime config), THEN precedence SHALL be documented and consistent per repo.
- WHEN `or3-chat` wizard generates env vars for `or3-net`, THEN the emitted key names SHALL match the canonical env naming convention.
- WHEN a deployment mixes repos, THEN shared config values (e.g., HMAC secrets) SHALL use the same key name or a documented alias mapping.

## 10. Contract Tests and Compatibility Policy

**As** a platform developer, **I want** fixture-backed contract tests at every repo boundary, **so that** contract drift is caught before deployment.

**Acceptance criteria:**

- WHEN a contract type changes in any repo, THEN fixture-backed contract tests in the affected repos SHALL fail.
- WHEN a new platform contract version is released, THEN it SHALL carry a version identifier and the compatibility matrix SHALL be updated.
- WHEN `or3-net` depends on `or3-sandbox` API shapes, THEN contract tests SHALL validate request/response fixtures against the documented `or3-sandbox` API.
- WHEN `or3-net` depends on `or3-intern` API shapes, THEN contract tests SHALL validate request/response fixtures against the documented `or3-intern` API.
- WHEN `or3-chat` depends on `or3-net` token exchange or job API shapes, THEN contract tests SHALL validate fixtures against the documented `or3-net` API.
- WHEN a fixture test fails, THEN the failing side SHALL either update the fixture or document a compatibility shim, never silently drift.

---

## Non-functional Constraints

- Do not create a shared runtime package or monorepo dependency coupling.
- Prefer shared schemas, fixtures, and test vectors over shared business logic.
- Keep `or3-sandbox` `tenant_id` internal; mapping to `workspace_id` is an `or3-net` adapter concern.
- Keep `or3-intern` `session_key` internal; binding to `network_session_id` is an `or3-net` concern.
- Preserve existing auth, workspace, and session models within each repo. Changes are additive.
- Do not force SSR auth changes in `or3-chat` until all upstream contracts are frozen and tested.
