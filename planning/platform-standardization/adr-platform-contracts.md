# ADR: Cross-Project Platform Contracts

## Status

Accepted

## Context

`or3-chat`, `or3-net`, `or3-intern`, and `or3-sandbox` currently integrate through working but partially implicit contracts. The biggest sources of drift are vocabulary (`workspace_id` vs `tenant_id`, `network_session_id` vs `session_key`), error envelope shape, and stream event normalization.

`or3-net` is the only public control-plane boundary and is therefore the correct owner for canonical boundary contracts.

## Decision

Adopt the following platform-standard vocabulary and contract ownership model:

- `workspace_id`: canonical external tenancy identifier.
- `subject`: canonical authenticated actor identity for tokens and audit trails.
- `client_session_id`: caller-owned session identity.
- `network_session_id`: durable `or3-net` coordination identity.
- `session_key`: internal `or3-intern` execution identity.
- `tenant_id`: internal `or3-sandbox` storage/runtime isolation term only.

Canonical contract types are defined in `or3-net/src/contracts/platform/` and versioned through fixture-backed tests rather than a shared runtime package.

## Ownership

| Concept | Canonical term | Owner repo | Notes |
|---------|----------------|-----------|-------|
| External tenancy | `workspace_id` | `or3-chat` + `or3-net` | Public platform term |
| Authenticated actor | `subject` | `or3-chat` + `or3-net` | Provider-specific subject stays behind adapters |
| Control-plane session | `network_session_id` | `or3-net` | Durable cross-request coordination ID |
| Execution session | `session_key` | `or3-intern` | Bound to `network_session_id` by `or3-net` |
| Runtime tenant | `tenant_id` | `or3-sandbox` | Internal-only implementation detail |
| Capability lifecycle | `CapabilityGrant` | `or3-net` | Includes preview/service/tunnel launch semantics |
| Error envelope | `ErrorEnvelope` | `or3-net` | Normalized before leaving public boundary |
| Audit correlation | `AuditContext` | `or3-net` | Propagated to backend services |

## Mapping rules

### `tenant_id` ↔ `workspace_id`

- `tenant_id` remains internal to `or3-sandbox`.
- `or3-net` maps workspace context to sandbox tenant context at the SDK/auth adapter layer.
- `tenant_id` must not become a public synonym for `workspace_id`.

### `session_key` ↔ `network_session_id`

- `session_key` remains internal to `or3-intern`.
- `or3-net` binds `session_key` to `network_session_id` in `PlatformSessionRef`.
- Browser and external clients never directly observe or control raw `session_key` values.

## Consequences

### Positive

- One canonical vocabulary across planning docs, fixtures, and public contracts.
- Boundary drift is caught through fixture tests instead of tribal knowledge.
- `or3-intern` and `or3-sandbox` keep their internal models without leaking them upstream.

### Negative

- `or3-net` must carry adapter code and compatibility helpers.
- Some existing shapes remain temporarily duplicated until consumer migration completes.

## Rejected alternatives

- **One shared runtime package across all repos:** rejected because it would couple Bun/TypeScript and Go runtimes too tightly.
- **Rename `tenant_id` to `workspace_id` inside `or3-sandbox`:** rejected because it changes internal ownership for little platform value.
- **Rename `session_key` inside `or3-intern`:** rejected because it risks breaking the execution/memory boundary instead of normalizing it.
