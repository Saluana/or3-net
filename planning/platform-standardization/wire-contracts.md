# Wire Contracts

## JSON rules

- External/public JSON uses `snake_case`.
- Public timestamps use ISO 8601 strings.
- Stable IDs use resource prefixes such as `ws_`, `job_`, `node_`, `cap_`, `req_`.

## Error envelope

All non-streaming `4xx`/`5xx` responses at the `or3-net` boundary use:

```json
{
  "error": "human readable message",
  "code": "machine.readable_code",
  "status": 400,
  "request_id": "req_123",
  "retry_after_ms": 1000
}
```

`retry_after_ms` is present only when the caller should retry later, typically on `429`.

## Stable HTTP semantics

- `400`: malformed JSON, invalid parameter, schema violation
- `401`: invalid or expired auth
- `403`: workspace mismatch, missing scope, revoked capability
- `404`: missing resource inside the authorized workspace
- `409`: idempotency or state conflict
- `410`: expired capability
- `429`: explicit rate limit with retry metadata
- `5xx`: internal or upstream service failure without leaking internals

## Normalized stream event set

`or3-net` exposes the following upstream event names:

- `job.accepted`
- `job.started`
- `text.delta`
- `tool.call`
- `tool.result`
- `job.completed`
- `job.failed`
- `job.aborted`
- `error`

Every stream emits at most one terminal event.

## Resume/reconnect

- `GET /v1/jobs/:job_id/stream` does not currently accept a cursor or replay token.
- Reconnecting to that route replays only the in-memory history retained by the active `or3-net` process for the job, then resumes live events if the job is still running.
- Callers must treat the stream as non-resumable across host restarts or broker eviction and should fall back to `GET /v1/jobs/:job_id` plus durable session/job event APIs when they need recovery.
- Exactly one terminal event (`job.completed`, `job.failed`, or `job.aborted`) is emitted per stream; once that event is sent, the stream closes.

## Retry and idempotency

The following operations should be safe to retry:

- auth exchange
- job submit (with idempotency key)
- job abort
- preview launch
- service launch

Retry behavior should prefer deduplication over duplicate side effects.

Concrete rules:

- `POST /v1/auth/exchange` accepts `Idempotency-Key`; the same key plus the same canonical request body returns the stored token response until that stored response expires.
- `POST /v1/workspaces/:workspace_id/jobs` accepts `Idempotency-Key`; the same key plus the same canonical request body returns the original `202` job payload instead of creating a second job.
- Reusing an `Idempotency-Key` with a different canonical request body returns `409 resource.conflict`.
- `POST /v1/jobs/:job_id/abort` is idempotent and returns success even when the job is already terminal.
- Any `429` response must include both the HTTP `Retry-After` header and `retry_after_ms` in the error envelope.
