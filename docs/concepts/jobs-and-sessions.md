# Jobs and Sessions

This document explains the pieces of OR3 Net that most callers interact with first.

## Jobs

A **job** is the control-plane record for requested work.

A job contains the high-level facts the system needs to track:

- `job_id`
- `workspace_id`
- `status`
- creation and terminal timestamps
- optional result
- optional error

In practice, a job is paired with a `TaskPackage`, which carries the instructions and scheduling requirements used by the execution path.

## Job lifecycle

A job usually moves through these states:

- `pending`
- `scheduled`
- `running`
- `completed`
- `failed`
- `aborted`

Not every backend uses every state in exactly the same way, but the control plane preserves this shared lifecycle.

## Job events

OR3 Net stores job events separately from the job row.
This matters for two reasons:

1. the current job state stays easy to query
2. stream history remains available even after the job reaches a terminal state

Examples of job stream events include:

- `job.accepted`
- `job.started`
- `text.delta`
- `tool.call`
- `tool.result`
- `job.completed`
- `job.failed`
- `job.aborted`

The in-memory `JobStreamBroker` handles live fanout.
The database handles retained history.

## Network sessions

A **network session** represents the caller-side session identity that jobs belong to.

This is useful when a caller reconnects or submits multiple related jobs.
Instead of treating every request as unrelated, OR3 Net can bind them to one durable session record.

Network sessions can be resolved from:

- an existing `network_session_id`
- a `client_kind` plus `client_session_id`
- a `session_key`

This logic lives in [src/session/service.ts](../../src/session/service.ts).

## Why network sessions exist

Without network sessions, the control plane could still run jobs, but it would lose important context:

- which client thread or conversation a job belongs to
- the last job associated with a caller
- activity timestamps for session-aware UX or analytics
- a stable `PlatformSessionRef` that downstream systems can use

## Platform session reference

When OR3 Net resolves a network session, it can also produce a `PlatformSessionRef`.

This is the normalized public session identity that downstream APIs and Intern-aware flows use.

It contains:

- `workspace_id`
- `client_kind`
- `client_session_id`
- `network_session_id`
- `session_key`

## Runtime sessions

A **runtime session** is not the same thing as a network session.

A runtime session is an adapter-managed execution environment.
Examples:

- a running sandbox instance
- a local Docker container
- a remote node lease mapped into the runtime adapter contract

Runtime sessions matter when you need an environment that persists across multiple operations, such as:

- multiple exec calls
- staged workspace content
- file transfers
- service exposure
- later commit or discard of changes

## How jobs and runtime sessions fit together

A simple job can run without the caller ever thinking about runtime sessions.
That is the right default mental model.

Runtime sessions show up when the system needs more than one-shot execution.

A useful way to think about it is:

- **job** = work request
- **network session** = caller identity continuity
- **runtime session** = execution environment continuity

## Common mistakes

### Mistake: treating `session_key` as a runtime session id

`session_key` belongs to the network-session and Intern-facing side.
It is not the same as `runtime_session_id`.

### Mistake: assuming job history only exists in the live stream

Live streaming is only one view.
OR3 Net also retains structured job events.

### Mistake: assuming abort means no persisted record exists

Even aborted work remains part of control-plane history.
The terminal state changes, but the job record still exists.

## Related docs

- [Mental Model](mental-model.md)
- [Runtimes and Nodes](runtimes-and-nodes.md)
- [HTTP API](../api/http-api.md)
