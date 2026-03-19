# Runtimes and Nodes

This document explains how OR3 Net chooses where work runs.

## Runtime adapters

A **runtime adapter** is OR3 Net’s abstraction for an execution backend.

The control plane does not want every caller to care about the differences between:

- a local container
- a sandbox
- a remote worker node

So it exposes a shared runtime contract instead.

That contract includes capabilities such as:

- create session
- destroy session
- exec
- copy in / copy out
- log access
- file browsing and file reads/writes
- workspace staging
- service exposure
- snapshots

See [src/contracts/runtime](../../src/contracts/runtime).

## Built-in runtime adapters

OR3 Net currently ships with three main built-in adapters plus one managed-provider option.

### Local container

The local-container adapter uses Docker on the host machine.

Use it when you want:

- a simple local development backend
- ephemeral container-based execution
- a backend with no external service dependency beyond Docker

### Sandbox

The sandbox adapter uses an API-driven sandbox backend.

Use it when you want:

- API-driven sandbox lifecycle
- filesystem operations
- file-based staging and service launch
- execution in a dedicated sandbox environment

Current built-ins in this family are:

- `OpenSandboxRuntimeAdapter` / `OpenSandboxNodeAdapter`
- `CloudflareSandboxRuntimeAdapter` / `CloudflareSandboxNodeAdapter` for managed deployments

### Cloudflare Sandbox

The Cloudflare sandbox adapter is a **managed-provider path** that runs through a Worker bridge.

Use it when you want:

- Cloudflare-managed execution environments
- Worker-routed preview URLs
- explicit HTTP bridge integration rather than direct Bun SDK coupling

Important constraints:

- preview routing requires `proxyToSandbox()` in the Worker bridge
- preview URLs require a custom wildcard domain
- `.workers.dev` is not enough for full preview support

### Remote node

The remote-node adapter presents approved remote nodes through the same runtime session contract.

Use it when you want:

- leased remote capacity
- node-based scheduling
- explicit capability and certification gating

## Capabilities

Runtimes and nodes advertise capabilities.
Selection and validation are capability-driven.

Examples include:

- `exec`
- `copy-in`
- `copy-out`
- `file-browse`
- `log-stream`
- `service-expose`
- `workspace-write`

A request can declare required capabilities.
If the chosen runtime does not satisfy them, OR3 Net rejects the request instead of making a hidden downgrade.

## Runtime selection

Runtime selection is handled by `RuntimeSelectionService`.

It considers:

- required capabilities
- preset support
- trust tier
- isolation class
- locality
- adapter health
- node health

This means OR3 Net does not just pick the first available backend.
It scores candidates against the request.

## Runtime sessions

A runtime session is an adapter-owned environment represented by a control-plane record.

Typical runtime session operations include:

- create
- exec
- stop
- destroy
- copy files in/out
- read logs
- inspect staging state
- commit or discard workspace changes

## Host workspace staging

One of the more important OR3 Net concepts is **workspace staging**.

This is how selected host files are materialized into a runtime session and later reconciled back to the host.

Why stage files instead of writing directly to the host?

Because staging provides:

- explicit selection of which paths are in scope
- transport flexibility such as archive or file API
- diffing between baseline, host, and exported state
- conflict detection during commit
- rollback support when applying writes back to the host

See [src/runtime/workspace-stage.ts](../../src/runtime/workspace-stage.ts).

## Nodes

A **node** is a remote worker that publishes a signed manifest.

That manifest describes things like:

- node id
- adapter kind
- capabilities
- isolation class
- supported transports
- resource limits
- lease policy
- optional certification

Nodes are not immediately trusted just because they exist.
They go through enrollment and approval.

## Node lifecycle

The usual node path looks like this:

1. node submits a signed manifest
2. OR3 Net verifies the signature
3. node is stored as `pending`
4. an operator or workflow approves the node
5. OR3 Net issues a short-lived runtime credential
6. the scheduler can now lease the node for work

## Leases

A **lease** is the short-lived assignment of a node to a job.

Leases exist because remote-node execution needs explicit ownership of capacity.
A lease tracks:

- the chosen node
- the requested profile
- TTL
- state
- whether reset is required

The `LeaseScheduler` evaluates eligibility before issuing a lease.

Eligibility can fail for reasons such as:

- node not approved
- stale health
- missing capability
- isolation mismatch
- no registered transport
- missing runtime credential
- invalid certification
- node already at capacity

## Previews and service launch

Runtimes and nodes can also produce browser-facing experiences.
OR3 Net models these as previews or service-launch capabilities.

Examples:

- a web dashboard exposed from a sandbox
- a file-backed static preview
- a signed launch URL for a private tunnel

The key point is that OR3 Net treats these as control-plane concepts with expiry and revocation, not just random URLs.

## Related docs

- [Mental Model](mental-model.md)
- [Jobs and Sessions](jobs-and-sessions.md)
- [HTTP API](../api/http-api.md)
- [OpenSandbox SDK](../sdk/opensandbox-sdk.md)
- [Cloudflare Sandbox SDK](../sdk/cloudflare-sandbox-sdk.md)
