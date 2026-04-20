# Cross-Project Platform Standardization — Tasks

## Recommended Implementation Order

Use a contract-first rollout to avoid breakage:

1. Complete Phase 1 in `or3-net` first: freeze vocabulary, canonical types, fixtures, compatibility policy, and contract tests before changing runtime behavior.
2. Add non-breaking scaffolding in `or3-net`: introduce `ErrorEnvelope`, `AuditContext`, `PlatformSessionRef`, normalized stream/event types, and compatibility helpers without requiring consumers to switch immediately.
3. Update backend providers before enforcing the new contract in public APIs:
	- `or3-intern` first for audit/session metadata acceptance and `session_key` contract alignment.
	- `or3-sandbox` second for `workspace_id` → `tenant_id` mapping, service-account scope alignment, and capability semantics.
4. Turn on boundary normalization in `or3-net`: switch public/operator errors to the canonical envelope, normalize backend error/event shapes, formalize capability lifecycle, and add idempotency/retry behavior.
5. Update consumers last: migrate `or3-chat` only after the upstream `or3-net` contract is stable and fixture-tested.

Guiding rules:

- Readers before writers: make services accept new metadata before requiring it.
- Adapters before enforcement: normalize old shapes first, then tighten validation.
- Providers before consumers: backend boundaries stabilize before `or3-chat` consumes them.
- Fixture tests gate every boundary: each boundary should have passing contract tests before the next consumer-facing step.

Tasks are organized by project in execution order. `or3-net` goes first as the boundary owner, then `or3-intern`, then `or3-sandbox`, and finally `or3-chat`.

---

## Phase 1: Contracts and ADRs

### 1. Platform standards ADR and vocabulary (or3-net)

- [x] [Req 1] Write the platform standards ADR in `or3-net/planning/platform-standardization/adr-platform-contracts.md` defining the canonical vocabulary: `workspace_id`, `subject`, `client_session_id`, `network_session_id`, `session_key`, `tenant_id` (internal-only).
- [x] [Req 1] Add a platform glossary section to the ADR mapping each canonical term to its owner repo and usage context.
- [x] [Req 1] Document the `tenant_id` ↔ `workspace_id` mapping rule: `tenant_id` is internal to `or3-sandbox`; `or3-net` maps at the SDK adapter layer.
- [x] [Req 1] Document the `session_key` ↔ `network_session_id` binding rule: `session_key` is internal to `or3-intern`; `or3-net` binds in `PlatformSessionRef`.

### 2. Canonical platform types (or3-net)

- [x] [Req 1, 2] Define `WorkspacePrincipal` in `src/contracts/platform/types.ts` with frozen fields: `subject`, `workspace_id`, `scopes`, `auth_type`, `issued_at`, `expires_at`.
- [x] [Req 2] Define `PlatformSessionRef` in `src/contracts/platform/types.ts` with fields: `workspace_id`, `client_kind`, `client_session_id`, `network_session_id`, `session_key`.
- [x] [Req 4] Define `CapabilityGrant` in `src/contracts/platform/types.ts` with fields: `capability_id`, `workspace_id`, `kind`, `scope`, `expires_at`, `revoked_at`.
- [x] [Req 3] Define `SecretRef` in `src/contracts/platform/types.ts` with fields: `secret_id`, `class`, `owner_scope`, `created_at`, `rotated_at`.
- [x] [Req 5] Define `ErrorEnvelope` in `src/contracts/platform/types.ts` with fields: `error`, `code`, `status`, `request_id`, optional `retry_after_ms`.
- [x] [Req 8] Define `AuditContext` in `src/contracts/platform/types.ts` with fields: `request_id`, `workspace_id`, `subject`, optional `network_session_id`, `job_id`, `session_key`, `sandbox_id`.
- [x] [Req 5] Define the initial error code registry as a `const` map in `src/contracts/platform/error-codes.ts`.

### 3. Normalized stream event types (or3-net)

- [x] [Req 6] Define `PlatformStreamEvent` union type in `src/contracts/platform/stream-events.ts` covering: `job.accepted`, `job.started`, `text.delta`, `tool.call`, `tool.result`, `job.completed`, `job.failed`, `job.aborted`, `error`.
- [x] [Req 6] Document the translation mapping from `or3-intern` SSE events to platform events.
- [x] [Req 6] Document the translation mapping from `or3-sandbox` exec events to platform events.
- [x] [Req 6] Document the terminal event constraint: exactly one terminal event per stream.

### 4. Secret and capability lifecycle doc (or3-net)

- [x] [Req 3] Write `or3-net/planning/platform-standardization/secret-capability-lifecycle.md` defining the four secret classes and their transfer rules.
- [x] [Req 3] Document which secrets belong to which class in each repo.
- [x] [Req 4] Document the capability grant lifecycle: mint → resolve → revoke/expire → prune.
- [x] [Req 3] Document the redaction requirements for logs, error payloads, SSE streams, and audit summaries.

### 5. Error/SSE/idempotency contract doc (or3-net)

- [x] [Req 5, 6, 7] Write `or3-net/planning/platform-standardization/wire-contracts.md` covering: `snake_case` rule, ISO timestamps, ID prefixes, error envelope, streaming event set, retry/idempotency rules.
- [x] [Req 5] Document stable `4xx`/`5xx` semantics for each error code.
- [x] [Req 6] Document resume/reconnect semantics per streaming endpoint.
- [x] [Req 7] Document which operations are safe to retry and how idempotency is enforced.

### 6. Compatibility matrix (or3-net)

- [x] [Req 10] Write `or3-net/planning/platform-standardization/compatibility-matrix.md` listing every boundary, its consumer/provider pair, contract version, and fixture file references.
- [x] [Req 10] Define the versioning policy: additive changes are minor, breaking changes require a new version.

### 7. Contract test fixtures (or3-net)

- [x] [Req 10] Create `tests/contracts/fixtures/` directory structure.
- [x] [Req 2, 10] Create `auth-exchange.request.json` and `auth-exchange.response.json` fixtures matching the frozen exchange contract.
- [x] [Req 5, 10] Create `error-envelope.401.json`, `error-envelope.403.json`, `error-envelope.404.json`, `error-envelope.409.json`, `error-envelope.429.json` fixtures.
- [x] [Req 6, 10] Create `job-stream-events.jsonl` fixture with one example of each platform stream event type.
- [x] [Req 2, 10] Create `workspace-principal.json` and `platform-session-ref.json` fixtures.
- [x] [Req 4, 10] Create `capability-grant.json` fixture for each capability kind.
- [x] [Req 8, 10] Create `audit-context.json` fixture with all optional fields populated.

### 8. Contract tests (or3-net)

- [x] [Req 10] Write `tests/contracts/auth-exchange.contract.test.ts` validating request/response fixtures against the frozen type.
- [x] [Req 10] Write `tests/contracts/error-envelope.contract.test.ts` validating all error fixture files parse to `ErrorEnvelope`.
- [x] [Req 10] Write `tests/contracts/stream-events.contract.test.ts` validating stream event fixtures parse to `PlatformStreamEvent`.
- [x] [Req 10] Write `tests/contracts/sandbox-sdk.contract.test.ts` validating SDK types against sandbox API fixtures.
- [x] [Req 10] Write `tests/contracts/intern-sdk.contract.test.ts` validating SDK types against intern API fixtures.
- [x] [Req 1, 10] Write vocabulary contract tests checking that exported types use canonical field names and no banned aliases.

---

## Phase 2: Boundary Normalization

### 9. Error envelope adoption (or3-net)

- [x] [Req 5] Implement `errorResponse()` helper in `src/api/` that produces `ErrorEnvelope` with `request_id` and optional `retry_after_ms`.
- [x] [Req 5] Migrate `handleAppRequest()` error catch block from `{ error }` to `ErrorEnvelope` using `errorResponse()`.
- [x] [Req 5] Migrate `HttpError` usage to carry a `code` field from the error code registry.
- [x] [Req 5] Update `readOptionalJson()` malformed body error to use `input.malformed_body` code.
- [x] [Req 5] Update 401/403/404 responses throughout API routes to use the canonical error codes.
- [x] [Req 5] Add `Retry-After` header and `retry_after_ms` field to any 429 responses.

### 10. Request ID and audit context propagation (or3-net)

- [x] [Req 8] Generate or accept `X-Request-Id` on every incoming request in `handleAppRequest()`.
- [x] [Req 8] Create `AuditContext` at the start of each request handler with `request_id`, `workspace_id`, and `subject`.
- [x] [Req 8] Propagate `X-Request-Id`, `X-Workspace-Id`, and `X-Network-Session-Id` headers on calls to `or3-intern` via the intern SDK.
- [x] [Req 8] Propagate `X-Request-Id` and `X-Workspace-Id` headers on calls to `or3-sandbox` via the sandbox SDK.
- [x] [Req 8] Include `AuditContext` fields in persisted job lifecycle events (job creation, terminal state changes).

### 11. WorkspacePrincipal freeze (or3-net)

- [x] [Req 2] Update the existing `WorkspacePrincipal` in `src/auth/tokens.ts` to include `issued_at` and `expires_at` fields from the canonical type.
- [x] [Req 2] Update workspace token claims to use `subject` (verify alignment with existing `sub` claim).
- [x] [Req 2] Ensure API key auth path also produces a `WorkspacePrincipal` with all canonical fields.

### 12. PlatformSessionRef binding (or3-net)

- [x] [Req 2] Update the session binding logic in the network sessions layer to produce `PlatformSessionRef` when routing to `or3-intern`.
- [x] [Req 2] Pass `PlatformSessionRef` metadata alongside `session_key` on intern SDK calls.
- [x] [Req 2] Persist `network_session_id` ↔ `session_key` binding in the `network_sessions` table (verify existing schema suffices).

### 13. CapabilityGrant lifecycle formalization (or3-net)

- [x] [Req 4] Refactor `src/previews/service.ts` launch capability minting to produce `CapabilityGrant` objects.
- [x] [Req 4] Use `cap_` prefixed IDs for all capability grants.
- [x] [Req 4] Return `410 Gone` with `capability.expired` error code for expired capabilities.
- [x] [Req 4] Return `403 Forbidden` with `capability.revoked` error code for revoked capabilities.
- [x] [Req 4] Ensure service launch flows also produce `CapabilityGrant` objects with the same lifecycle.

### 14. Backend error normalization (or3-net)

> **Cross-ref:** Runtime-specific envelopes in `planning/runtime-contract/` extend the platform registry from `src/contracts/platform/error-codes.ts`; runtime errors should map into that shared registry instead of creating an untracked side channel.

- [x] [Req 5] Implement `normalizeInternError()` to translate `or3-intern` Go errors and `RemoteExecutionError` into `ErrorEnvelope`.
- [x] [Req 5] Implement `normalizeSandboxError()` to translate `or3-sandbox` `{ error, code, status }` responses into `ErrorEnvelope`.
- [x] [Req 5] Wire both normalizers into the execution and adapter paths so backend errors never leak raw output to clients.

### 15. Stream event normalization (or3-net)

- [x] [Req 6] Implement intern-to-platform stream event translator for the `or3-intern` SSE path.
- [x] [Req 6] Implement sandbox-to-platform stream event translator for the `or3-sandbox` exec streaming path.
- [x] [Req 6] Enforce the terminal event constraint: exactly one terminal event per stream.
- [x] [Req 6] Document resume/reconnect behavior for `GET /v1/workspaces/:wsId/jobs/:id/stream`.

### 16. Idempotency support (or3-net)

- [x] [Req 7] Add optional `Idempotency-Key` header support to job submit endpoint.
- [x] [Req 7] Return existing job on duplicate submit with same idempotency key.
- [x] [Req 7] Make abort idempotent: return success if job is already terminal.
- [x] [Req 7] Make auth exchange idempotent: return valid token without creating duplicate sessions.

---

### 17. Audit context header acceptance (or3-intern)

- [x] [Req 8] Accept `X-Request-Id`, `X-Workspace-Id`, and `X-Network-Session-Id` headers on internal service API endpoints.
- [x] [Req 8] Log audit context fields alongside `session_key` in execution lifecycle events.
- [x] [Req 8] Pass audit context through to subagent spawning so child jobs are correlatable.

### 18. Session key binding contract (or3-intern)

- [x] [Req 2] Document the `session_key` contract: what it is, how it's generated, how `or3-net` binds it to `network_session_id`.
- [x] [Req 1] Review and document any existing alias drift (e.g., `session_key` vs `sessionKey` vs `session_id` in different paths) and either unify or add an explicit compatibility layer.
- [x] [Req 2] Add fixture file (`cmd/or3-intern/testdata/service_contract/intern-turn-request.json`) matching the frozen turn submission contract.

### 19. or3-intern contract test fixtures

- [x] [Req 10] Create `cmd/or3-intern/testdata/service_contract/intern-turn-response.json` matching the frozen turn response shape.
- [x] [Req 10] Create `cmd/or3-intern/testdata/service_contract/intern-stream-events.jsonl` with the raw `or3-intern` SSE event shapes.
- [x] [Req 10] Write contract tests validating fixtures against the documented service API shapes.

---

### 20. Workspace→tenant mapping contract (or3-sandbox)

- [x] [Req 1] Document the `workspace_id` → `tenant_id` mapping rule: how `or3-net` maps workspace context to sandbox tenant context via auth/token.
- [x] [Req 1] Confirm that `tenant_id` never appears in any external/public API response from `or3-sandbox` that clients would see through `or3-net`.

### 21. Service account scope standardization (or3-sandbox)

- [x] [Req 2] Review and document the service account scopes used by `or3-net` when calling `or3-sandbox`.
- [x] [Req 2] Ensure service account scopes are minimal and workspace-scoped (no admin-level scopes for routine operations).
- [x] [Req 3] Verify that service account credentials are classified as `control-plane` secrets and handled accordingly.

### 22. Launch capability alignment (or3-sandbox)

- [x] [Req 4] Document how tunnel creation and signed URL minting align with the platform `CapabilityGrant` model.
- [x] [Req 4] Ensure tunnel URLs and launch URLs have bounded expiry and are revocable.
- [x] [Req 4] Verify that raw tunnel/admin credentials are never returned in responses that flow through to browser clients.

### 23. or3-sandbox contract test fixtures

- [x] [Req 10] Create `tests/contracts/fixtures/sandbox-create-request.json` and `sandbox-create-response.json` matching the sandbox API contract.
- [x] [Req 10] Create `tests/contracts/fixtures/sandbox-exec-response.json` and `sandbox-exec-stream-events.jsonl` for exec endpoints.
- [x] [Req 10] Create `tests/contracts/fixtures/sandbox-error-response.json` for the sandbox error shape.
- [x] [Req 10] Write contract tests validating fixtures against the `or3-sandbox` v1 API docs.

---

### 24. Session proof exchange freeze (or3-chat)

- [x] [Req 2] Freeze the session proof exchange input format: `{ provider, session_proof, workspace_id? }`.
- [x] [Req 2] Document the shipped `or3-chat` session proof format: server-issued `or3-chat-assertion-v1` proof relayed by the local exchange bridge, not browser-sent provider JWTs/tokens.
- [x] [Req 2] Ensure `or3-chat` provider-specific auth stays hidden behind existing abstractions (`SessionContext` and the server-side exchange bridge) rather than leaking provider-specific proof logic into the browser.

### 25. Workspace switch invalidation (or3-chat)

- [x] [Req 2] Freeze workspace-switch invalidation behavior: cached `or3-net` workspace tokens are invalidated on workspace switch.
- [x] [Req 2] Ensure active workspace-scoped views (job streams, preview embeds) are torn down on workspace switch.
- [x] [Req 2] Document the invalidation contract so `or3-net` can rely on it for session binding cleanup.

### 26. Error envelope consumption (or3-chat)

- [x] [Req 5] Update `or3-chat` `or3-net` client code to parse `ErrorEnvelope` responses instead of ad-hoc `{ error }` shapes.
- [x] [Req 7] Use `retry_after_ms` from `ErrorEnvelope` for 429 retry scheduling instead of fixed backoff where the consumer automatically reconnects.
- [x] [Req 5] Surface canonical error codes in user-facing error messages where appropriate.

### 27. or3-chat contract test fixtures

- [x] [Req 10] Create `tests/contracts/fixtures/or3-net-exchange-request.json` and `or3-net-exchange-response.json` fixtures.
- [x] [Req 10] Create `tests/contracts/fixtures/or3-net-job-stream-events.jsonl` fixture matching the platform stream event set.
- [x] [Req 10] Write contract tests validating fixtures against the frozen `or3-net` API shapes.

---

## Phase 3: Conformance and SDKs

### 28. CI contract test enforcement (all repos)

- [x] [Req 10] Add contract test suite to `or3-net` CI pipeline so fixture drift fails the build.
- [x] [Req 10] Add contract test suite to `or3-intern` CI pipeline for intern API fixtures.
- [x] [Req 10] Add contract test suite to `or3-sandbox` CI pipeline for sandbox API fixtures.
- [x] [Req 10] Add contract test suite to `or3-chat` CI pipeline for `or3-net` API fixtures.

### 29. Configuration and env naming alignment (all repos)

- [x] [Req 9] Document the env var naming convention per repo (`OR3_NET_*`, `OR3_INTERN_*`, `OR3_SANDBOX_*`).
- [x] [Req 9] Document secret source precedence per repo (env → file → runtime config).
- [ ] [Req 9] Align `or3-chat` wizard env var emission with the canonical naming convention.
- [x] [Req 9] Document shared config values (e.g., HMAC secrets) and their key name mapping across repos.

### 30. Compatibility matrix maintenance

- [x] [Req 10] Finalize and publish the compatibility matrix with contract versions for all boundaries.
- [x] [Req 10] Add a process for updating the matrix when contract versions change.

---

## Out of Scope

- [ ] Do not create a shared runtime npm/Go package imported by all repos.
- [ ] Do not change `or3-intern`'s `session_key` internal model beyond documentation and fixture alignment.
- [ ] Do not change `or3-sandbox`'s `tenant_id` internal model beyond documentation and fixture alignment.
- [ ] Do not move auth ownership away from `or3-chat`.
- [ ] Do not add new daemons, message brokers, or distributed coordination.
- [ ] Do not force SSR auth changes in `or3-chat` until all upstream contracts (Phase 1 + Phase 2 `or3-net`) are frozen and tested.
