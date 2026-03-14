# Control-Plane Contract Level

Current supported control-plane contract level: `v1`

## `or3-net` ↔ `or3-sandbox`

`or3-net` currently depends on the `or3-sandbox` `v1` daemon surface for:

- `POST /v1/sandboxes`
- `GET /v1/sandboxes/:id`
- `DELETE /v1/sandboxes/:id`
- `POST /v1/sandboxes/:id/exec`
- `POST /v1/sandboxes/:id/exec?stream=1`
- file helpers under `/v1/sandboxes/:id/files/*`
- `POST /v1/sandboxes/:id/mkdir`
- tunnel lifecycle under `/v1/sandboxes/:id/tunnels` and `/v1/tunnels/:id*`
- runtime endpoints under `/v1/runtime/*`, `/v1/quotas/me`, and `/metrics`

The repo-level compatibility source remains [planning/platform-standardization/compatibility-matrix.md](../platform-standardization/compatibility-matrix.md). This stabilization plan narrows enforcement to the subset of sandbox endpoints that `or3-net` actively uses today.

### Enforcement

- Fixture-backed contract tests live in `tests/contracts/sandbox-sdk.contract.test.ts`.
- Behavioral regressions for the live SDK surface live in `tests/sdk.clients.test.ts`.
- CI runs `bun run test:contracts`, which includes both the fixture contract suite and `tests/sdk.clients.test.ts`.

## `or3-net` ↔ `or3-intern`

`or3-net` currently assumes the documented `or3-intern` internal service mode behavior in [../or3-intern/docs/api-reference.md](../../../or3-intern/docs/api-reference.md):

- `session_key` remains canonical, while aliases normalize at ingress.
- `tool_policy` and `allowed_tools` compatibility shims are accepted.
- turns and job inspection stream over SSE.
- `POST /internal/v1/jobs/:jobId/abort` remains idempotent for completed work.
- request context travels in headers while execution identity stays in body fields.

### Enforcement

- Shape fixtures live in `tests/contracts/intern-sdk.contract.test.ts`.
- SDK request/stream/abort behavior lives in `tests/sdk.clients.test.ts`.
- `tests/local-jobs.test.ts` and `tests/app.phase2.test.ts` cover host-side assumptions layered on top of Intern behavior.

## Drift policy

When one of these upstream contracts changes:

1. Update the upstream docs/fixtures first.
2. Update the matching `or3-net` fixture or regression test in the files above.
3. Keep `v1` only for additive-compatible changes; record a new version when behavior becomes breaking.
4. Do not broaden coverage beyond the endpoints and behaviors the control plane currently uses.
