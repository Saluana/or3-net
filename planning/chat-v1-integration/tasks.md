# Chat V1 Integration — Tasks

## 1. Align the cross-repo contract before UI work

- [ ] [Req 2, 3] Confirm the host routes, session-binding inputs, and replay APIs required by the plugin are available from the operator/session plan before shipping browser integration.
- [ ] [Req 2] Confirm the token-exchange proof shape that `or3-chat` can produce through its existing provider-agnostic session flows.
- [x] [Req 4] Confirm preview/service launch routes and metadata match the plugin UX assumptions for pane vs external launch.

## 2. Add the `or3-chat` plugin shell

- [x] [Req 1] Add an OR3 Network plugin entry under `/Users/brendon/Documents/or3/or3-chat/app/plugins/**` gated by host configuration.
- [x] [Req 1] Add the plugin page and route shell under `/Users/brendon/Documents/or3/or3-chat/app/components/**` or the repo’s existing plugin page pattern.
- [x] [Req 1] Ensure the plugin remains inactive in static-only setups with no configured host.

## 3. Implement token exchange and session binding in `or3-chat`

- [x] [Req 2] Add `useOr3NetAuth()` using existing workspace/session composables to exchange and cache a short-lived host token in memory only.
- [x] [Req 2, 3] Add `useOr3NetSession()` or equivalent to resolve and reuse the current `network_session_id` for the active chat context.
- [x] [Req 2] Handle workspace switches by invalidating token/session state and rebinding to the new workspace automatically.
- [x] [Req 2] Handle 401 responses with a bounded token refresh and retry path.

## 4. Add job list, submit, stream, and abort UX

- [x] [Req 3] Add a typed `useOr3NetClient()` wrapper in `or3-chat` for job create/get/list/abort and session replay calls.
- [x] [Req 3] Build a recent jobs list and active job detail panel using the host API rather than direct backend calls.
- [x] [Req 3] Add live SSE streaming in the plugin with reconnect/replay behavior using host job/session event routes.
- [x] [Req 3] Add abort actions with correct terminal UI handling and session history refresh.

## 5. Add service launch and preview UX

- [x] [Req 4] Build node/service list UI that calls `or3-net` launch, restart, and revoke routes.
- [x] [Req 4] Add an embedded preview pane wrapper for iframe-safe previews with `Open in New Tab` fallback.
- [x] [Req 4] Handle expired launch URLs by requesting a fresh launch rather than reusing stale state.
- [x] [Req 4] Keep all browser launches limited to opaque host-issued URLs.

## 6. Add end-to-end regression coverage

- [x] [Req 5] Add `or3-chat` tests for token exchange, session binding recovery, workspace switch rebinding, and the initial jobs page/client slice.
- [ ] [Req 5] Add `or3-net` regression tests for the browser-facing routes the plugin consumes.
- [ ] [Req 5] Add at least one integrated flow test covering: chat auth → host token exchange → job submit → live stream → abort or completion → preview/service launch.
- [ ] [Req 5] Add negative tests for expired tokens, missing scope, expired launch URLs, and workspace/session mismatch.

## 7. Update docs and rollout guidance

- [x] [Req 1, 2] Update `/Users/brendon/Documents/or3/or3-chat/planning/or3-net-plan.md` to reflect the implemented host exchange and plugin shell baseline.
- [x] [Req 5] Update `or3-net` planning notes where the final plugin contract sharpens earlier assumptions.
- [x] [Req 1] Document the minimum configuration needed to enable the plugin without affecting static mode.

## 8. Out of scope

- [ ] Do not add direct browser access to `or3-intern` or `or3-sandbox`.
- [ ] Do not turn OR3 Network into a required `or3-chat` core dependency.
- [ ] Do not store long-lived `or3-net` tokens in persistent browser storage.
- [ ] Do not expose raw ports, tunnel tokens, or internal service secrets in the UI.
