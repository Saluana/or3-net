## The streaming path hammers SQLite for every token

- Location: `/Users/brendon/Documents/or3-net/src/execution/local-jobs.ts:486-575`, `/Users/brendon/Documents/or3-net/src/db/client.ts:246-260`, `/Users/brendon/Documents/or3-net/src/db/client.ts:735-757`, `/Users/brendon/Documents/or3-net/src/db/client.ts:760-801`
- Why this is bad: `applyEvent()` runs for `text.delta`, `tool.call`, and `tool.result`, but even those non-state-changing events still call `workspaceStore.getJob()`, `appendJobEvent()`, and `touchBinding()`. `getJob()` reparses the full `task_package_json` on every event. `appendJobEvent()` then does a `MAX(sequence)` query, an insert, a retention delete, and a reread. `touchBinding()` does read-update-read work again. This is a self-inflicted hot path.
- Real-world consequences: long streams will spend more time on SQLite churn and JSON parsing than on moving stream data. Throughput drops, WAL contention goes up, and reconnect storms turn into latency spikes.
- Concrete fix: split live-stream fanout from durable state updates. Keep lightweight per-job state in memory and persist only state transitions plus sampled or batched deltas.

```ts
interface ActiveJobState {
  status: Job["status"];
  networkSessionId: string | null;
  nextEventSequence: number;
}

if (event.event === "text.delta" || event.event === "tool.call" || event.event === "tool.result") {
  streamBroker.publish(jobId, event);
  bufferedEvents.push(event);
  return true;
}
```

## You copied the same expensive event-retention path twice

- Location: `/Users/brendon/Documents/or3-net/src/db/client.ts:760-801`, `/Users/brendon/Documents/or3-net/src/db/client.ts:949-998`
- Why this is bad: `appendJobEvent()` and `appendRuntimeSessionEvent()` are near-identical copies of the same `MAX(sequence) -> INSERT -> DELETE NOT IN (SELECT ... LIMIT ?) -> SELECT` routine. The duplication is already bad. Duplicating the same expensive algorithm is worse, because every bug fix and every optimization now has two places to drift.
- Real-world consequences: inconsistent retention behavior between job events and runtime-session events is inevitable, and any hot-path pain gets preserved twice.
- Concrete fix: extract one append helper and stop doing retention deletes inline on every write. If you really need per-stream trimming, delete by sequence threshold instead of a nested `NOT IN` subquery.

```ts
const appendRetainedEvent = (
  table: "job_events" | "runtime_session_events",
  keyColumn: "job_id" | "session_id",
  key: string,
  retention: number,
  payload: string,
) => {
  const nextSequence = getNextSequence(table, keyColumn, key);
  insertEvent(table, keyColumn, key, nextSequence, payload);
  deleteOlderThanSequence(table, keyColumn, key, nextSequence - retention);
};
```

## Lease scheduling is quadratic garbage

- Location: `/Users/brendon/Documents/or3-net/src/scheduler/scheduler.ts:33-72`, `/Users/brendon/Documents/or3-net/src/scheduler/scheduler.ts:143-145`, `/Users/brendon/Documents/or3-net/src/scheduler/scheduler.ts:214-215`, `/Users/brendon/Documents/or3-net/src/db/client.ts:571-576`, `/Users/brendon/Documents/or3-net/src/db/schema.ts:386-387`
- Why this is bad: `issueLease()` loads every lease, rewrites expired ones one by one, then computes `activeLeases` by filtering the entire lease array once per node. That is `O(nodes * leases)` before you even schedule anything. Remote-node eligibility then adds one `getActiveNodeCredential()` query per node, and that table is only indexed by `workspace_id`.
- Real-world consequences: remote job startup gets slower as the workspace ages. A workspace with many historical leases and many approved nodes turns scheduling into a CPU and query tax.
- Concrete fix: expire old leases with one SQL update, precompute active lease counts in one pass, and add a real credential lookup index.

```ts
const activeLeaseCounts = new Map<string, number>();
for (const lease of workspaceStore.listLeases()) {
  if (lease.lease.state === "active" && Date.parse(lease.expires_at) > nowMs) {
    activeLeaseCounts.set(lease.lease.node_id, (activeLeaseCounts.get(lease.lease.node_id) ?? 0) + 1);
  }
}
```

```sql
CREATE INDEX idx_node_credentials_lookup
ON node_credentials(workspace_id, node_id, rotated_at, expires_at);
```

## API-key auth is missing the index it actually uses

- Location: `/Users/brendon/Documents/or3-net/src/auth/service.ts:52-80`, `/Users/brendon/Documents/or3-net/src/auth/service.ts:111-118`, `/Users/brendon/Documents/or3-net/src/db/client.ts:1307-1314`, `/Users/brendon/Documents/or3-net/src/db/schema.ts:347-348`, `/Users/brendon/Documents/or3-net/src/db/schema.ts:382-383`
- Why this is bad: `authenticateBearerToken()` falls back to `authenticateApiKey()`, which hashes the presented key and calls `findActiveApiKeyByHash()`. The schema only gives you `idx_api_keys_workspace_id`. There is no index on `key_hash`, which means the authentication path is doing a full table scan across API keys.
- Real-world consequences: every API-key-authenticated request gets slower as keys accumulate. It is also exactly the wrong place to waste CPU because this path is hit before the rest of the app can even reject the request.
- Concrete fix: add an index on `key_hash`. If you later scope the lookup by workspace earlier, use `(workspace_id, key_hash)`.

```sql
CREATE UNIQUE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
```

## Preview capability cleanup does a full sweep on every launch

- Location: `/Users/brendon/Documents/or3-net/src/previews/service.ts:123-136`, `/Users/brendon/Documents/or3-net/src/previews/service.ts:183-185`, `/Users/brendon/Documents/or3-net/src/previews/service.ts:271-283`, `/Users/brendon/Documents/or3-net/src/previews/service.ts:326-366`
- Why this is bad: `mintLaunchCapability()`, `mintFileLaunchCapability()`, and `resolveLaunchCapability()` all call `pruneExpiredLaunchCapabilities()`. That method linearly scans every live capability and every revoked capability. There is a cap for revoked tokens, but no cap for active launch capabilities.
- Real-world consequences: launch latency grows with stale capability count, and memory usage keeps growing until another launch/resolve comes along to do janitorial work.
- Concrete fix: stop sweeping the whole map on request paths. Keep expirations in a min-heap or bucketed timer, or only lazily validate the token being accessed and prune in a background interval.

## Outbound WSS execution buffers the whole stream twice and uses an `O(n)` queue

- Location: `/Users/brendon/Documents/or3-net/src/nodes/transport-wss.ts:95-146`, `/Users/brendon/Documents/or3-net/src/nodes/transport.ts:95-109`
- Why this is bad: `trackExecutionStream()` stores every raw `NodeEvent` in `events[]` so it can call `nodeEventsToResult()` later, while also queueing normalized events for downstream consumers. The queue uses `shift()`, which is `O(n)` once it starts backing up.
- Real-world consequences: large or chatty remote executions inflate heap usage linearly with total stream size, and any producer-consumer imbalance turns dequeue into repeated array compaction.
- Concrete fix: track only the terminal result or terminal error as you stream, and replace the array-backed queue with a deque or linked-list async channel.

```ts
let terminalResult = fallback;
let terminalError: Error | null = null;

for await (const event of stream) {
  if (event.event === "complete") terminalResult = event.data;
  if (event.event === "error") terminalError = new Error(event.data.message);
  const normalized = normalizeNodeEvent(event);
  if (normalized) channel.push(normalized);
}
```

## Sandbox exec output is built with quadratic string concatenation

- Location: `/Users/brendon/Documents/or3-net/src/runtime/adapters/sandbox.ts:236-279`
- Why this is bad: `collectExecResult()` does `stdout += chunk` and `stderr += chunk` for every streamed piece of output. That is the classic "copy the whole accumulated string again" trap. It is fine for tiny output and pathological for big output.
- Real-world consequences: large command output turns into repeated full-string copies, extra GC pressure, and a needless CPU tax right inside the runtime adapter.
- Concrete fix: collect chunks in arrays and `join("")` once, or expose a streamed sink and stop forcing the adapter to materialize giant strings.

```ts
const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

if (event.event === "stdout" && typeof event.data["chunk"] === "string") {
  stdoutChunks.push(event.data["chunk"]);
}

return {
  stdout: stdoutChunks.join(""),
  stderr: stderrChunks.join(""),
  // ...
};
```

## `JobStreamBroker` keeps a second copy of the whole job output in memory

- Location: `/Users/brendon/Documents/or3-net/src/execution/job-streams.ts:16-55`
- Why this is bad: every published event is appended to `state.history`, and every new subscriber gets the whole array replayed and re-encoded. You already persist durable events in SQLite. Keeping another full in-memory history per job is duplication with a memory bill attached.
- Real-world consequences: chatty jobs grow heap with output length, reconnect cost becomes proportional to total prior output, and you pay the JSON/SSE encoding cost again for every late subscriber.
- Concrete fix: cap in-memory history aggressively or keep only enough state for active subscribers. If replay matters, read recent history from the durable event store instead of hoarding everything in RAM.

## The node service endpoints are four copies of the same lookup bug

- Location: `/Users/brendon/Documents/or3-net/src/api/app.ts:536-604`
- Why this is bad: `handleListNodeServices()`, `handleLaunchNodeService()`, `handleRevokeNodeService()`, and `handleRestartNodeService()` all repeat the same `listNodes(...).find(...)`, `404`, and `ensureLaunchableNode(node)` logic. That is duplicated behavior and duplicated waste. It also loads and parses the whole node list on every request even though the database already has direct `getNode()` access.
- Real-world consequences: changes to launchability rules now have four drift sites, and every service action burns a full node-table scan instead of a keyed lookup.
- Concrete fix: extract one helper that fetches and validates the node once. Better yet, expose `getNode(workspaceId, nodeId)` from the registry/service layer and stop scanning.

```ts
private requireLaunchableNode(workspaceId: string, nodeId: string): StoredNode {
  const node = requireNodeRegistry(this.services.nodeRegistryService).getNode(workspaceId, nodeId);
  ensureLaunchableNode(node);
  return node;
}
```
