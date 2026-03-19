# OpenSandbox SDK

This guide explains the OpenSandbox wrapper used by OR3 Net.

If you are looking for the managed Cloudflare path instead, see [Cloudflare Sandbox SDK](cloudflare-sandbox-sdk.md).

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
- `OR3_NET_OPENSANDBOX_READY_TIMEOUT_SECONDS`
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

## Local bootstrap

For a local Docker-backed OpenSandbox setup in this repo, use the new helper scripts:

- `bun run opensandbox:init`
- `bun run opensandbox:init:refresh`
- `bun run opensandbox:manual`
- `bun run opensandbox:server`
- `bun run opensandbox:stream`
- `bun run opensandbox:smoke`
- `bun run opensandbox:smoke:cli`

`opensandbox:init` keeps everything repo-local under `.local/opensandbox`:

- installs Python `3.11` with `uv` if your system `python3` is older than `3.10`
- creates an isolated virtualenv instead of touching your global Python packages
- installs `opensandbox`, `opensandbox-server`, and `opensandbox-cli`
- writes a local Docker config and env file at `.local/opensandbox/env.sh`
- attempts to start Docker Desktop on macOS if Docker is installed but not running

Rerunning `opensandbox:init` is now incremental: if the local virtualenv and CLI tools are already present, it reuses them instead of rebuilding everything. Use `bun run opensandbox:init:refresh` when you want a full reinstall.

After bootstrap, source `.local/opensandbox/env.sh` in any terminal that needs direct access to the local OpenSandbox server or CLI.

If you want one command that shows each step live, use `bun run opensandbox:stream`. It bootstraps the local toolchain, starts the local server when needed, streams server and shell output to your terminal, runs both smoke tests, then shuts down the server it started.

If you want a fuller manual CLI walkthrough, use `bun run opensandbox:manual`. It creates a fresh sandbox, uploads a host file, runs in-sandbox commands, downloads mutated artifacts, resolves an HTTP endpoint, fetches the served content, and then cleans the sandbox up.

## Manual verification flow

The repo now includes two smoke paths:

- `bun run opensandbox:smoke` exercises the OR3 integration through:
	- `SdkOpenSandboxClient`
	- `OpenSandboxRuntimeAdapter`
	- `OpenSandboxNodeAdapter`
- `bun run opensandbox:smoke:cli` exercises the upstream `osb` CLI through sandbox lifecycle, command execution, file IO, endpoint lookup, pause/resume, and cleanup.

The scripts assume a local server at `http://127.0.0.1:8080` using direct endpoint resolution from the host-run Docker server configuration.
