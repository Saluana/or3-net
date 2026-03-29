# 5. OR3 Provider Clerk

## Repo Role

With the host-signed exchange adapter, this repo moves off the critical path.

That is the point.

Instead of making Clerk a direct OR3 Net dependency in the browser flow, `or3-chat` should consume Clerk through its existing session/auth integration and present OR3 Net with one trusted host assertion.

## Expected Scope

Preferred v1 outcome:

- zero OR3 Net-specific code changes here
- zero Clerk-specific OR3 Net browser logic in `or3-chat`

## What Still Needs Verification

- [ ] `or3-chat` can always resolve the authenticated Clerk-backed session server-side
- [ ] `or3-chat` can always resolve the active workspace server-side
- [ ] no Clerk-specific claims are required by OR3 Net once the host assertion path exists

## When This Repo Would Need Work

Only if one of these becomes true:

- OR3 Net must support provider-direct exchange from clients other than `or3-chat`
- `or3-chat` cannot derive enough identity/workspace data from its current server-side session
- there is a separate operator or CLI path that truly needs Clerk-native proof

If none of those are true, do not add OR3 Net-specific work here.

## Definition Of Done

This repo is done only when:

- it has been explicitly verified that no OR3 Net-specific Clerk work is needed for v1
- or, if needed, the minimum change is documented and scoped tightly

## References

- `../README.md`
- `../../../../or3/or3-chat/app/composables/auth/useSessionContext.ts`
- `../../../../or3/or3-provider-clerk/src/runtime/plugins/auth-token-broker.client.ts`
