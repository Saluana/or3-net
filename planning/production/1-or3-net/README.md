# 1. OR3 Net

## Repo Role

`or3-net` is the control plane.

It owns:

- auth exchange
- workspace-scoped bearer tokens
- durable `network_session_id`
- jobs, streams, and sessions
- previews and preview launch
- capability-aware node/service surfaces

## Simplification Decision

Do not make `or3-net` validate Clerk and basic-auth separately for the `or3-chat` integration path in v1.

Instead:

- trust a single host-signed assertion from `or3-chat`
- validate that assertion through one `SessionProofValidator`
- keep the existing `session_proof` contract shape

Why this is compatible with the current code:

- `src/auth/service.ts` already uses `SessionProofValidator`
- `src/contracts/platform/auth.ts` already accepts opaque `session_proof`

## Primary Deliverables

### 1. Exchange adapter support

- [ ] Define `or3-chat-assertion-v1`
- [ ] Implement `SessionProofValidator` for `provider = "or3-chat"`
- [ ] Validate issuer, expiry, user id, workspace id, and scopes
- [ ] Reject stale or wrong-workspace assertions
- [ ] Document secret or JWKS distribution between `or3-chat` and `or3-net`

Recommended request shape:

```json
{
  "provider": "or3-chat",
  "session_proof": {
    "format": "or3-chat-assertion-v1",
    "assertion": "<signed-token>"
  },
  "workspace_id": "ws_demo"
}
```

### 2. Durable session contract

- [ ] Keep and freeze support for:
  - `network_session_id`
  - `client_kind`
  - `client_session_id`
  - legacy `session_key`
- [ ] Make `client_kind = "or3-chat"` the documented chat client binding
- [ ] Ensure session lookup and reuse are stable after refresh

Evidence this already exists:

- `src/session/service.ts`
- `src/execution/local-jobs.ts`

### 3. Job and stream stability

- [ ] Freeze create-job payloads used by chat
- [ ] Freeze stream event taxonomy used by chat
- [ ] Keep terminal events idempotent
- [ ] Keep replay and reconnect behavior explicit

### 4. Preview-first UX contract

- [ ] Treat previews as a first-class public surface
- [ ] Keep preview descriptors authoritative at the control plane
- [ ] Let service launch reuse preview/launch capability machinery where possible
- [ ] Do not expose raw node or runtime URLs directly to browsers

### 5. Capability-aware node/service contract

- [ ] Align control-plane service actions with real node capabilities
- [ ] Do not assume `service-launch` is available just because a node exists
- [ ] Gate service routes and console actions on advertised capability

This matters because `or3-node` currently keeps `service-launch` hidden by default even though service-management scaffolding exists.

## Milestones

### M0: Contract freeze

- [ ] freeze exchange assertion format
- [ ] freeze chat session binding fields
- [ ] freeze stream event names
- [ ] freeze preview descriptor shape
- [ ] freeze capability-truth rules

### M1: Auth implementation

- [ ] add host-assertion validator
- [ ] add tests for expiry, issuer, workspace mismatch, and bad signature
- [ ] add fixtures for request and response payloads

### M2: Session and jobs hardening

- [ ] ensure all chat-facing job routes can work from `client_kind` + `client_session_id`
- [ ] ensure job/session history remains stable after browser reconnect

### M3: Preview and service hardening

- [ ] keep previews working even if service-launch remains gated
- [ ] only enable service launch in default UX after node readiness says it is safe

### M4: Operational hardening

- [ ] logs for exchange, submit, abort, preview launch, service launch, revoke
- [ ] metrics for stream reconnect and launch failures
- [ ] rate limits for exchange and launch paths

## Test Matrix

- [ ] auth exchange with valid host assertion
- [ ] auth exchange with expired host assertion
- [ ] auth exchange with workspace mismatch
- [ ] durable session reuse from `client_kind` + `client_session_id`
- [ ] replay/reconnect behavior on job stream
- [ ] preview launch and revoke
- [ ] service launch gated by capability truth

## Definition Of Done

This repo is done only when:

- `or3-chat` can integrate through one trusted adapter path
- provider-specific OR3 Net validation is no longer required for the chat path
- previews work as a first-class feature
- service launch is capability-aware rather than assumed

## References

- `../README.md`
- `../../../src/auth/service.ts`
- `../../../src/contracts/platform/auth.ts`
- `../../../src/session/service.ts`
- `../../../src/execution/local-jobs.ts`
- `../../../docs/api/http-api.md`
