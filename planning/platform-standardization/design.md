# Cross-Project Platform Standardization — Design

## Overview

This design standardizes the cross-project contracts between `or3-chat`, `or3-net`, `or3-intern`, and `or3-sandbox` without introducing a shared runtime package or collapsing repo ownership. The work produces canonical types, contract fixtures, and adapter normalization at each boundary.

The contracts are centered in `or3-net` because it is the control-plane boundary owner — every cross-repo call flows through it.

### Current State

```
┌─────────────┐                          ┌─────────────┐
│  or3-chat    │  session proof (ad hoc)  │  or3-net     │
│  (identity   ├─────────────────────────►│  (control    │
│   authority) │◄─────────────────────────┤   plane)     │
│              │  workspace token (HMAC)  │              │
└─────────────┘                          └──────┬───┬───┘
                                                │   │
                          nonce/HMAC token ──────┘   └──── static/JWT token
                                                │         │
                                         ┌──────▼───┐ ┌───▼──────────┐
                                         │or3-intern │ │ or3-sandbox  │
                                         │(session_  │ │ (tenant_id   │
                                         │ key)      │ │  isolation)  │
                                         └───────────┘ └──────────────┘

Vocabulary:  4 different identity models, ad-hoc error shapes, implicit mappings
```

### Target State

```
┌─────────────┐                          ┌──────────────────────────────┐
│  or3-chat    │ frozen exchange contract │  or3-net                     │
│  (identity   ├─────────────────────────►│  ┌────────────────────────┐ │
│   authority) │◄─────────────────────────┤  │ Contract normalizer    │ │
│              │ WorkspacePrincipal token │  │ - ErrorEnvelope        │ │
└─────────────┘                          │  │ - PlatformSessionRef   │ │
                                         │  │ - CapabilityGrant      │ │
                                         │  │ - AuditContext         │ │
                                         │  │ - Stream event shapes  │ │
                                         │  └────────┬───────┬───────┘ │
                                         └───────────┼───────┼─────────┘
                                                     │       │
                              service auth + audit ──┘       └── service auth + audit
                              + PlatformSessionRef            + workspace→tenant map
                                                     │       │
                                              ┌──────▼──┐ ┌──▼───────────┐
                                              │or3-intern│ │ or3-sandbox  │
                                              │(session_ │ │ (tenant_id   │
                                              │ key)     │ │  internal)   │
                                              └─────────┘ └──────────────┘

Vocabulary:  canonical terms, shared fixtures, contract tests per boundary
```

---

## Architecture

### Canonical Types

All canonical types live in `or3-net` as the boundary authority. Other repos consume fixture files or hand-maintained compatible types, not a shared package import.

#### WorkspacePrincipal

The resolved identity after auth validation. Already exists in `src/contracts/auth.ts`; to be frozen with canonical field names.

```ts
interface WorkspacePrincipal {
  readonly subject: string;          // authenticated actor identity
  readonly workspace_id: string;     // external tenancy unit
  readonly scopes: string[];         // e.g. "jobs:write", "nodes:read", "*"
  readonly auth_type: "workspace-token" | "api-key";
  readonly issued_at: number;        // epoch seconds
  readonly expires_at: number;       // epoch seconds
}
```

#### PlatformSessionRef

Binds every session concept across the stack. Created by `or3-net` when it routes a request from a client to `or3-intern`.

```ts
interface PlatformSessionRef {
  readonly workspace_id: string;
  readonly client_kind: "chat" | "cli" | "sdk" | "console";
  readonly client_session_id: string;    // caller-owned session identity
  readonly network_session_id: string;   // durable or3-net coordination identity
  readonly session_key: string;          // or3-intern execution-session identity
}
```

#### CapabilityGrant

Replaces the ad-hoc capability tracking in preview/service launch flows.

```ts
interface CapabilityGrant {
  readonly capability_id: string;    // prefixed: cap_<uuid>
  readonly workspace_id: string;
  readonly kind: "preview-launch" | "service-launch" | "tunnel-access" | "file-download";
  readonly scope: Record<string, string>;  // kind-specific scope fields
  readonly expires_at: number;       // epoch seconds
  readonly revoked_at: number | null;
}
```

#### SecretRef

Common reference shape for secrets across repos. Does not contain the secret value.

```ts
interface SecretRef {
  readonly secret_id: string;
  readonly class: "user-local" | "control-plane" | "service-bootstrap" | "ephemeral-capability";
  readonly owner_scope: string;      // workspace_id or "system"
  readonly created_at: number;
  readonly rotated_at: number | null;
}
```

#### ErrorEnvelope

Stable error shape for all non-streaming responses. Replaces the current ad-hoc `{ error }` JSON.

```ts
interface ErrorEnvelope {
  readonly error: string;            // human-readable message
  readonly code: string;             // machine-readable from error registry
  readonly status: number;           // HTTP status code (mirrored for client convenience)
  readonly request_id: string;       // correlation ID
  readonly retry_after_ms?: number;  // present on 429 responses
}
```

Error code registry (initial set):

| Code | Status | Meaning |
|------|--------|---------|
| `auth.token_expired` | 401 | Workspace token or API key expired |
| `auth.token_invalid` | 401 | Token signature or format invalid |
| `auth.insufficient_scope` | 403 | Valid auth but missing required scope |
| `resource.not_found` | 404 | Requested resource does not exist in workspace |
| `resource.conflict` | 409 | Idempotency conflict or state conflict |
| `rate.limit_exceeded` | 429 | Rate limit hit; use `retry_after_ms` |
| `input.malformed_body` | 400 | JSON parse failure or schema validation failure |
| `input.invalid_parameter` | 400 | Valid JSON but invalid field values |
| `capability.expired` | 410 | Capability grant has expired |
| `capability.revoked` | 403 | Capability grant has been revoked |
| `server.internal` | 500 | Internal error (no details exposed) |
| `server.unavailable` | 503 | Service temporarily unavailable |

#### AuditContext

Carried on every cross-repo call. Persisted with job lifecycle events.

```ts
interface AuditContext {
  readonly request_id: string;
  readonly workspace_id: string;
  readonly subject: string;
  readonly network_session_id?: string;
  readonly job_id?: string;
  readonly session_key?: string;
  readonly sandbox_id?: string;
}
```

---

## Boundary Contracts

### Boundary 1: or3-chat → or3-net

```
Direction: or3-chat calls or3-net public API
Auth: session proof exchange → workspace token
```

**Contract surface to freeze:**

| Endpoint | Input | Output |
|----------|-------|--------|
| `POST /v1/auth/exchange` | `{ provider, session_proof, workspace_hint? }` | `{ token, workspace_id, expires_at, scopes }` |
| `POST /v1/workspaces/:wsId/jobs` | `{ message, ... }` + Bearer token | `{ job_id, status }` |
| `GET /v1/workspaces/:wsId/jobs/:id/stream` | Bearer token | SSE: normalized event set |
| `POST /v1/workspaces/:wsId/jobs/:id/abort` | Bearer token | `{ ok }` or ErrorEnvelope |

**Rules:**

- `or3-chat` never calls `or3-intern` or `or3-sandbox` directly.
- Workspace switch in `or3-chat` invalidates cached tokens and active workspace-scoped views.
- Session proof format is provider-specific but the exchange endpoint shape is frozen.

### Boundary 2: or3-net → or3-intern

```
Direction: or3-net calls or3-intern internal service API
Auth: HMAC nonce token (service-to-service)
```

**Contract surface to freeze:**

| Endpoint | Input | Output |
|----------|-------|--------|
| `POST /internal/v1/turns` | `{ session_key, message, tool_policy?, meta? }` + service auth | SSE stream or JSON result |
| `GET /internal/v1/jobs/:id/stream` | service auth | SSE stream |
| `POST /internal/v1/jobs/:id/abort` | service auth | `{ ok }` |

**Normalization rules:**

- `or3-net` binds `session_key` to `network_session_id` before call.
- `or3-net` attaches `AuditContext` headers: `X-Request-Id`, `X-Workspace-Id`, `X-Network-Session-Id`.
- `or3-intern` raw SSE events are translated to the platform event set before forwarding to clients.
- `or3-intern` errors are normalized to `ErrorEnvelope` before returning to callers.

### Boundary 3: or3-net → or3-sandbox

```
Direction: or3-net calls or3-sandbox HTTP API via sandbox SDK
Auth: static token or JWT (service account)
```

**Contract surface to freeze:**

| Endpoint group | SDK method | or3-net adapter concern |
|---------------|-----------|------------------------|
| Sandbox CRUD | `create`, `get`, `list`, `delete` | Map `workspace_id` to sandbox tenant context |
| Execution | `exec`, streaming exec | Translate `stdout/stderr/result/error` to platform event set |
| Files | `readFile`, `writeFile`, `deleteFile` | Workspace-scoped file access |
| Tunnels | `createTunnel`, `listTunnels`, `revokeTunnel` | Wrap as `CapabilityGrant`, never expose raw tunnel credentials |
| Services | launch, status | Return `CapabilityGrant` with short-lived `launch_url` |

**Normalization rules:**

- `tenant_id` is an `or3-sandbox` internal concept. `or3-net` maps `workspace_id` → `tenant_id` at the SDK adapter layer.
- Sandbox errors (`{ error, code, status }`) are normalized to platform `ErrorEnvelope` with `request_id`.
- Raw tunnel URLs and admin credentials never pass through to browser clients.
- Service launches return `CapabilityGrant` objects, not raw infrastructure details.

---

## Normalized Stream Event Set

`or3-net` exposes one stable event set to upstream clients regardless of backend:

```ts
type PlatformStreamEvent =
  | { event: "job.accepted"; data: { job_id: string } }
  | { event: "job.started"; data: { job_id: string; started_at: string } }
  | { event: "text.delta"; data: { content: string } }
  | { event: "tool.call"; data: { tool_call_id: string; name: string; arguments: string } }
  | { event: "tool.result"; data: { tool_call_id: string; content: string } }
  | { event: "job.completed"; data: { job_id: string; result: object } }
  | { event: "job.failed"; data: { job_id: string; error: ErrorEnvelope } }
  | { event: "job.aborted"; data: { job_id: string } }
  | { event: "error"; data: ErrorEnvelope };
```

**Translation rules:**

| Source | Source events | Platform events |
|--------|-------------|----------------|
| `or3-intern` | `text_delta`, `tool_call`, `tool_result`, `complete`, `error` | Direct mapping with field rename |
| `or3-sandbox` | `stdout`, `stderr`, `result`, `error` | Aggregate `stdout` as `text.delta`; `result` → `job.completed`; `error` → `job.failed` |
| Remote node | `text_delta`, `tool_call`, `tool_result`, `progress`, `complete`, `error` | Direct mapping; `progress` dropped or mapped to `text.delta` |

Terminal event constraint: every stream emits exactly one of `job.completed`, `job.failed`, `job.aborted`, or `error` as its final event.

---

## Secret Classification Model

```
┌──────────────────────────────────────────────────────────┐
│                    Secret Classes                        │
├──────────────────┬───────────────────────────────────────┤
│ user-local       │ Browser-only, user-owned              │
│                  │ e.g., OpenRouter API key in KV        │
│                  │ Never uploaded implicitly              │
├──────────────────┼───────────────────────────────────────┤
│ control-plane    │ Server-side, encrypted at rest        │
│                  │ e.g., HMAC signing key, service token │
│                  │ Used by or3-net + trusted backends    │
├──────────────────┼───────────────────────────────────────┤
│ service-bootstrap│ Env/file mounted only                 │
│                  │ e.g., JWT_SECRET, DB_PATH             │
│                  │ Never exposed through APIs            │
├──────────────────┼───────────────────────────────────────┤
│ ephemeral-cap    │ Short-lived, scoped, revocable        │
│                  │ e.g., launch URL, signed tunnel URL   │
│                  │ Browser may receive these             │
└──────────────────┴───────────────────────────────────────┘
```

**Transfer rules:**

- `user-local` → never crosses to server unless user explicitly opts in via a known API.
- `control-plane` → server-to-server only, via authenticated internal calls.
- `service-bootstrap` → loaded from env/file at startup, never transmitted over the wire.
- `ephemeral-cap` → minted by server, delivered to authorized client, short-lived and revocable.

---

## Error Normalization Design

### Current state

- `or3-net` API: `jsonResponse(status, { error: "message" })` — no `code`, no `request_id`.
- `or3-sandbox`: `{ error, code, status }` — has codes but different shape.
- `or3-intern`: raw Go error strings — no structured envelope.

### Target state

All error responses flow through a single `errorResponse()` helper in `or3-net`:

```ts
function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryAfterMs?: number
): Response {
  const body: ErrorEnvelope = {
    error: message,
    code,
    status,
    request_id: requestId,
    ...(retryAfterMs !== undefined && { retry_after_ms: retryAfterMs }),
  };
  return jsonResponse(status, body, {
    "X-Request-Id": requestId,
    ...(retryAfterMs !== undefined && {
      "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
    }),
  });
}
```

### Backend error normalization

```ts
// or3-intern errors → ErrorEnvelope
function normalizeInternError(raw: unknown, requestId: string): ErrorEnvelope {
  // Parse Go error string or structured RemoteExecutionError
  // Map to canonical error code
  // Redact any internal details
}

// or3-sandbox errors → ErrorEnvelope
function normalizeSandboxError(raw: SandboxErrorResponse, requestId: string): ErrorEnvelope {
  // Map sandbox error.code to platform error code
  // Preserve status, redact internals
}
```

---

## Audit Context Propagation

```
Browser request
    │
    ├─ X-Request-Id: req_abc123 (generated if missing)
    │
    ▼
or3-net API handler
    │
    ├─ Creates AuditContext { request_id, workspace_id, subject }
    │
    ├──► or3-intern call
    │    Headers: X-Request-Id, X-Workspace-Id, X-Network-Session-Id
    │    AuditContext += { network_session_id, session_key, job_id }
    │
    ├──► or3-sandbox call
    │    Headers: X-Request-Id, X-Workspace-Id
    │    AuditContext += { sandbox_id }
    │
    └─ Persist: job lifecycle events include AuditContext fields
```

---

## Contract Testing Strategy

### Approach

Fixture-backed tests per boundary. Each repo owns its side of the fixture.

```
or3-net/
  tests/
    contracts/
      fixtures/
        auth-exchange.request.json
        auth-exchange.response.json
        error-envelope.401.json
        error-envelope.429.json
        job-stream-events.jsonl
        workspace-principal.json
        platform-session-ref.json
        capability-grant.json
      auth-exchange.contract.test.ts
      error-envelope.contract.test.ts
      stream-events.contract.test.ts
      sandbox-sdk.contract.test.ts
      intern-sdk.contract.test.ts
```

### Test categories

| Category | What it tests | Fixture source |
|----------|--------------|----------------|
| Auth exchange | Request/response shape matches frozen contract | `auth-exchange.*.json` |
| Error envelope | All error responses parse to `ErrorEnvelope` | `error-envelope.*.json` |
| Stream events | SSE events match `PlatformStreamEvent` union | `job-stream-events.jsonl` |
| Sandbox SDK | SDK types match `or3-sandbox` API fixtures | `sandbox-*.json` |
| Intern SDK | SDK types match `or3-intern` API fixtures | `intern-*.json` |
| Vocabulary | Exported types use canonical field names | Type-level tests |

### Compatibility matrix

| Boundary | Consumer | Provider | Contract version |
|----------|----------|----------|-----------------|
| Auth exchange | `or3-chat` | `or3-net` | `v1` |
| Job API | `or3-chat`, CLI, SDK | `or3-net` | `v1` |
| Intern service | `or3-net` | `or3-intern` | `v1` |
| Sandbox API | `or3-net` | `or3-sandbox` | `v1` |
| Node protocol | `or3-net` | remote nodes | `v1` |

---

## Rollout Phases

### Phase 1: Contracts and ADRs (this wave)

- Define canonical types in `or3-net/src/contracts/platform/`.
- Write platform standards ADR in `or3-net/planning/platform-standardization/`.
- Create fixture files for every boundary contract.
- Write contract tests that validate fixture compatibility.
- No runtime changes yet — types and tests only.

### Phase 2: Boundary normalization

- `or3-net`: Adopt `ErrorEnvelope` in API handlers, add `AuditContext` propagation, formalize `CapabilityGrant` lifecycle, normalize backend error translation.
- `or3-intern`: Add audit context header acceptance, document session_key binding contract, explicit compatibility layer for any alias drift.
- `or3-sandbox`: Document workspace→tenant mapping contract, standardize service-account scopes, align launch-capability semantics.
- `or3-chat`: Freeze session-proof exchange inputs, workspace-switch invalidation behavior. Done last.

### Phase 3: Conformance and SDKs

- Contract tests run in CI for all repos.
- Thin SDK/schema packages generated or hand-maintained for stable boundaries only.
- No shared runtime package — shared schemas, fixtures, and test vectors only.

---

## What This Design Does NOT Do

- Does not create a shared npm/Go package imported by all repos.
- Does not change `or3-intern`'s `session_key` model or `or3-sandbox`'s `tenant_id` model.
- Does not move auth ownership away from `or3-chat`.
- Does not add new daemons, message brokers, or distributed state.
- Does not force SSR auth changes in `or3-chat` before upstream contracts are frozen.
- Does not standardize internal implementation details — only boundary contracts.
