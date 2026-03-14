# OR3 Net Plan — Node Protocol

## Goal

Define one small execution contract that works for both sandbox-backed nodes and future remote nodes without baking transport or runtime assumptions into the payloads.

## Core objects

### `NodeManifest`

Required identity and scheduling fields:

- `node_id`
- `pubkey`
- `signature`
- `adapter_kind`
- `capabilities`
- `isolation_class`
- `supports_transports`
- `resource_limits`
- `lease_policy`
- `certification`
- `version`

### `TaskPackage`

Host-issued execution bundle:

- `workspace_id`
- `job_id`
- `kind`
- `instructions`
- `artifacts`
- `tool_policy`
- `timeout`
- `lease_profile`
- `subagent_policy`

### `Lease`

Scheduler-issued runtime claim:

- `lease_id`
- `node_id`
- `profile`
- `ttl`
- `reset_required`
- `state`

## RPC operations

- `handshake(manifest)` -> enrollment acknowledgment / challenge result
- `execute(task_package)` -> execution event stream
- `heartbeat()` -> node health + capacity snapshot
- `abort(job_id)` -> abort acknowledgment

## Protocol invariants

- Same RPC semantics across HTTPS/WSS and outbound WSS.
- Nodes do not receive whole workspace state; they receive explicit task packages only.
- Job IDs, lease IDs, and terminal states are host-owned.
- Node-side subagents are bounded by host-issued policy; nodes do not invent broader permissions.
- Heartbeats inform scheduling but do not replace durable lease state in `or3-net` SQLite.

## v1 execution model

- `or3-net` is the source of truth for approval, scheduling, and lease issuance.
- Nodes are execution workers, not autonomous peers.
- Sandbox-backed nodes are the reference implementation for the protocol.