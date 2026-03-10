# OR3 Net Plan — Security Model

## Trust boundaries

- End-user identity starts in `or3-chat` or workspace API keys.
- `or3-net` is the public control-plane boundary.
- `or3-intern` is an internal execution service, not a public end-user API.
- Nodes are untrusted until enrolled, verified, approved, and issued short-lived credentials.

## Authentication model

### User and client auth

- `or3-chat` exchanges an active session proof for a short-lived `or3-net` bearer token.
- Non-chat clients use workspace-scoped API keys with limited scopes.
- All public API requests are authorized against workspace membership/scope before touching jobs or nodes.

### Internal service auth

- `or3-net -> or3-intern` uses a shared-secret or equivalent internal bearer/HMAC scheme.
- The `or3-intern` service surface is not exposed as a general internet-facing API.

### Node auth

- Enrollment requires a signed manifest.
- Approval pins the node identity and issues short-lived credentials.
- Manifest changes invalidate prior approval and force re-review.

### Browser tunnel auth

- Browser access to node-backed dashboards uses a short-lived launch flow issued by `or3-net`.
- For sandbox-backed nodes, `or3-net` relies on `or3-sandbox` signed browser tunnel URLs and bootstrap cookies as a narrow tunnel-scoped capability.
- The browser receives access to one service path for one tunnel, not a reusable sandbox admin credential.

## Isolation rules

- Workspace A cannot view, stream, schedule, or approve resources from Workspace B.
- Warm pools are single-workspace only.
- Task packages contain explicit artifacts and bounded instructions, never implicit workspace mirrors.
- Remote subagents inherit host-issued tool/path/timeout/quota bounds.
- Service dashboard launches are workspace-scoped and user-authorized before any tunnel URL is minted.
- Users should not receive raw sandbox bearer tokens or broad tunnel-management permissions merely to open a dashboard.

## Runtime reuse safeguards

- Reusable runtimes must be hard-reset before reuse.
- Reset includes process kill, filesystem/workspace scrub, credential rotation, and health check.
- Failed reset keeps the runtime out of the warm pool.

## Tunnel exposure safeguards

- Default tunnel visibility remains `private`.
- Launch URLs should be short-lived and auditable.
- Tunnels should be revoked when the backing service stops, the node lease ends, or an operator explicitly revokes access.
- Browser launch flows should target a known service/app contract such as `openclaw`, not arbitrary user-provided ports in the default UI.
- Apps exposed behind tunnels should bind to loopback inside the sandbox where possible.

## Managed vs OSS policy

- The protocol remains open for OSS/manual approval flows.
- Managed OR3 Chat environments can restrict scheduling to certified node classes/manifests.
- Managed allowlists do not change the public protocol shape; they change policy at approval/scheduling time.

## Security review checklist

- Public endpoints require workspace auth and scope checks.
- Internal endpoints require separate internal auth.
- Node manifests are signature-verified and approval-gated.
- All terminal job states are durable in SQLite.
- Stream disconnects do not grant data access or orphan unknown state.
- Service launch endpoints mint only narrow, expiring browser capabilities and do not leak sandbox control-plane tokens.
- Tunnel creation, signed-URL issuance, launch, and revoke actions are auditable.