# Configuration and Environment Alignment

## Canonical deployment prefixes

For cross-repo deployment tooling, reserve these top-level prefixes:

- `OR3_NET_*` for `or3-net`
- `OR3_INTERN_*` for `or3-intern`
- `OR3_SANDBOX_*` for `or3-sandbox`

These prefixes are the orchestration-facing contract. Individual repos may continue to use native runtime variables (`SANDBOX_*`, repo-specific flags, or config files) internally, but deployment tooling should translate from the canonical prefix into repo-native configuration before starting each process.

## Secret and config precedence

Use the same precedence rule across the three repos:

1. launch-time environment variables or mounted secret paths
2. instance-local config files generated for that repo
3. checked-in defaults and code-level fallbacks

Repo-specific notes:

| Repo | Native config surfaces | Recommended precedence notes |
| --- | --- | --- |
| `or3-net` | process env, Bun launch options, deployment config | Treat launch-time env as authoritative for token-signing secrets, upstream service URLs, and adapter credentials. |
| `or3-intern` | process env plus `~/.or3-intern/config.json` from `or3-intern init` | Keep operator overrides in env when running the internal service API; use the config file for stable local defaults. |
| `or3-sandbox` | process env, CLI flags, mounted secret files | Keep auth, tunnel-signing, and production-profile secrets in mounted files or env; do not rely on checked-in defaults for secrets. |

## Shared key mapping

Use the following canonical deployment keys when the same logical value must be wired through multiple repos:

| Logical value | Canonical deployment key | `or3-net` mapping | `or3-intern` mapping | `or3-sandbox` mapping |
| --- | --- | --- | --- | --- |
| Workspace token signing secret | `OR3_SHARED_WORKSPACE_TOKEN_HMAC` | auth/token signing secret used by `issueWorkspaceToken()` | n/a | n/a |
| Intern service credential | `OR3_SHARED_INTERN_SERVICE_TOKEN` | outbound credential for the intern SDK client | inbound internal service auth secret/token | n/a |
| Sandbox service credential | `OR3_SHARED_SANDBOX_AUTH` | outbound static token or JWT material for sandbox SDK calls | n/a | `SANDBOX_TOKENS` entries or JWT secret paths |
| Tunnel signing key | `OR3_SHARED_TUNNEL_SIGNING_KEY` | referenced by deployment config when `or3-net` provisions sandbox launch flows | n/a | `SANDBOX_TUNNEL_SIGNING_KEY_PATH` |

## Operational guidance

- Keep canonical deployment keys in secret managers or mounted secret files, not source-controlled env files.
- When native repo env names differ from the canonical deployment key, document the translation in the deployment manifest or compose file beside the service definition.
- If a shared key rotates, update all mapped repos in the same rollout window and bump the compatibility matrix entry when the boundary contract changes.
