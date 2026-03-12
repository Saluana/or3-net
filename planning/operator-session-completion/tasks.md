# Operator Session Completion — Tasks

## 1. Lock the required behavior in tests first

- [x] [Req 1, 2] Add failing API tests in `tests/app.phase2.test.ts` for jobs list, API key list/create/revoke, and session detail/event routes.
- [x] [Req 2] Extend `tests/cli.test.ts` with job list, job abort, and API key management workflows.
- [x] [Req 2] Extend `tests/console.test.ts` with authenticated overview coverage for jobs, nodes, API keys, and previews/services.
- [x] [Req 3, 4] Add SQLite-backed tests in `tests/db.test.ts` for session bindings, event persistence, retention pruning, and workspace isolation.

## 2. Add the durable session-binding model

- [x] [Req 3, 5] Add additive schema and migrations in `src/db/schema.ts` for `network_sessions` and `job_events`.
- [x] [Req 3, 4] Add query helpers in `src/db/client.ts` for create/get/list/update session bindings and append/list pruned job events.
- [x] [Req 3] Introduce a small session binding service in `src/session/**` or an adjacent existing package that resolves `network_session_id`, `client_session_id`, and legacy `session_key` submissions into a canonical binding.
- [x] [Req 3, 5] Wire session binding updates (`last_job_id`, `last_activity_at`) into job submission and terminal completion paths.

## 3. Persist a bounded durable event projection

- [x] [Req 4] Update `src/execution/local-jobs.ts` so normalized job events are appended to `job_events` as they are emitted.
- [x] [Req 4] Add event sequence numbering and retention pruning logic in the DB/service layer.
- [x] [Req 4] Ensure stored event payloads respect bounded output constraints and do not inline oversized artifacts or secrets.

## 4. Add host API operator routes

- [x] [Req 1, 2] Extend `src/api/app.ts` with workspace job-list routes and filters over existing job state.
- [x] [Req 1, 2] Add API key create/list/revoke routes backed by `src/auth/service.ts` and `src/db/client.ts`.
- [x] [Req 1, 3, 4] Add session list/detail/event routes backed by the new binding and event projection helpers.
- [x] [Req 1] Add any small helper routes needed to expose node approval/health and preview/service visibility in a stable operator-facing shape.

## 5. Extend CLI and console over the same host API

- [x] [Req 2] Extend `cli/index.ts` with job list, job abort, API key create/list/revoke, and session inspection commands.
- [x] [Req 2] Extend `src/console/index.ts` to display jobs, nodes, API keys, previews/services, and session-linked inspection views.
- [x] [Req 2] Keep the console as a thin HTML client calling host API routes rather than reaching into service objects directly.

## 6. Preserve backward compatibility for job submission

- [x] [Req 3] Update the create-job contract in `src/execution/local-jobs.ts` and any route/schema helpers so callers can submit by `network_session_id`, `client_session_id`, or legacy `session_key`.
- [x] [Req 3, 5] Ensure legacy callers that only know `session_key` still work and are upgraded into durable session bindings transparently.
- [x] [Req 5] Document which parts of session state are canonical in `or3-chat`, `or3-net`, and `or3-intern`.

## 7. Align cross-repo ownership and docs

- [x] [Req 5] Update `/Users/brendon/Documents/or3-intern/planning/or3-net-plan.md` if the session-binding model changes how `or3-net` is expected to provide `session_key` inputs.
- [x] [Req 5] Update `/Users/brendon/Documents/or3/or3-chat/planning/or3-net-plan.md` with the new `network_session_id` / `client_session_id` expectations.
- [x] [Req 5] Update local docs or planning notes in `or3-net/planning/` so operator workflow and session ownership are explicit.

## 8. Out of scope

- [x] Do not duplicate full chat transcripts or memory stores inside `or3-net`.
- [x] Do not turn the built-in console into a separate SPA.
- [x] Do not replace `or3-intern`’s `session_key` as the execution identity; bind to it explicitly instead.
- [x] Do not introduce multi-tenant federation or cross-host session replication.
