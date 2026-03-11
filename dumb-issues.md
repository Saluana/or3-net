## Remote abort is fake

Exact refs:
- `src/execution/local-jobs.ts:92-102`
- `src/execution/local-jobs.ts:198-236`
- `src/execution/local-jobs.ts:369-384`

Why this is bad:
Remote jobs never populate `backendJobIds`, so `abortJob()` takes the `backendJobId === undefined` branch every time and immediately calls `finalizeAbort()`. That only mutates host state. It does not cancel sandbox execution, does not tell a remote transport to stop, and does not release anything downstream. The UI gets a clean `{ ok: true }` while the remote job keeps running.

Real-world consequence:
As soon as you have approved nodes, abort becomes fiction. Users think work stopped. It did not. The remote process keeps burning compute, can keep mutating files, and can still complete after the host already marked the job aborted.

Concrete fix:
Track remote execution handles the same way local execution tracks backend job IDs, then route abort through the active backend:

```ts
interface RemoteExecutionHandle {
  abort(): Promise<void>;
}

private readonly remoteHandles = new Map<string, RemoteExecutionHandle>();

public async abortJob(workspaceId: string, jobId: string): Promise<{ ok: boolean; job_id: string }> {
  void this.getJob(workspaceId, jobId);

  const remoteHandle = this.remoteHandles.get(jobId);
  if (remoteHandle !== undefined) {
    await remoteHandle.abort();
    this.finalizeAbort(workspaceId, jobId);
    return { ok: true, job_id: jobId };
  }

  const backendJobId = this.backendJobIds.get(jobId);
  if (backendJobId !== undefined) {
    await this.options.internClient.abortJob(backendJobId);
    this.finalizeAbort(workspaceId, jobId);
    return { ok: true, job_id: jobId };
  }

  this.pendingAbortJobs.add(jobId);
  this.finalizeAbort(workspaceId, jobId);
  return { ok: true, job_id: jobId };
}
```

Tests to add:
- prove `abortJob()` invokes the remote executor abort path for remote jobs
- prove no `job.completed` event is persisted after a successful remote abort
- prove remote abort also clears or releases the associated lease

## Your leases never get released on remote completion

Exact refs:
- `src/execution/local-jobs.ts:198-236`
- `src/scheduler/scheduler.ts:18-90`
- `src/db/client.ts:412-442`

Why this is bad:
`issueLease()` creates an active lease and `countActiveLeases()` uses those rows for scheduling pressure. Nothing in `runRemoteTask()` marks the lease released when the job completes, fails, or is aborted. So capacity only comes back after TTL expiry or startup reconciliation. That is not scheduling. That is self-inflicted starvation.

Real-world consequence:
A node with `max_concurrent_jobs = 1` can finish a job successfully and still be considered busy for minutes. Under load, the scheduler starts throwing “no approved node is currently available” while the node is sitting idle.

Concrete fix:
Capture the returned lease from `issueLease()` and release it in a `finally` block around remote execution:

```ts
const leaseRecord = scheduler.issueLease({
  workspace_id: workspaceId,
  job_id: jobId,
  task_package: taskPackage,
});

try {
  const result = await this.executeRemoteTask(workspaceId, node.manifest.adapter_kind, node, taskPackage);
  // publish terminal success
} finally {
  this.options.database.workspace(workspaceId).saveLease({
    workspace_id: workspaceId,
    job_id: jobId,
    lease: {
      ...leaseRecord.lease,
      state: "released",
    },
    created_at: leaseRecord.created_at,
    expires_at: leaseRecord.expires_at,
    released_at: new Date().toISOString(),
  });
}
```

Tests to add:
- prove a completed remote job no longer counts against scheduler capacity
- prove failed and aborted remote jobs also release the lease
- prove a second job can be scheduled immediately after the first remote job finishes

## Malformed JSON becomes a 500 and leaks internals

Exact refs:
- `src/api/app.ts:385-386`
- `src/api/app.ts:527-532`
- `src/api/app.ts:535-552`

Why this is bad:
`readOptionalJson()` calls `JSON.parse()` directly. A bad body throws `SyntaxError`, and `handleAppRequest()` turns that into a 500 with the raw error message. That is the wrong class of failure and the wrong payload. Invalid client JSON is a 400. Returning parser text to callers is just leaking implementation detail for free.

Real-world consequence:
Any typo in a preview launch request gets reported as a server fault. Monitoring lies, clients retry a non-retriable error, and you hand attackers one more source of noisy internal behavior.

Concrete fix:
Normalize malformed JSON at the boundary and treat it as a request error:

```ts
const readOptionalJson = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
};
```

Tests to add:
- `POST /v1/workspaces/:workspaceId/previews/:previewId/launch` with malformed JSON returns 400
- response body is a stable client-facing error, not engine-specific parser text

## Preview launch capabilities leak memory forever

Exact refs:
- `src/previews/service.ts:25-27`
- `src/previews/service.ts:90-109`
- `src/previews/service.ts:141-176`

Why this is bad:
Every launch inserts into `launchCapabilities`, `previewLaunchTokens`, and maybe `scopedLaunchTokens`. Revocation only flips a boolean. Expiry does not prune anything. Resolution does not prune anything. The reverse indexes are never cleaned up. This service is a permanent in-memory junk drawer keyed by every preview launch the process has ever seen.

Real-world consequence:
Long-lived processes accumulate dead launch capabilities forever. Memory climbs with every dashboard open and preview launch. Restarting the process becomes your garbage collector.

Concrete fix:
Delete expired or revoked capabilities and remove their token references from the reverse indexes:

```ts
private deleteCapability(token: string, capability: LaunchCapability): void {
  this.launchCapabilities.delete(token);

  if (capability.preview_id !== undefined) {
    const previewTokens = this.previewLaunchTokens.get(capability.preview_id);
    previewTokens?.delete(token);
    if (previewTokens?.size === 0) this.previewLaunchTokens.delete(capability.preview_id);
  }

  if (capability.scope_key !== undefined) {
    const scopedTokens = this.scopedLaunchTokens.get(capability.scope_key);
    scopedTokens?.delete(token);
    if (scopedTokens?.size === 0) this.scopedLaunchTokens.delete(capability.scope_key);
  }
}
```

Then call it from expiry, revoke, and successful resolution cleanup paths.

Tests to add:
- prove expired capabilities are removed after lookup
- prove preview revoke empties both the capability map and reverse index entries
- prove repeated service launch/revoke cycles do not grow internal token sets unbounded

**Findings**
- High: Remote-job abort is not wired to remote execution. [`local-jobs.ts#L92`](/Users/brendon/Documents/or3-net/src/execution/local-jobs.ts#L92) only knows how to cancel intern-backed jobs and otherwise marks the job aborted locally; the remote path never checks `pendingAbortJobs` or forwards an abort to the node [`local-jobs.ts#L198`](/Users/brendon/Documents/or3-net/src/execution/local-jobs.ts#L198), [`executor.ts#L13`](/Users/brendon/Documents/or3-net/src/nodes/executor.ts#L13). That leaves 2.3/4.3 incomplete and can let remote work continue after the API says it was aborted.

- High: The sandbox SDK is not compatible with the real `or3-sandbox` API. `execStream()` omits `?stream=1` and assumes JSON SSE frames [`client.ts#L39`](/Users/brendon/Documents/or3-net/sdk/sandbox/client.ts#L39), while the daemon only streams with that query flag and emits raw text `stdout`/`stderr` chunks [`router.go#L456`](/Users/brendon/Documents/or3-sandbox/internal/api/router.go#L456), [`router.go#L1558`](/Users/brendon/Documents/or3-sandbox/internal/api/router.go#L1558). The create/file/tunnel types are also mismatched [`types.ts#L1`](/Users/brendon/Documents/or3-net/sdk/sandbox/types.ts#L1), [`model.go#L124`](/Users/brendon/Documents/or3-sandbox/internal/model/model.go#L124), [`model.go#L222`](/Users/brendon/Documents/or3-sandbox/internal/model/model.go#L222), and most required endpoints are missing entirely [`types.ts#L46`](/Users/brendon/Documents/or3-net/sdk/sandbox/types.ts#L46). P0.2 is still unfinished.

- High: The node transport layer is still mostly a stub. Remote execution only sends `execute` request/response [`executor.ts#L13`](/Users/brendon/Documents/or3-net/src/nodes/executor.ts#L13); `stream()` is unused [`transport.ts#L3`](/Users/brendon/Documents/or3-net/src/nodes/transport.ts#L3), outbound WSS is only an injected handler [`transport-wss.ts#L5`](/Users/brendon/Documents/or3-net/src/nodes/transport-wss.ts#L5), HTTPS transport sends no issued node credential [`transport-https.ts#L15`](/Users/brendon/Documents/or3-net/src/nodes/transport-https.ts#L15), and issued node credentials are never consumed beyond storage [`registry.ts#L50`](/Users/brendon/Documents/or3-net/src/nodes/registry.ts#L50). Managed-mode certification also never affects scheduling: the scheduler only checks approval/health/capabilities/isolation [`scheduler.ts#L38`](/Users/brendon/Documents/or3-net/src/scheduler/scheduler.ts#L38) even though `certification` exists in the contract [`core.ts#L88`](/Users/brendon/Documents/or3-net/src/contracts/core.ts#L88). That leaves 3.2, 4.4, 4.6, 7.1, and 7.2 unfinished.

- Medium: `or3-net` still lacks several required host/operator surfaces. The DB can list jobs [`client.ts#L405`](/Users/brendon/Documents/or3-net/src/db/client.ts#L405), but the API exposes only job create/get/stream/abort and has no job-list or API-key-management routes [`app.ts#L51`](/Users/brendon/Documents/or3-net/src/api/app.ts#L51), [`app.ts#L57`](/Users/brendon/Documents/or3-net/src/api/app.ts#L57). The CLI only implements `auth exchange`, `nodes list/enroll/approve`, `jobs submit/get/stream`, and `agents list` [`index.ts#L26`](/Users/brendon/Documents/or3-net/cli/index.ts#L26). The built-in console is an unauthenticated HTML page [`app.ts#L38`](/Users/brendon/Documents/or3-net/src/api/app.ts#L38) that only lists nodes/agents/previews, submits a job, and launches services [`index.ts#L30`](/Users/brendon/Documents/or3-net/src/console/index.ts#L30); it does not provide the required overview, approval queue, API key management, or job-stream switching.

- Medium: The `or3-intern` service/SDK contract still diverges from the planned prerequisite surface. Turns and subagents accept `allowed_tools` allowlists rather than a real `tool_policy`, and subagents require `parent_session_key` [`service.go#L26`](/Users/brendon/Documents/or3-intern/cmd/or3-intern/service.go#L26), [`service.go#L34`](/Users/brendon/Documents/or3-intern/cmd/or3-intern/service.go#L34), [`types.ts#L1`](/Users/brendon/Documents/or3-net/sdk/intern/types.ts#L1). The SSE event model is also broader than the planned typed surface, with extra lifecycle/status variants not clearly frozen in docs [`service.go#L102`](/Users/brendon/Documents/or3-intern/cmd/or3-intern/service.go#L102), [`job_registry.go#L153`](/Users/brendon/Documents/or3-intern/internal/agent/job_registry.go#L153). P0.1/P0.3 are not fully locked down yet.

- Medium: `POST /internal/v1/subagents` is conditional, not guaranteed. Service mode returns `503` when no subagent manager is configured [`service.go#L161`](/Users/brendon/Documents/or3-intern/cmd/or3-intern/service.go#L161), so one of the advertised prerequisite endpoints only exists when subagents are separately enabled.

**Notes**
`bun test` in `/Users/brendon/Documents/or3-net` passes (`53/53`). I did not run the Go test suites in `or3-intern` or `or3-sandbox`; those findings are from code and test inspection.

The main remaining work is: finish the sandbox SDK against the real API, complete remote-node transport/abort/auth/certification enforcement, and add the missing job-list/API-key/operator CLI and console surfaces.