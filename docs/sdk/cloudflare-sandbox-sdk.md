# Cloudflare Sandbox SDK

This guide explains the Cloudflare Sandbox bridge and wrapper used by OR3 Net.

## What lives here

The Cloudflare integration is intentionally split into two layers:

- a Bun-side wrapper under [sdk/cloudflare-sandbox](../../sdk/cloudflare-sandbox)
- a Worker bridge example under [examples/cloudflare-sandbox-bridge](../../examples/cloudflare-sandbox-bridge)

The Bun-side wrapper exposes the narrow provider surface that OR3 Net actually uses:

- `HttpCloudflareSandboxClient`
- `CloudflareSandboxRequestError`
- `CloudflareSandboxClient` / `CloudflareSandboxConnection`
- `resolveCloudflareSandboxClientConfig()`

## Why the bridge exists

Unlike the OpenSandbox integration, Cloudflare Sandbox is built around:

- Workers
- Durable Objects
- Containers
- `proxyToSandbox()` preview routing

That means OR3 Net should **not** import the Cloudflare SDK directly into its Bun control-plane paths.
Instead it talks to a Worker-hosted bridge over HTTP, then normalizes results into the same runtime and node adapter contracts used elsewhere.

## Main entry points

- [sdk/cloudflare-sandbox/client.ts](../../sdk/cloudflare-sandbox/client.ts)
- [sdk/cloudflare-sandbox/types.ts](../../sdk/cloudflare-sandbox/types.ts)
- [examples/cloudflare-sandbox-bridge/handler.ts](../../examples/cloudflare-sandbox-bridge/handler.ts)
- [examples/cloudflare-sandbox-bridge/index.ts](../../examples/cloudflare-sandbox-bridge/index.ts)

## Configuration

`resolveCloudflareSandboxClientConfig()` reads these environment variables:

- `OR3_NET_CLOUDFLARE_SANDBOX_BASE_URL`
- `OR3_NET_CLOUDFLARE_SANDBOX_TOKEN`
- `OR3_NET_CLOUDFLARE_SANDBOX_REQUEST_TIMEOUT_MS`
- `OR3_NET_CLOUDFLARE_SANDBOX_PREVIEW_HOSTNAME`

When config is present, [src/server.ts](../../src/server.ts) auto-registers `CloudflareSandboxRuntimeAdapter` and, if no node execution adapter is already supplied, defaults to `CloudflareSandboxNodeAdapter`.

## Preview requirements

Cloudflare-backed preview support has one important deployment constraint:

- preview routing requires `proxyToSandbox()` in the Worker
- preview routing requires a **custom domain with wildcard DNS**
- `.workers.dev` does not support the wildcard subdomains needed for stable preview URLs

OR3 Net continues to treat previews as control-plane capabilities with expiry and revocation.
The provider preview URL is not the only security boundary.

## Where it is used

The wrapper currently feeds two built-in integrations:

- `CloudflareSandboxRuntimeAdapter` in [src/runtime/adapters/cloudflare-sandbox.ts](../../src/runtime/adapters/cloudflare-sandbox.ts)
- `CloudflareSandboxNodeAdapter` in [src/nodes/adapter-cloudflare-sandbox.ts](../../src/nodes/adapter-cloudflare-sandbox.ts)

Those cover runtime sessions, remote job execution, and service launch / revoke flows.

## Error model

Provider or bridge failures are wrapped as `CloudflareSandboxRequestError` with:

- `status`
- `code`
- `retryAfterMs`
- `details`

Higher layers translate those into OR3 runtime and platform errors instead of leaking bridge-specific exceptions to callers.