# Runtime Contract

`src/contracts/runtime/` defines the typed runtime substrate used by `or3-net` to describe execution backends, runtime nodes, runtime sessions, execution requests, artifacts, and runtime-specific errors.

## What lives here

- `capabilities.ts` — core runtime capabilities plus `ext:<adapter>:<name>` extension capabilities
- `manifest.ts` — `RuntimeAdapterManifest` and related enums for adapter kind, trust tier, locality, and session mode
- `descriptors.ts` — `RuntimeDescriptor`, `RuntimeNodeDescriptor`, and `RuntimeSessionDescriptor`
- `sessions.ts` — session input and state contracts
- `execution.ts` — execution request, handle, and stream event contracts
- `artifacts.ts` — runtime artifact descriptors
- `errors.ts` — `RuntimeError`, `RuntimeErrorEnvelope`, and API-envelope mapping
- `adapter.ts` — the `RuntimeAdapter` interface implemented by runtime providers

## Plugin model

Runtime providers register a manifest plus a `RuntimeAdapter` implementation at server startup through `RuntimeRegistry`.

The contract is intentionally provider-agnostic:

- core code branches only on declared capabilities
- adapter-specific extensions use the namespaced `ext:<adapter>:<name>` pattern
- unsupported operations must fail with normalized runtime errors rather than provider-specific exceptions

## Relationship to the rest of `or3-net`

This package does not replace the existing node protocol or sandbox SDK.

Instead, it wraps the current execution infrastructure behind a uniform contract:

- `SandboxRuntimeAdapter` wraps sandbox-style execution providers and warm-pool behavior when a deployment chooses to register one
- `RemoteNodeRuntimeAdapter` wraps node registry, lease scheduling, and remote execution
- `LocalContainerRuntimeAdapter` wraps local Docker-based development execution

Public runtime routes in `src/api/app.ts` and runtime services in `src/runtime/` consume these contracts directly.
