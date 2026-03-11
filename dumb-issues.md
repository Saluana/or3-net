## `INSERT OR REPLACE` is deleting live state

Exact refs:
- `src/db/client.ts:195-217`
- `src/db/client.ts:240-266`
- `src/db/client.ts:347-372`
- `src/db/client.ts:399-423`
- `src/db/client.ts:444-475`
- `src/db/client.ts:542-561`
- `src/db/schema.ts:200-214`

Why this is bad:
`REPLACE` in SQLite is not an update. It is `DELETE` + `INSERT`. You used it on parent rows that have `ON DELETE CASCADE` children. That means a normal status update can wipe dependent state. Updating a job can delete its lease. Updating a node can delete its credentials. Updating a workspace can delete its agents, jobs, previews, and everything else hanging off it.

Real-world consequence:
Routine state transitions become silent data loss. Recovery, auth, lease tracking, and operator visibility all become fiction because the rows you thought you were updating are being destroyed underneath you.

Concrete fix:
Stop using `REPLACE` on relational tables. Use real upserts:

```sql
INSERT INTO jobs (id, workspace_id, status, ...)
VALUES (?, ?, ?, ...)
ON CONFLICT(id) DO UPDATE SET
  status = excluded.status,
  node_id = excluded.node_id,
  result_json = excluded.result_json,
  error_json = excluded.error_json,
  started_at = excluded.started_at,
  completed_at = excluded.completed_at;
```

Add regression tests proving that `saveJob()`, `saveNode()`, and `saveWorkspace()` preserve existing child rows.

## Your tenant boundary is fake because IDs are global

Exact refs:
- `src/db/schema.ts:202-212`
- `src/db/client.ts:240-266`
- `src/db/client.ts:444-475`
- `src/nodes/registry.ts:30-43`

Why this is bad:
`nodes.id`, `previews.id`, `agents.id`, `jobs.id`, and `leases.id` are all global primary keys, while the code pretends the store is workspace-scoped. It is not. I reproduced this: saving `node_same` in `ws_b` removed the `ws_a` node row entirely; same story for `preview_same`.

Real-world consequence:
Two workspaces reusing the same node ID or preview ID can clobber each other’s records. With cascades in play, that can also wipe credentials and leases. That is a hard workspace-isolation break, not a cosmetic schema nit.

Concrete fix:
Make identity workspace-scoped in the schema:

```sql
CREATE TABLE nodes (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ...,
  PRIMARY KEY (workspace_id, id)
);
```

Do the same for dependent foreign keys and all other workspace-owned tables, or introduce surrogate row IDs plus `UNIQUE(workspace_id, external_id)`.

## The “workspace-scoped store” does not enforce workspace consistency

Exact refs:
- `src/db/client.ts:195-217`
- `src/db/client.ts:347-423`
- `src/db/client.ts:444-475`
- `src/db/schema.ts:204-208`

Why this is bad:
The store writes `this.workspaceId` into table columns, but it does not validate the embedded `workspace_id` inside the payloads it serializes, and the foreign keys are not workspace-scoped. That lets you persist contradictory records where the row lives in workspace A and the serialized contract says workspace B.

Real-world consequence:
You can create cross-tenant garbage that the database cannot reject. Downstream code consuming serialized `task_package.workspace_id`, preview descriptors, or lease relations can make authorization decisions on poisoned data.

Concrete fix:
Reject mismatches at the store boundary:

```ts
if (job.workspace_id !== this.workspaceId) {
  throw new Error("workspace mismatch");
}
```

Then redesign foreign keys around `(workspace_id, id)` pairs so SQLite enforces the boundary instead of trusting callers to behave.

## The public job API ignores the scheduler and node path entirely

Exact refs:
- `src/api/app.ts:148-152`
- `src/scheduler/scheduler.ts:18-66`
- `src/nodes/adapter-sandbox.ts:22-36`

Why this is bad:
`POST /v1/workspaces/:workspaceId/jobs` always calls `localJobService.submitJob(...)`. It never consults the scheduler, never issues a lease, never selects a node, and never touches the sandbox adapter. The node control plane exists on paper and in isolated tests, but the public API bypasses it completely.

Real-world consequence:
Approved nodes are dead code for real job submissions. Operators will think they have remote execution when every request still runs against the local intern path. Observability is wrong, lease recovery is impossible, and node failures are irrelevant because nodes are never used.

Concrete fix:
Introduce a real job router service. `handleCreateJob()` should persist the job, choose local vs remote execution, issue a lease when remote, update `jobs.node_id`/`lease_id`, and dispatch through either the intern client or node adapter.

## Abort success is a lie, and clean EOF can strand jobs forever

Exact refs:
- `src/execution/local-jobs.ts:78-87`
- `src/execution/local-jobs.ts:123-175`
- `src/execution/job-streams.ts:27-56`

Why this is bad:
`abortJob()` returns `{ ok: true }` without persisting any state transition. Separately, `runLocalTurn()` just falls off the end if the backend stream ends without a terminal event. That leaves jobs stuck in `scheduled` or `running`, and SSE readers can hang until startup reconciliation cleans up the mess later.

Real-world consequence:
Users can click abort, get a success response, and still see a forever-running job. Backend stream glitches can wedge jobs and streams in limbo. That is exactly the kind of host-state drift the design was supposed to prevent.

Concrete fix:
Persist `aborting` or `aborted` as soon as abort is acknowledged, and track whether a terminal event was seen during streaming. If the stream ends cleanly without one, mark the job failed or aborted and publish a terminal SSE event from host state.

## Terminal job state is not terminal

Exact refs:
- `src/execution/local-jobs.ts:178-245`

Why this is bad:
`applyEvent()` blindly rewrites whatever is already stored. If a late backend event arrives after `job.completed`, the host will happily overwrite the terminal state to `failed` or `aborted`, or vice versa. That is not durable state management. That is shrugging at event ordering.

Real-world consequence:
You can persist contradictory records with both a result and an error depending on event order. Anything reading job status later gets garbage.

Concrete fix:
Latch terminal state. Once a job reaches `completed`, `failed`, or `aborted`, ignore later conflicting events unless you have an explicit, validated recovery rule.

## Lease issuance leaves the job record wrong

Exact refs:
- `src/scheduler/scheduler.ts:44-65`
- `src/db/client.ts:374-423`

Why this is bad:
Issuing a lease only inserts the lease row and attaches `lease_id`. It does not update `jobs.status` to `scheduled` and does not set `jobs.node_id`. So the database can claim a job is still `pending` while an active lease already exists on a real node.

Real-world consequence:
Recovery, debugging, and node-drop handling all get harder because the canonical job row is lying about where the work is. Anything trying to reason from `jobs` alone will be wrong.

Concrete fix:
Wrap lease creation and job update in one transaction. Set `jobs.status = 'scheduled'`, `jobs.node_id = lease.node_id`, and `jobs.lease_id = lease.lease_id` atomically.

## Preview registration is an open redirect with extra steps

Exact refs:
- `src/contracts/previews.ts:31-48`
- `src/api/app.ts:228-235`
- `src/previews/service.ts:24-43`

Why this is bad:
The public API accepts arbitrary absolute `embed_url` and `launch_url`, stores them verbatim, and later returns them verbatim. That directly contradicts the security model that says previews should come from `or3-net` or the approved preview/tunnel layer.

Real-world consequence:
Anyone with `previews:write` can make the UI open or iframe an attacker-controlled origin while presenting it as a trusted workspace preview. That is a phishing vector and a policy bypass.

Concrete fix:
Do not accept raw browser URLs from callers. Store only trusted source metadata like `path`, `entry_path`, `service_id`, or a tunnel/preview handle. Mint server-owned launch and embed URLs at launch time, and enforce same-origin or an explicit preview-host allowlist.

## Preview revoke does not actually revoke anything

Exact refs:
- `src/previews/service.ts:24-55`

Why this is bad:
`revokePreview()` only flips DB state. Any `launch_url` already handed to a browser keeps working because nothing invalidates the underlying capability. Blocking future `/launch` calls is not revocation. It is paperwork.

Real-world consequence:
Users and operators think access was revoked, but previously issued browser URLs remain live until some unrelated timeout or backend shutdown happens.

Concrete fix:
Issue per-launch opaque capabilities and revoke the backing server-side state, or revoke the underlying signed URL / tunnel when preview access is revoked.

## Service launch bypasses the approval model and tunnels whatever is on port 3000

Exact refs:
- `src/api/app.ts:201-219`
- `src/nodes/adapter-sandbox.ts:40-68`
- `sdk/sandbox/client.ts:66-72`

Why this is bad:
Service list/launch only checks “node exists in this workspace.” It never requires `approved` or healthy status. Then `listServices()` hard-codes a launchable `openclaw` service on port `3000` for every sandbox node and returns the raw tunnel URL.

Real-world consequence:
Pending, revoked, or stale nodes can still expose dashboards. Worse, you are not even launching a declared service, you are tunneling whatever happens to be on port `3000`. That is both an approval-gate bypass and unintended service exposure.

Concrete fix:
Require `node.status === "approved"` plus a healthy runtime state before listing or launching services. Replace the hard-coded `openclaw` stub with explicit service descriptors sourced from node/runtime metadata. For sandbox-backed launches, mint short-lived signed browser URLs instead of returning the raw tunnel endpoint.
