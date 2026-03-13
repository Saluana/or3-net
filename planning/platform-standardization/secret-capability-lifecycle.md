# Secret and Capability Lifecycle

## Secret classes

### `user-local`

- Browser-local, user-owned secrets.
- Example: user-provided model/API keys stored in browser-side state.
- Must never be uploaded implicitly.

### `control-plane`

- Server-side secrets used by `or3-net` and trusted backend services.
- Example: workspace-token signing secret, intern service auth secret, sandbox service account token.
- Must be encrypted at rest or managed as server-only operational secrets.

### `service-bootstrap`

- Secrets loaded from env/files during service startup.
- Example: JWT secrets, DB credentials, file-mounted keys.
- Must never be exposed through APIs.

### `ephemeral-capability`

- Short-lived, scoped, revocable launch material.
- Example: preview launch token, signed tunnel URL, one-time transfer token.
- Browser clients may receive these; they must not receive underlying infrastructure secrets.

## Cross-repo ownership examples

| Repo | Example | Class |
|------|---------|-------|
| `or3-chat` | Browser-local provider/session proof material | `user-local` |
| `or3-net` | Workspace token HMAC secret | `control-plane` |
| `or3-net` | Intern service secret | `control-plane` |
| `or3-sandbox` | Runtime JWT/static auth secret | `service-bootstrap` |
| `or3-net` | Preview/service launch capability | `ephemeral-capability` |

## Transfer rules

- Secrets do not cross repo boundaries as raw values unless the receiving service is the durable owner.
- Browser flows receive capabilities, not infrastructure credentials.
- Service-to-service transfer uses existing trust/auth channels.
- Logs, error responses, SSE payloads, persisted job events, and audit summaries redact secret material by default.

## Capability lifecycle

1. **Mint**: `or3-net` issues a `CapabilityGrant` with scope, expiry, and workspace binding.
2. **Resolve**: only valid, non-revoked, non-expired capabilities resolve.
3. **Revoke**: revocation sets `revoked_at` and removes reverse-index references.
4. **Expire**: expiry returns `410 Gone` and triggers cleanup.
5. **Prune**: cleanup removes dead capability references from in-memory or persisted indexes.

## Redaction rules

The following must be redacted by default:

- bearer tokens
- tunnel access tokens
- signed URLs with embedded signatures
- HMAC/JWT secrets
- raw provider session proofs
