# OR3 Net Bug Audit

Static bug audit performed on the repository source under `src/`.

## Scope and limitations

- This was a **static review** of the checked-in source files.
- I attempted to run the repository validation commands from `README.md` (`bun run typecheck && bun run lint && bun test`), but the environment does not have `bun` installed, so dynamic validation was not possible here.
- Because of that tooling limitation, treat this as a **best-effort file-by-file audit report**, not a proof that every runtime defect has been exhaustively reproduced.

## Confirmed bug findings

### 1. `src/auth/service.ts`

**Bug:** `authenticateBearerToken()` converts persisted API key timestamps with raw `Date.parse()` and returns the result directly as Unix seconds:

```ts
const issuedAt = Math.floor(Date.parse(apiKey.created_at) / 1000);
const expiresAt = apiKey.expires_at === null
  ? MAX_API_KEY_EXPIRY_SECONDS
  : Math.floor(Date.parse(apiKey.expires_at) / 1000);
```

**Why this is a bug:** if a persisted row ever contains a malformed timestamp, `Date.parse()` returns `NaN`. That means the returned `WorkspacePrincipal` can contain `issued_at: NaN` or `expires_at: NaN`, which violates the contract shape expected by callers and can silently corrupt auth responses.

**Impact:** malformed database state can leak invalid auth metadata into API consumers instead of failing closed.

**Suggested fix:** parse with the shared time helper and/or reject non-finite values before returning the principal.

## Test gaps related to the confirmed bug

### `tests/auth.principal.test.ts`

- The `"api key auth returns canonical principal fields"` test asserts ordering (`expires_at > issued_at`) but does not assert that `issued_at` and `expires_at` are finite numbers.
- There is no regression test covering malformed persisted API key timestamps.
- There is no direct test covering the flow “authenticate API key → revoke API key → verify bearer authentication fails”.

## File-by-file review appendix

Status legend:

- **Bug found**: a concrete defect was identified.
- **No concrete bug noted in static review**: no specific bug was identified during this pass.

### `src/api`

- `src/api/app.ts` — No concrete bug noted in static review.
- `src/api/index.ts` — No concrete bug noted in static review.
- `src/api/response-helpers.ts` — No concrete bug noted in static review.

### `src/agents`

- `src/agents/index.ts` — No concrete bug noted in static review.
- `src/agents/service.ts` — No concrete bug noted in static review.

### `src/auth`

- `src/auth/index.ts` — No concrete bug noted in static review.
- `src/auth/service.ts` — **Bug found:** persisted API key timestamps are converted with raw `Date.parse()`, which can produce `NaN` in the returned principal.
- `src/auth/tokens.ts` — No concrete bug noted in static review.

### `src/console`

- `src/console/index.ts` — No concrete bug noted in static review.

### `src/contracts`

- `src/contracts/core.ts` — No concrete bug noted in static review.
- `src/contracts/index.ts` — No concrete bug noted in static review.
- `src/contracts/previews.ts` — No concrete bug noted in static review.
- `src/contracts/protocol.ts` — No concrete bug noted in static review.
- `src/contracts/shared.ts` — No concrete bug noted in static review.

### `src/contracts/platform`

- `src/contracts/platform/auth.ts` — No concrete bug noted in static review.
- `src/contracts/platform/compat.ts` — No concrete bug noted in static review.
- `src/contracts/platform/error-codes.ts` — No concrete bug noted in static review.
- `src/contracts/platform/index.ts` — No concrete bug noted in static review.
- `src/contracts/platform/stream-events.ts` — No concrete bug noted in static review.
- `src/contracts/platform/types.ts` — No concrete bug noted in static review.

### `src/contracts/runtime`

- `src/contracts/runtime/adapter.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/artifacts.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/capabilities.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/descriptors.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/errors.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/execution.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/index.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/manifest.ts` — No concrete bug noted in static review.
- `src/contracts/runtime/sessions.ts` — No concrete bug noted in static review.

### `src/db`

- `src/db/client.ts` — No concrete bug noted in static review.
- `src/db/codecs.ts` — No concrete bug noted in static review.
- `src/db/control-plane-database.ts` — No concrete bug noted in static review.
- `src/db/event-retention.ts` — No concrete bug noted in static review.
- `src/db/index.ts` — No concrete bug noted in static review.
- `src/db/schema.ts` — No concrete bug noted in static review.
- `src/db/types.ts` — No concrete bug noted in static review.
- `src/db/workspace-store.ts` — No concrete bug noted in static review.

### `src/execution`

- `src/execution/job-streams.ts` — No concrete bug noted in static review.
- `src/execution/local-jobs.ts` — No concrete bug noted in static review.

### `src/lib`

- `src/lib/crypto.ts` — No concrete bug noted in static review.
- `src/lib/ids.ts` — No concrete bug noted in static review.
- `src/lib/time.ts` — No concrete bug noted in static review.

### `src/nodes`

- `src/nodes/adapter-cloudflare-sandbox.ts` — No concrete bug noted in static review.
- `src/nodes/adapter-opensandbox.ts` — No concrete bug noted in static review.
- `src/nodes/execution-adapter.ts` — No concrete bug noted in static review.
- `src/nodes/executor.ts` — No concrete bug noted in static review.
- `src/nodes/index.ts` — No concrete bug noted in static review.
- `src/nodes/registry.ts` — No concrete bug noted in static review.
- `src/nodes/signatures.ts` — No concrete bug noted in static review.
- `src/nodes/transport-https.ts` — No concrete bug noted in static review.
- `src/nodes/transport-registry.ts` — No concrete bug noted in static review.
- `src/nodes/transport-wss.ts` — No concrete bug noted in static review.
- `src/nodes/transport.ts` — No concrete bug noted in static review.

### `src/previews`

- `src/previews/service.ts` — No concrete bug noted in static review.

### `src/runtime`

- `src/runtime/index.ts` — No concrete bug noted in static review.
- `src/runtime/registry.ts` — No concrete bug noted in static review.
- `src/runtime/selection.ts` — No concrete bug noted in static review.
- `src/runtime/sessions.ts` — No concrete bug noted in static review.
- `src/runtime/workspace-stage.ts` — No concrete bug noted in static review.

### `src/runtime/adapters`

- `src/runtime/adapters/cloudflare-sandbox.ts` — No concrete bug noted in static review.
- `src/runtime/adapters/index.ts` — No concrete bug noted in static review.
- `src/runtime/adapters/local-container.ts` — No concrete bug noted in static review.
- `src/runtime/adapters/opensandbox.ts` — No concrete bug noted in static review.
- `src/runtime/adapters/remote-node.ts` — No concrete bug noted in static review.

### `src/scheduler`

- `src/scheduler/index.ts` — No concrete bug noted in static review.
- `src/scheduler/scheduler.ts` — No concrete bug noted in static review.

### `src/session`

- `src/session/index.ts` — No concrete bug noted in static review.
- `src/session/service.ts` — No concrete bug noted in static review.

### `src/workspace`

- `src/workspace/files.ts` — No concrete bug noted in static review.
- `src/workspace/host-staging.ts` — No concrete bug noted in static review.

### Top-level `src`

- `src/index.ts` — No concrete bug noted in static review.
- `src/server.ts` — No concrete bug noted in static review.
