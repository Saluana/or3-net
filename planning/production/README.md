# OR3 Network Production Plan

Last rewritten: 2026-03-29

## Goal

Ship OR3 Network with the smallest architecture that still gives a strong user and operator experience.

The simplified production shape is:

- `or3-net` stays the control plane
- `or3-chat` stays the identity and UI authority
- `or3-node` is the primary machine-side agent
- `or3-intern` stays the execution dependency behind `or3-net`
- auth providers are kept off the critical path by using a chat-server exchange adapter

This removes the biggest source of avoidable complexity:

- `or3-chat` should not need provider-specific OR3 Net exchange logic in the browser
- `or3-net` should not need to validate Clerk and basic-auth differently in v1 when the caller is always `or3-chat`

## Evidence Behind The Simplification

### OR3 Net already supports an adapter boundary for auth exchange

- `src/auth/service.ts` already depends on `SessionProofValidator`
- `src/contracts/platform/auth.ts` already models `session_proof` as an opaque record
- `docs/api/http-api.md` already documents `POST /v1/auth/exchange`

That means the exchange contract can stay stable while the proof mechanism becomes simpler.

### OR3 Node is real and belongs in the production path

- `or3-node/README.md` defines `or3-net` as the control plane and `or3-node` as the installable machine agent
- `or3-node/src/runtime-capabilities.ts` shows:
  - `exec` always on
  - `file-read` and `file-write` conditional on `allowedRoots`
  - `pty` conditional on platform
  - `service-launch` currently hidden by default
- `or3-node/tests/host-control-services.test.ts` proves there is an actual service manager surface, but it is not yet honest to expose as default GA capability
- `or3-node/docs/release-gates.md` and `or3-node/docs/platform-support.md` both treat service launch and preview-backed service exposure as release-gated rather than default-on

So the correct production stance is:

- `or3-node` is primary
- service launch is gated
- chat UX must degrade gracefully when `service-launch` is not advertised

## Production Priorities

1. [1-or3-net](./1-or3-net/README.md)
2. [2-or3-chat](./2-or3-chat/README.md)
3. [3-or3-node](./3-or3-node/README.md)
4. [4-or3-intern](./4-or3-intern/README.md)
5. [5-or3-provider-clerk](./5-or3-provider-clerk/README.md)
6. [6-or3-provider-basic-auth](./6-or3-provider-basic-auth/README.md)

Priority logic:

- `or3-net` owns the public contract and must freeze it first
- `or3-chat` is the proven missing integration and should consume the frozen contract through the simplest possible adapter
- `or3-node` is now the primary machine path, so its capability truth matters more than provider-specific exchange details
- provider repos move to verify-only because the adapter keeps them off the browser/client critical path

## Architecture Decision

### Preferred exchange path: chat-server adapter

Preferred v1 flow:

1. Browser in `or3-chat` calls an SSR route owned by `or3-chat`
2. `or3-chat` server resolves the authenticated session and active workspace using existing provider integrations
3. `or3-chat` server mints a short-lived OR3 Net host assertion
4. `or3-chat` server calls `POST /v1/auth/exchange` or returns the assertion to a very thin client exchange layer
5. `or3-net` validates that single trusted assertion format and issues its normal workspace token

Why this is better:

- no Clerk SDK in OR3 Net client code
- no basic-auth special case in OR3 Net client code
- no requirement for provider repos to add OR3 Net-specific browser logic
- same UX regardless of auth provider
- easier debugging because the trust boundary is `or3-chat` -> `or3-net`, not browser -> provider -> `or3-net`

### Provider-direct proof is no longer the default plan

Provider-direct proof remains an optional future path, not the v1 critical path.

That means:

- `or3-provider-clerk` likely needs zero OR3 Net-specific code for v1
- `or3-provider-basic-auth` likely needs zero OR3 Net-specific code for v1
- both repos still need verification to ensure `or3-chat` can resolve the right user/workspace state for the adapter

## UX Rules

- OR3 Net should appear in `or3-chat` only when configured and supported
- jobs and streaming are the primary UX
- previews should be first-class
- service launch should only appear when a node actually advertises `service-launch`
- if `or3-node` only advertises `exec`, `file-*`, and `pty`, the UI should still feel complete rather than “half enabled”

## Cross-Repo Contracts To Freeze

### Auth exchange

Keep the current OR3 Net contract surface, but standardize the proof format around a host assertion.

Recommended request:

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

Recommended response:

```json
{
  "token": "payload.signature",
  "workspace_id": "ws_demo",
  "expires_at": "2099-01-01T00:15:00.000Z",
  "scopes": ["jobs:read", "jobs:write"]
}
```

### Durable session mapping

This is already a real concept in `or3-net` and should stay:

- `client_kind`
- `client_session_id`
- `network_session_id`
- optional legacy `session_key`

### Node/service/preview capability truth

The control plane must only surface capabilities the node really advertises.

For `or3-node` today that means:

- `exec`: yes
- `file-read` / `file-write`: only when `allowedRoots` is configured
- `pty`: only on supported platforms
- `service-launch`: not default-on yet

## Production Phases

### Phase 0: Freeze contract and simplification

Outputs:

- one trusted `or3-chat` assertion format
- one `SessionProofValidator` implementation in `or3-net`
- one capability truth model tied to `or3-node`

### Phase 1: Finish the control plane

Outputs:

- stable auth exchange
- stable jobs and sessions
- stable previews
- service launch still gated unless `or3-node` readiness clears it

### Phase 2: Finish the chat integration

Outputs:

- server-side exchange adapter
- minimal client auth logic
- clean job and preview UX
- capability-aware service UX

### Phase 3: Finish node readiness

Outputs:

- honest capability advertising
- service-launch hardening if it is needed for GA
- docs and smoke tests aligned with real runtime behavior

### Phase 4: Verify execution dependency

Outputs:

- `or3-intern` behavior validated against OR3 Net session and stream expectations

### Phase 5: Provider verification

Outputs:

- confirm no OR3 Net-specific provider changes are needed
- or, if needed, document the minimum unavoidable provider change

## Definition Of Done

OR3 Network is ready only when:

- the chat-side exchange path is provider-agnostic
- `or3-node` replaces the old sandbox assumption in the active production plan
- service launch is either hardened and enabled or clearly gated and absent from the default UX
- all active docs describe the same architecture

## References

- `../README.md`
- `../../../src/auth/service.ts`
- `../../../src/contracts/platform/auth.ts`
- `../../../docs/api/http-api.md`
- `../../../or3-node/README.md`
- `../../../or3-node/src/runtime-capabilities.ts`
- `../../../or3-node/docs/platform-support.md`
- `../../../or3-node/docs/release-gates.md`
