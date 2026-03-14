# Compatibility Matrix

## Contract versions

Current baseline version: `v1`

## Boundaries

| Boundary | Consumer | Provider | Contract version | Fixture source |
|----------|----------|----------|------------------|----------------|
| Auth exchange | `or3-chat`, CLI, SDK | `or3-net` | `v1` | `tests/contracts/fixtures/auth-exchange.*.json` |
| Public error envelope | clients | `or3-net` | `v1` | `tests/contracts/fixtures/error-envelope.*.json` |
| Public stream events | clients | `or3-net` | `v1` | `tests/contracts/fixtures/job-stream-events.jsonl` |
| Public job stream endpoint | clients | `or3-net` | `v1` | `tests/app.phase2.test.ts`, `tests/local-jobs.test.ts` |
| Preview/service launch capability lifecycle | clients | `or3-net` | `v1` | `tests/previews.phase45.test.ts`, `tests/contracts/fixtures/capability-grant.json` |
| Intern service request/response | `or3-net` | `or3-intern` | `v1` | `tests/contracts/fixtures/intern-*.json*`, `../or3-intern/cmd/or3-intern/testdata/service_contract/*.json*` |
| Intern audit/session headers | `or3-net` | `or3-intern` | `v1` | `tests/sdk.clients.test.ts`, `../or3-intern/cmd/or3-intern/service_test.go` |
| Sandbox SDK/API contract | `or3-net` | `or3-sandbox` | `v1` | `tests/contracts/fixtures/sandbox-*.json*`, `../or3-sandbox/tests/contracts/fixtures/*.json*` |
| Sandbox exec stream normalization | `or3-net` | `or3-sandbox` | `v1` | `tests/local-jobs.test.ts`, `../or3-sandbox/tests/contracts/fixtures/sandbox-exec-stream-events.jsonl` |
| Idempotent auth/job submission | clients | `or3-net` | `v1` | `tests/app.phase2.test.ts` |
| Session binding | `or3-net` | internal | `v1` | `tests/contracts/fixtures/platform-session-ref.json` |
| Capability grants | clients | `or3-net` | `v1` | `tests/contracts/fixtures/capability-grant.json` |
| Audit context | `or3-net` | `or3-net`, `or3-intern` | `v1` | `tests/contracts/fixtures/audit-context.json`, `../or3-intern/cmd/or3-intern/testdata/service_contract/intern-turn-request.json` |

## Versioning policy

- Additive changes: minor contract revision within the same major version.
- Breaking changes: new contract version and updated fixtures.
- Compatibility shims must be documented if provider and consumer versions differ temporarily.

## CI policy

Fixture-backed contract tests must pass before merging changes that affect any listed boundary.

## Maintenance process

When a listed boundary changes:

1. Update the fixture or focused regression test named in this matrix.
2. Update the provider/consumer docs that describe the boundary.
3. Bump the contract version entry if the change is breaking; otherwise keep the version and note the additive change in the PR.
4. Keep the repo-local contract CI workflow green before touching downstream consumers.
