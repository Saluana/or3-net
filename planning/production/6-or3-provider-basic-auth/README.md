# 6. OR3 Provider Basic Auth

## Repo Role

With the host-signed exchange adapter, this repo also moves off the critical path.

That is especially valuable here because the current token-broker surface returns `null`, which would otherwise force unnecessary OR3 Net-specific provider work.

## Expected Scope

Preferred v1 outcome:

- zero OR3 Net-specific code changes here
- `or3-chat` server resolves authenticated basic-auth session
- `or3-chat` server mints host assertion
- `or3-net` trusts the host assertion, not a basic-auth-specific proof artifact

## What Still Needs Verification

- [ ] `or3-chat` can resolve authenticated basic-auth session server-side
- [ ] `or3-chat` can resolve the correct active workspace for basic-auth users
- [ ] no OR3 Net-specific proof minting is needed inside the provider repo

## When This Repo Would Need Work

Only if one of these becomes true:

- the host-signed exchange adapter is rejected
- `or3-chat` cannot reliably resolve workspace-scoped identity from the existing basic-auth session
- a non-chat caller truly needs provider-direct exchange

If none of those are true, keep this repo unchanged for v1.

## Definition Of Done

This repo is done only when:

- it is explicitly verified that no OR3 Net-specific provider code is needed for v1
- or, if needed, the minimum unavoidable provider change is documented and isolated

## References

- `../README.md`
- `../../../../or3/or3-provider-basic-auth/src/runtime/server/token-broker/basic-auth-token-broker.ts`
- `../../../../or3/or3-provider-basic-auth/src/runtime/server/plugins/register.ts`
