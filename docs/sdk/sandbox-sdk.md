# Sandbox SDK

This guide explains the `sdk/sandbox` package and how it fits into OR3 Net.

## What the Sandbox SDK is for

The Sandbox SDK is the TypeScript client for the sandbox service.

Use it when you need to program against sandbox APIs such as:

- sandbox lifecycle
- command execution
- filesystem operations
- workspace archive import/export
- tunnels and signed launch URLs
- runtime health and capacity queries

The main implementation is `HttpSandboxClient` in [sdk/sandbox/client.ts](../../sdk/sandbox/client.ts).

## Core idea

The sandbox service is an execution backend.
The Sandbox SDK talks to that backend directly.

OR3 Net uses this SDK internally to implement:

- the sandbox runtime adapter
- warm sandbox pooling
- sandbox-backed node service launches
- archive-based workspace staging

## Main interface

The transport-neutral interface is `SandboxClient`.

It covers five broad areas.

### 1. Sandbox lifecycle

- `create(...)`
- `list()`
- `get(...)`
- `delete(...)`
- `start(...)`
- `stop(...)`
- `suspend(...)`
- `resume(...)`

### 2. Execution

- `exec(...)`
- `execStream(...)`

### 3. Filesystem

- `readFile(...)`
- `writeFile(...)`
- `deleteFile(...)`
- `mkdir(...)`
- `importWorkspaceArchive(...)`
- `exportWorkspaceArchive(...)`

### 4. Tunnels

- `createTunnel(...)`
- `listTunnels(...)`
- `revokeTunnel(...)`
- `createSignedTunnelUrl(...)`

### 5. Runtime and quota introspection

- `runtimeInfo()`
- `runtimeHealth()`
- `runtimeCapacity()`
- `getQuota()`
- `getMetrics()`

## Authentication model

Unlike the Intern SDK, the sandbox SDK uses a static bearer token supplied at client construction time.

```ts
const client = new HttpSandboxClient({
  baseUrl: 'http://127.0.0.1:8080',
  token: process.env.SANDBOX_TOKEN!,
});
```

## Request context propagation

The sandbox SDK can forward:

- `X-Request-Id`
- `X-Workspace-Id`

This is useful when OR3 Net wants sandbox-side logs or traces to line up with control-plane requests.

## Common usage

### Create a sandbox

```ts
const sandbox = await client.create({
  workspace_id: 'ws_demo',
  start: true,
});
```

### Run a command

```ts
const result = await client.exec(sandbox.id, {
  command: ['sh', '-lc', 'echo hello'],
});
```

### Stream execution output

```ts
for await (const event of client.execStream(sandbox.id, {
  command: ['sh', '-lc', 'for i in 1 2 3; do echo $i; done'],
})) {
  console.log(event.event, event.data);
}
```

### Read and write files

```ts
await client.writeFile(sandbox.id, {
  path: '/workspace/notes.txt',
  content: 'hello from the SDK',
});

const file = await client.readFile(sandbox.id, '/workspace/notes.txt');
```

### Create a tunnel and mint a signed URL

```ts
const tunnel = await client.createTunnel(sandbox.id, {
  target_port: 3000,
  protocol: 'http',
  auth_mode: 'token',
  visibility: 'private',
});

const signed = await client.createSignedTunnelUrl(tunnel.id, {
  path: '/',
  ttl_seconds: 300,
});
```

## Error handling

Failed requests are normalized into `SandboxRequestError`.

It includes:

- `status`
- optional parsed `response`
- optional `retryAfterMs`

That makes the client usable in retry-aware orchestration code without forcing callers to parse raw responses.

## Important constraints

### Streaming is SSE-based

`execStream(...)` expects SSE-style frames.
If the response body is missing, the client throws.

### Archive import/export is byte-oriented

Workspace archive APIs intentionally move raw bytes rather than JSON wrappers.
This keeps the API better suited to tar/gzip style transfers.

### The SDK is backend-facing, not control-plane-facing

The Sandbox SDK is for talking to the sandbox service directly.
It does not manage:

- OR3 Net jobs
- OR3 Net runtime sessions
- OR3 Net previews
- OR3 Net auth exchange

Those remain OR3 Net control-plane concerns.

## How OR3 Net uses this SDK

Inside OR3 Net, the sandbox SDK powers several higher-level abstractions:

- `SandboxRuntimeAdapter`
- `WarmPoolManager`
- `SandboxNodeAdapter`

This means most application code can stay at the OR3 Net layer while the sandbox-specific behavior is isolated behind the SDK and adapter boundaries.

## Related docs

- [Runtimes and Nodes](../concepts/runtimes-and-nodes.md)
- [HTTP API](../api/http-api.md)
