# Cross-Project Platform Standardization — Tasks

Tasks are organized by project in execution order. `or3-net` goes first as the boundary owner, then `or3-intern`, then `or3-sandbox`, and finally `or3-chat`.

---

## Phase 1: Contracts and ADRs

### 1. Platform standards ADR and vocabulary (or3-net)

- [ ] [Req 1] Write the platform standards ADR in `or3-net/planning/platform-standardization/adr-platform-contracts.md` defining the canonical vocabulary: `workspace_id`, `subject`, `client_session_id`, `network_session_id`, `session_key`, `tenant_id` (internal-only).
- [ ] [Req 1] Add a platform glossary section to the ADR mapping each canonical term to its owner repo and usage context.
- [ ] [Req 1] Document the `tenant_id` ↔ `workspace_id` mapping rule: `tenant_id` is internal to `or3-sandbox`; `or3-net` maps at the SDK adapter layer.
- [ ] [Req 1] Document the `session_key` ↔ `network_session_id` binding rule: `session_key` is internal to `or3-intern`; `or3-net` binds in `PlatformSessionRef`.

### 2. Canonical platform types (or3-net)

- [ ] [Req 1, 2] Define `WorkspacePrincipal` in `src/contracts/platform/types.ts` with frozen fields: `subject`, `workspace_id`, `scopes`, `auth_type`, `issued_at`, `expires_at`.
- [ ] [Req 2] Define `PlatformSessionRef` in `src/contracts/platform/types.ts` with fields: `workspace_id`, `client_kind`, `client_session_id`, `network_session_id`, `session_key`.
- [ ] [Req 4] Define `CapabilityGrant` in `src/contracts/platform/types.ts` with fields: `capability_id`, `workspace_id`, `kind`, `scope`, `expires_at`, `revoked_at`.
- [ ] [Req 3] Define `SecretRef` in `src/contracts/platform/types.ts` with fields: `secret_id`, `class`, `owner_scope`, `created_at`, `rotated_at`.
- [ ] [Req 5] Define `ErrorEnvelope` in `src/contracts/platform/types.ts` with fields: `error`, `code`, `status`, `request_id`, optional `retry_after_ms`.
- [ ] [Req 8] Define `AuditContext` in `src/contracts/platform/types.ts` with fields: `request_id`, `workspace_id`, `subject`, optional `network_session_id`, `job_id`, `session_key`, `sandbox_id`.
- [ ] [Req 5] Define the initial error code registry as a `const` map in `src/contracts/platform/error-codes.ts`.

### 3. Normalized stream event types (or3-net)

- [ ] [Req 6] Define `PlatformStreamEvent` union type in `src/contracts/platform/stream-events.ts` covering: `job.accepted`, `job.started`, `text.delta`, `tool.call`, `tool.result`, `job.completed`, `job.failed`, `job.aborted`, `error`.
- [ ] [Req 6] Document the translation mapping from `or3-intern` SSE events to platform events.
- [ ] [Req 6] Document the translation mapping from `or3-sandbox` exec events to platform events.
- [ ] [Req 6] Document the terminal event constraint: exactly one terminal event per stream.

### 4. Secret and capability lifecycle doc (or3-net)

- [ ] [Req 3] Write `or3-net/planning/platform-standardization/secret-capability-lifecycle.md` defining the four secret classes and their transfer rules.
- [ ] [Req 3] Document which secrets belong to which class in each repo.
- [ ] [Req 4] Document the capability grant lifecycle: mint → resolve → revoke/expire → prune.
- [ ] [Req 3] Document the redaction requirements for logs, error payloads, SSE streams, and audit summaries.

### 5. Error/SSE/idempotency contract doc (or3-net)

- [ ] [Req 5, 6, 7] Write `or3-net/planning/platform-standardization/wire-contracts.md` covering: `snake_case` rule, ISO timestamps, ID prefixes, error envelope, streaming event set, retry/idempotency rules.
- [ ] [Req 5] Document stable `4xx`/`5xx` semantics for each error code.
- [ ] [Req 6] Document resume/reconnect semantics per streaming endpoint.
- [ ] [Req 7] Document which operations are safe to retry and how idempotency is enforced.

### 6. Compatibility matrix (or3-net)

- [ ] [Req 10] Write `or3-net/planning/platform-standardization/compatibility-matrix.md` listing every boundary, its consumer/provider pair, contract version, and fixture file references.
- [ ] [Req 10] Define the versioning policy: additive changes are minor, breaking changes require a new version.

### 7. Contract test fixtures (or3-net)

- [ ] [Req 10] Create `tests/contracts/fixtures/` directory structure.
- [ ] [Req 2, 10] Create `auth-exchange.request.json` and `auth-exchange.response.json` fixtures matching the frozen exchange contract.
- [ ] [Req 5, 10] Create `error-envelope.401.json`, `error-envelope.403.json`, `error-envelope.404.json`, `error-envelope.409.json`, `error-envelope.429.json` fixtures.
- [ ] [Req 6, 10] Create `job-stream-events.jsonl` fixture with one example of each platform stream event type.
- [ ] [Req 2, 10] Create `workspace-principal.json` and `platform-session-ref.json` fixtures.
- [ ] [Req 4, 10] Create `capability-grant.json` fixture for each capability kind.
- [ ] [Req 8, 10] Create `audit-context.json` fixture with all optional fields populated.

### 8. Contract tests (or3-net)

- [ ] [Req 10] Write `tests/contracts/auth-exchange.contract.test.ts` validating request/response fixtures against the frozen type.
- [ ] [Req 10] Write `tests/contracts/error-envelope.contract.test.ts` validating all error fixture files parse to `ErrorEnvelope`.
- [ ] [Req 10] Write `tests/contracts/stream-events.contract.test.ts` validating stream event fixtures parse to `PlatformStreamEvent`.
- [ ] [Req 10] Write `tests/contracts/sandbox-sdk.contract.test.ts` validating SDK types against sandbox API fixtures.
- [ ] [Req 10] Write `tests/contracts/intern-sdk.contract.test.ts` validating SDK types against intern API fixtures.
- [ ] [Req 1, 10] Write vocabulary contract tests checking that exported types use canonical field names and no banned aliases.

---

## Phase 2: Boundary Normalization

### 9. Error envelope adoption (or3-net)

- [ ] [Req 5] Implement `errorResponse()` helper in `src/api/` that produces `ErrorEnvelope` with `request_id` and optional `retry_after_ms`.
- [ ] [Req 5] Migrate `handleAppRequest()` error catch block from `{ error }` to `ErrorEnvelope` using `errorResponse()`.
- [ ] [Req 5] Migrate `HttpError` usage to carry a `code` field from the error code registry.
- [ ] [Req 5] Update `readOptionalJson()` malformed body error to use `input.malformed_body` code.
- [ ] [Req 5] Update 401/403/404 responses throughout API routes to use the canonical error codes.
- [ ] [Req 5] Add `Retry-After` header and `retry_after_ms` field to any 429 responses.

### 10. Request ID and audit context propagation (or3-net)

- [ ] [Req 8] Generate or accept `X-Request-Id` on every incoming request in `handleAppRequest()`.
- [ ] [Req 8] Create `AuditContext` at the start of each request handler with `request_id`, `workspace_id`, and `subject`.
- [ ] [Req 8] Propagate `X-Request-Id`, `X-Workspace-Id`, and `X-Network-Session-Id` headers on calls to `or3-intern` via the intern SDK.
- [ ] [Req 8] Propagate `X-Request-Id` and `X-Workspace-Id` headers on calls to `or3-sandbox` via the sandbox SDK.
- [ ] [Req 8] Include `AuditContext` fields in persisted job lifecycle events (job creation, terminal state changes).

### 11. WorkspacePrincipal freeze (or3-net)

- [ ] [Req 2] Update the existing `WorkspacePrincipal` in `src/contracts/auth.ts` to include `issued_at` and `expires_at` fields from the canonical type.
- [ ] [Req 2] Update workspace token claims to use `subject` (verify alignment with existing `sub` claim).
- [ ] [Req 2] Ensure API key auth path also produces a `WorkspacePrincipal` with all canonical fields.

### 12. PlatformSessionRef binding (or3-net)

- [ ] [Req 2] Update the session binding logic in the network sessions layer to produce `PlatformSessionRef` when routing to `or3-intern`.
- [ ] [Req 2] Pass `PlatformSessionRef` metadata alongside `session_key` on intern SDK calls.
- [ ] [Req 2] Persist `network_session_id` ↔ `session_key` binding in the `network_sessions` table (verify existing schema suffices).

### 13. CapabilityGrant lifecycle formalization (or3-net)

- [ ] [Req 4] Refactor `src/previews/service.ts` launch capability minting to produce `CapabilityGrant` objects.
- [ ] [Req 4] Use `cap_` prefixed IDs for all capability grants.
- [ ] [Req 4] Return `410 Gone` with `capability.expired` error code for expired capabilities.
- [ ] [Req 4] Return `403 Forbidden` with `capability.revoked` error code for revoked capabilities.
- [ ] [Req 4] Ensure service launch flows also produce `CapabilityGrant` objects with the same lifecycle.

### 14. Backend error normalization (or3-net)

- [ ] [Req 5] Implement `normalizeInternError()` to translate `or3-intern` Go errors and `RemoteExecutionError` into `ErrorEnvelope`.
- [ ] [Req 5] Implement `normalizeSandboxError()` to translate `or3-sandbox` `{ error, code, status }` responses into `ErrorEnvelope`.
- [ ] [Req 5] Wire both normalizers into the execution and adapter paths so backend errors never leak raw output to clients.

### 15. Stream event normalization (or3-net)

- [ ] [Req 6] Implement intern-to-platform stream event translator for the `or3-intern` SSE path.
- [ ] [Req 6] Implement sandbox-to-platform stream event translator for the `or3-sandbox` exec streaming path.
- [ ] [Req 6] Enforce the terminal event constraint: exactly one terminal event per stream.
- [ ] [Req 6] Document resume/reconnect behavior for `GET /v1/workspaces/:wsId/jobs/:id/stream`.

### 16. Idempotency support (or3-net)

- [ ] [Req 7] Add optional `Idempotency-Key` header support to job submit endpoint.
- [ ] [Req 7] Return existing job on duplicate submit with same idempotency key.
- [ ] [Req 7] Make abort idempotent: return success if job is already terminal.
- [ ] [Req 7] Make auth exchange idempotent: return valid token without creating duplicate sessions.

---

### 17. Audit context header acceptance (or3-intern)

- [ ] [Req 8] Accept `X-Request-Id`, `X-Workspace-Id`, and `X-Network-Session-Id` headers on internal service API endpoints.
- [ ] [Req 8] Log audit context fields alongside `session_key` in execution lifecycle events.
- [ ] [Req 8] Pass audit context through to subagent spawning so child jobs are correlatable.

### 18. Session key binding contract (or3-intern)

- [ ] [Req 2] Document the `session_key` contract: what it is, how it's generated, how `or3-net` binds it to `network_session_id`.
- [ ] [Req 1] Review and document any existing alias drift (e.g., `session_key` vs `sessionKey` vs `session_id` in different paths) and either unify or add an explicit compatibility layer.
- [ ] [Req 2] Add fixture file (`tests/contracts/fixtures/intern-turn-request.json`) matching the frozen turn submission contract.

### 19. or3-intern contract test fixtures

- [ ] [Req 10] Create `tests/contracts/fixtures/intern-turn-response.json` matching the frozen turn response shape.
- [ ] [Req 10] Create `tests/contracts/fixtures/intern-stream-events.jsonl` with the raw `or3-intern` SSE event shapes.
- [ ] [Req 10] Write contract tests validating fixtures against the documented service API shapes.

---

### 20. Workspace→tenant mapping contract (or3-sandbox)

- [ ] [Req 1] Document the `workspace_id` → `tenant_id` mapping rule: how `or3-net` maps workspace context to sandbox tenant context via auth/token.
- [ ] [Req 1] Confirm that `tenant_id` never appears in any external/public API response from `or3-sandbox` that clients would see through `or3-net`.

### 21. Service account scope standardization (or3-sandbox)

- [ ] [Req 2] Review and document the service account scopes used by `or3-net` when calling `or3-sandbox`.
- [ ] [Req 2] Ensure service account scopes are minimal and workspace-scoped (no admin-level scopes for routine operations).
- [ ] [Req 3] Verify that service account credentials are classified as `control-plane` secrets and handled accordingly.

### 22. Launch capability alignment (or3-sandbox)

- [ ] [Req 4] Document how tunnel creation and signed URL minting align with the platform `CapabilityGrant` model.
- [ ] [Req 4] Ensure tunnel URLs and launch URLs have bounded expiry and are revocable.
- [ ] [Req 4] Verify that raw tunnel/admin credentials are never returned in responses that flow through to browser clients.

### 23. or3-sandbox contract test fixtures

- [ ] [Req 10] Create `tests/contracts/fixtures/sandbox-create-request.json` and `sandbox-create-response.json` matching the sandbox API contract.
- [ ] [Req 10] Create `tests/contracts/fixtures/sandbox-exec-response.json` and `sandbox-exec-stream-events.jsonl` for exec endpoints.
- [ ] [Req 10] Create `tests/contracts/fixtures/sandbox-error-response.json` for the sandbox error shape.
- [ ] [Req 10] Write contract tests validating fixtures against the `or3-sandbox` v1 API docs.

---

### 24. Session proof exchange freeze (or3-chat)

- [ ] [Req 2] Freeze the session proof exchange input format: `{ provider, session_proof, workspace_hint? }`.
- [ ] [Req 2] Document what `or3-chat` sends as `session_proof` for each auth provider (Clerk JWT, basic-auth token).
- [ ] [Req 2] Ensure `or3-chat` provider-specific auth stays hidden behind existing abstractions (`AuthTokenBroker`, `SessionContext`).

### 25. Workspace switch invalidation (or3-chat)

- [ ] [Req 2] Freeze workspace-switch invalidation behavior: cached `or3-net` workspace tokens are invalidated on workspace switch.
- [ ] [Req 2] Ensure active workspace-scoped views (job streams, preview embeds) are torn down on workspace switch.
- [ ] [Req 2] Document the invalidation contract so `or3-net` can rely on it for session binding cleanup.

### 26. Error envelope consumption (or3-chat)

- [ ] [Req 5] Update `or3-chat` `or3-net` client code to parse `ErrorEnvelope` responses instead of ad-hoc `{ error }` shapes.
- [ ] [Req 7] Use `retry_after_ms` from `ErrorEnvelope` for 429 retry scheduling instead of fixed backoff.
- [ ] [Req 5] Surface canonical error codes in user-facing error messages where appropriate.

### 27. or3-chat contract test fixtures

- [ ] [Req 10] Create `tests/contracts/fixtures/or3-net-exchange-request.json` and `or3-net-exchange-response.json` fixtures.
- [ ] [Req 10] Create `tests/contracts/fixtures/or3-net-job-stream-events.jsonl` fixture matching the platform stream event set.
- [ ] [Req 10] Write contract tests validating fixtures against the frozen `or3-net` API shapes.

---

## Phase 3: Conformance and SDKs

### 28. CI contract test enforcement (all repos)

- [ ] [Req 10] Add contract test suite to `or3-net` CI pipeline so fixture drift fails the build.
- [ ] [Req 10] Add contract test suite to `or3-intern` CI pipeline for intern API fixtures.
- [ ] [Req 10] Add contract test suite to `or3-sandbox` CI pipeline for sandbox API fixtures.
- [ ] [Req 10] Add contract test suite to `or3-chat` CI pipeline for `or3-net` API fixtures.

### 29. Configuration and env naming alignment (all repos)

- [ ] [Req 9] Document the env var naming convention per repo (`OR3_NET_*`, `OR3_INTERN_*`, `OR3_SANDBOX_*`).
- [ ] [Req 9] Document secret source precedence per repo (env → file → runtime config).
- [ ] [Req 9] Align `or3-chat` wizard env var emission with the canonical naming convention.
- [ ] [Req 9] Document shared config values (e.g., HMAC secrets) and their key name mapping across repos.

### 30. Compatibility matrix maintenance

- [ ] [Req 10] Finalize and publish the compatibility matrix with contract versions for all boundaries.
- [ ] [Req 10] Add a process for updating the matrix when contract versions change.

---

## Out of Scope

- [ ] Do not create a shared runtime npm/Go package imported by all repos.
- [ ] Do not change `or3-intern`'s `session_key` internal model beyond documentation and fixture alignment.
- [ ] Do not change `or3-sandbox`'s `tenant_id` internal model beyond documentation and fixture alignment.
- [ ] Do not move auth ownership away from `or3-chat`.
- [ ] Do not add new daemons, message brokers, or distributed coordination.
- [ ] Do not force SSR auth changes in `or3-chat` until all upstream contracts (Phase 1 + Phase 2 `or3-net`) are frozen and tested.
