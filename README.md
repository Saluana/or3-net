# or3-net

`or3-net` is the Bun/TypeScript control plane for OR3 network execution: auth exchange, workspace-scoped jobs, node enrollment, previews, service launch, CLI workflows, and a minimal built-in operator console.

## Install

```bash
bun install
```

## Validate

```bash
bun run typecheck && bun run lint && bun test
```

## CLI

```bash
bun run cli -- help
bun run cli -- auth exchange --workspace-id ws_demo
bun run cli -- nodes list --workspace-id ws_demo --token <token>
bun run cli -- jobs submit --workspace-id ws_demo --token <token> --session-key svc:demo --message "hello"
```

## Console

The built-in operator console is served at `/console` by the Bun server. It provides a minimal authenticated UI for nodes, jobs, previews, and service actions such as `Open Dashboard`, `Revoke Access`, and `Restart Service`.

## Contract and Config Alignment

- Contract fixtures and boundary notes live under [planning/platform-standardization](planning/platform-standardization).
- Canonical deployment env prefixes are `OR3_NET_*`, `OR3_INTERN_*`, and `OR3_SANDBOX_*`; orchestration should translate those into repo-native runtime settings before each process starts.
- Shared secret precedence is launch-time env or mounted secret paths → instance-local config → repo defaults.
- Cross-repo key mapping and secret ownership are documented in [planning/platform-standardization/config-alignment.md](planning/platform-standardization/config-alignment.md).
- Contract fixture drift is enforced in CI via [.github/workflows/contracts.yml](.github/workflows/contracts.yml).
