# Compatibility Matrix

## Contract versions

Current baseline version: `v1`

## Boundaries

| Boundary | Consumer | Provider | Contract version | Fixture source |
|----------|----------|----------|------------------|----------------|
| Auth exchange | `or3-chat`, CLI, SDK | `or3-net` | `v1` | `tests/contracts/fixtures/auth-exchange.*.json` |
| Public error envelope | clients | `or3-net` | `v1` | `tests/contracts/fixtures/error-envelope.*.json` |
| Public stream events | clients | `or3-net` | `v1` | `tests/contracts/fixtures/job-stream-events.jsonl` |
| Intern service request/response | `or3-net` | `or3-intern` | `v1` | `tests/contracts/fixtures/intern-*.json*` |
| Sandbox SDK/API contract | `or3-net` | `or3-sandbox` | `v1` | `tests/contracts/fixtures/sandbox-*.json*` |
| Session binding | `or3-net` | internal | `v1` | `tests/contracts/fixtures/platform-session-ref.json` |
| Capability grants | clients | `or3-net` | `v1` | `tests/contracts/fixtures/capability-grant.json` |

## Versioning policy

- Additive changes: minor contract revision within the same major version.
- Breaking changes: new contract version and updated fixtures.
- Compatibility shims must be documented if provider and consumer versions differ temporarily.

## CI policy

Fixture-backed contract tests must pass before merging changes that affect any listed boundary.
