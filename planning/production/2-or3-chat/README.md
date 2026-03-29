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

- [ ] resolves authenticated session
- [ ] resolves active workspace
- [ ] mints `or3-chat-assertion-v1`
- [ ] exchanges with `or3-net`
- [ ] returns OR3 Net workspace token to the client composable

Suggested files:

- `server/api/or3-net/exchange.post.ts`
- `server/utils/or3-net/assertion.ts`

### Client composables

- [ ] `app/composables/or3-net/useOr3NetAuth.ts`
- [ ] `app/composables/or3-net/useOr3NetClient.ts`
- [ ] `app/composables/or3-net/useOr3NetStream.ts`

The client composables should call the local adapter first, not providers directly.

### UI

- [ ] plugin shell
- [ ] agent CRUD
- [ ] job submit/list/detail
- [ ] stream view
- [ ] preview pane
- [ ] service actions only when capability is present

## UX Rules

- jobs and previews are core
- service-launch is optional capability UX, not assumed baseline UX
- if a node only supports `exec`, `file-*`, and `pty`, the UI should still feel complete
- do not show dead buttons for service launch

## Milestones

### M0: Update planning assumptions

- [ ] update chat-side planning docs to remove provider-direct OR3 Net proof as the default path
- [ ] update chat-side planning docs to reference `or3-node` instead of `or3-sandbox` on the active path

### M1: Adapter route

- [ ] implement server-side exchange adapter
- [ ] gate it behind SSR auth and OR3 Net host config
- [ ] return clean error states to the client

### M2: Auth client

- [ ] build `useOr3NetAuth` around the local adapter route
- [ ] keep OR3 Net token in memory only
- [ ] invalidate on workspace switch

### M3: Jobs and previews

- [ ] implement agent/job UI
- [ ] implement stream reconnect
- [ ] implement preview pane UX

### M4: Capability-aware service UX

- [ ] read service capability from OR3 Net node/service payloads
- [ ] only show launch actions when real capability exists

## Tests

- [ ] exchange adapter happy path
- [ ] exchange adapter unauthenticated path
- [ ] exchange adapter wrong-workspace path
- [ ] workspace switch invalidation
- [ ] stream reconnect
- [ ] preview fallback
- [ ] service launch hidden when capability absent

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
