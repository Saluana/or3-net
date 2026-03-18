# OpenSandbox SDK

This guide explains the OpenSandbox wrapper used by OR3 Net.

## What lives here

The wrapper lives under [sdk/opensandbox](../../sdk/opensandbox) and exposes the narrow provider surface that OR3 Net actually uses:

- `SdkOpenSandboxClient`
- `OpenSandboxRequestError`
- `OpenSandboxClient` / `OpenSandboxConnection`
- `resolveOpenSandboxClientConfig()`

OR3 Net uses that wrapper instead of depending on raw OpenSandbox SDK shapes throughout the control plane.

## Why the wrapper exists

The upstream `@alibaba-group/opensandbox` package is a good transport layer, but OR3 Net needs a smaller, stable contract for:

- runtime session lifecycle
- foreground command execution
- file-based workspace staging
- endpoint lookup for service launch
- normalized provider errors

That normalization keeps runtime routes, local job execution, and preview launch code provider-agnostic.

## Main entry points

- [sdk/opensandbox/index.ts](../../sdk/opensandbox/index.ts)
- [sdk/opensandbox/client.ts](../../sdk/opensandbox/client.ts)
- [sdk/opensandbox/types.ts](../../sdk/opensandbox/types.ts)

## Configuration

`resolveOpenSandboxClientConfig()` reads these environment variables:

- `OR3_NET_OPENSANDBOX_API_KEY`
- `OR3_NET_OPENSANDBOX_DOMAIN` or `OR3_NET_OPENSANDBOX_BASE_URL`
- `OR3_NET_OPENSANDBOX_PROTOCOL`
- `OR3_NET_OPENSANDBOX_REQUEST_TIMEOUT_SECONDS`
- `OR3_NET_OPENSANDBOX_DEFAULT_TIMEOUT_SECONDS`
- `OR3_NET_OPENSANDBOX_DEFAULT_IMAGE`
- `OR3_NET_OPENSANDBOX_USE_SERVER_PROXY`

When config is present, [src/server.ts](../../src/server.ts) auto-registers `OpenSandboxRuntimeAdapter`.

## Where it is used

The wrapper currently feeds two built-in integrations:

- `OpenSandboxRuntimeAdapter` in [src/runtime/adapters/opensandbox.ts](../../src/runtime/adapters/opensandbox.ts)
- `OpenSandboxNodeAdapter` in [src/nodes/adapter-opensandbox.ts](../../src/nodes/adapter-opensandbox.ts)

Those cover runtime sessions, job execution, and preview/service launch flows.

## Error model

Provider failures are wrapped as `OpenSandboxRequestError` with:

- `status`
- `code`
- `retryAfterMs`
- `details`

Higher layers translate those into OR3 runtime and platform errors instead of leaking provider-specific exceptions.
