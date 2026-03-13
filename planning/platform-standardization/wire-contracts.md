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

- Job stream resume/reconnect semantics are endpoint-specific and must be documented alongside the route.
- Until resume is formalized, reconnect behavior is best-effort and callers should treat the stream as non-resumable.

## Retry and idempotency

The following operations should be safe to retry:

- auth exchange
- job submit (with idempotency key)
- job abort
- preview launch
- service launch

Retry behavior should prefer deduplication over duplicate side effects.
