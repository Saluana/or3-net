# 2. OR3 Chat

## Repo Role

`or3-chat` is the browser-facing OR3 Net client and the identity/workspace authority.

That means the cleanest integration is:

- browser talks to `or3-chat`
- `or3-chat` server resolves session and workspace
- `or3-chat` server bridges into `or3-net`

## Simplification Decision

Do not make the browser acquire provider-specific OR3 Net proof.

Preferred v1 pattern:

- add a server-side OR3 Net exchange adapter in `or3-chat`
- keep the browser composable unaware of Clerk/basic-auth details
- keep exchanged OR3 Net token in memory only

## Why This Is Better

- better DX: one flow regardless of auth provider
- better UX: fewer confusing auth failure states
- better security: proof minting stays server-side
- less code: no new provider-specific browser code paths

## Planned Surfaces

### Server-side adapter

Add an SSR route or server utility that:

- [x] resolves authenticated session
- [x] resolves active workspace
- [x] mints `or3-chat-assertion-v1`
- [x] exchanges with `or3-net`
- [x] returns OR3 Net workspace token to the client composable

Suggested files:

- `server/api/or3-net/exchange.post.ts`
- `server/utils/or3-net/assertion.ts`

### Client composables

- [x] `app/composables/or3-net/useOr3NetAuth.ts`
- [x] `app/composables/or3-net/useOr3NetClient.ts`
- [x] `app/composables/or3-net/useOr3NetSession.ts`
- [x] `app/composables/or3-net/useOr3NetJobStream.ts`

The client composables should call the local adapter first, not providers directly.

### UI

- [x] plugin shell
- [ ] agent CRUD
- [x] job submit/list/detail
- [x] stream view
- [x] preview pane
- [x] service actions only when capability is present

## UX Rules

- jobs and previews are core
- service-launch is optional capability UX, not assumed baseline UX
- if a node only supports `exec`, `file-*`, and `pty`, the UI should still feel complete
- do not show dead buttons for service launch

## Milestones

### M0: Update planning assumptions

- [x] update chat-side planning docs to remove provider-direct OR3 Net proof as the default path
- [ ] update chat-side planning docs to reference `or3-node` instead of `or3-sandbox` on the active path

### M1: Adapter route

- [x] implement server-side exchange adapter
- [x] gate it behind SSR auth and OR3 Net host config
- [x] return clean error states to the client

### M2: Auth client

- [x] build `useOr3NetAuth` around the local adapter route
- [x] keep OR3 Net token in memory only
- [x] invalidate on workspace switch

### M3: Jobs and previews

- [ ] implement agent UI
- [x] implement baseline job submit/list/detail UI
- [x] implement stream reconnect
- [x] implement preview pane UX

### M4: Capability-aware service UX

- [x] read service capability from OR3 Net node/service payloads
- [x] only show launch actions when real capability exists

## Tests

- [x] exchange adapter happy path
- [x] exchange adapter unauthenticated path
- [x] exchange adapter wrong-workspace path
- [x] workspace switch invalidation
- [x] session binding recovery
- [x] jobs page list/detail behavior
- [x] stream reconnect
- [x] preview fallback
- [x] service launch hidden when capability absent

## Definition Of Done

This repo is done only when:

- the browser path is provider-agnostic
- the chat server owns the exchange bridge
- the UI feels complete without assuming service-launch is always present

## References

- `../README.md`
- `../../../../or3/or3-chat/planning/or3-net-plan.md`
- `../../../../or3/or3-chat/app/composables/auth/useSessionContext.ts`
- `../../../../or3/or3-chat/app/composables/auth/useAuthTokenBroker.client.ts`
- `../../../../or3/or3-chat/app/plugins/convex-sync.client.ts`
- `../../../../or3/or3-chat/app/plugins/notification-listeners.client.ts`
