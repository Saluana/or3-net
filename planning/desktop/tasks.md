# OR3 Desktop Control Center on Top of OR3 Net — Tasks

## 1. Preconditions and dependency alignment

- [ ] [R4, R9] Link the desktop plan explicitly to `planning/remote-execution-completion`, `planning/operator-session-completion`, and `planning/chat-v1-integration` as prerequisites rather than parallel optional work.
- [ ] [R4, R5] Identify the missing host/operator/provider catalog routes that desktop depends on and record them as host-side prerequisites rather than desktop-owned workarounds.
- [ ] [R4, R7] Reconfirm the local sandbox posture against `/Users/brendon/Documents/or3-sandbox/docs/runtimes.md` and related QEMU/HVF docs so desktop claims stay aligned with the actual sandbox runtime posture.

## 2. Repo and package scaffolding

- [ ] [R1, R2, R9] Define the additive repo layout inside `or3-net` for `desktop/`, `supervisor/`, and shared desktop contracts.
- [ ] [R1, R9] Update `/Users/brendon/Documents/or3-net/package.json` planning notes with root scripts and build/test/package entrypoints that preserve the current `bun run cli`, `bun test`, and host workflows.
- [ ] [R1, R2, R9] Decide where shared types live so host, supervisor, and desktop do not duplicate contract shapes.

## 3. Host API and registry groundwork

- [ ] [R4, R5] Extend `src/contracts/*.ts` planning scope with runtime-provider, service-app, and capability metadata shapes.
- [ ] [R4, R5] Extend `src/api/app.ts` planning scope with operator routes and provider catalog routes required by desktop.
- [ ] [R4, R5] Reuse existing auth, session, preview, and service behavior in the host plan and explicitly reject SSH or direct remote-machine bypass paths.
- [ ] [R5, R9] Keep provider registries distinct from the existing `or3-chat` tool registry and admin extension systems.

## 4. Supervisor core

- [ ] [R2, R8, R9] Plan and implement supervisor state storage, local auth token flow, managed instance inventory, health polling, and local lifecycle control.
- [ ] [R2, R8] Add stale-process, stale-PID, and occupied-port reconciliation before local start or restart claims.
- [ ] [R2, R6] Add local backup, restore, bundle staging, apply, and rollback flows.
- [ ] [R2, R8] Add local log streaming with redaction for secrets, cookies, bearer tokens, and sensitive env values.

## 5. Local sandbox integration

- [ ] [R2, R7] Define the bundled macOS VM runtime path around `or3-sandbox`’s QEMU/HVF support.
- [ ] [R7] Add desktop-facing doctor and runtime health checks for local sandbox prerequisites, guest image readiness, and runtime availability.
- [ ] [R7] Document the local and development-grade macOS/HVF posture versus Linux/KVM production posture everywhere desktop surfaces local sandbox claims.

## 6. Desktop shell foundation

- [ ] [R1, R3, R8] Scaffold the `Tauri 2` shell with a client-only `Nuxt` app and a minimal Rust bridge.
- [ ] [R1] Build main-window pages for local stack overview, remote attachments, providers, updates, logs, and failures.
- [ ] [R1, R3] Add tray or menu-bar actions for open, start, stop, restart, and status.
- [ ] [R3] Add browser handoff helpers for local `or3-chat`, local `/admin`, and remote or local operator URLs using normal web auth flows.

## 7. Provider-model rollout

- [ ] [R5] Add the first runtime-provider catalog entries for `or3-intern` and `nullclaw`.
- [ ] [R5] Add the first service or app registry entry for `openclaw`.
- [ ] [R5] Ensure desktop and browser clients can both render launch and control actions from shared capability metadata rather than provider-specific hard-coded branches.

## 8. Updates and release hardening

- [ ] [R6, R8] Define the signed bundle and update manifest format plus compatibility gates between shell, supervisor, and bundled services.
- [ ] [R6] Implement supervisor-coordinated atomic apply and rollback behavior.
- [ ] [R1, R6, R8] Add macOS consumer-release planning tasks for packaging, signing, notarization, crash recovery, and upgrade QA.
- [ ] [R6] Define retention and cleanup rules for update staging artifacts and rollback checkpoints so local storage does not grow without bound.

## 9. Tests

- [ ] [R1-R8] Add Bun tests for supervisor lifecycle, local API auth, provider catalog behavior, update staging, apply, and rollback.
- [ ] [R1, R3, R8] Add desktop shell tests for client state recovery, browser handoff, and action gating.
- [ ] [R1, R2, R6, R7] Add macOS smoke tests for fresh install, local boot, browser open, local sandbox doctor, update, and rollback.
- [ ] [R4, R5, R9] Extend existing host-side Bun tests so desktop-dependent routes and provider catalogs are covered without regressing CLI or console behavior.

## 10. Documentation and repo alignment

- [ ] [R7, R9] Update `README.md` and relevant planning indexes once desktop work becomes active so the repo clearly explains the desktop, supervisor, and host split.
- [ ] [R4, R7, R9] Cross-link this plan from other affected planning packages when desktop dependencies become implementation blockers.

## 11. Out of scope

- [ ] Do not rewrite full `or3-chat`, admin, or operator browser UIs as native desktop pages in v1.
- [ ] Do not add SSH-based remote fleet management in v1.
- [ ] Do not claim bundled macOS/HVF local sandbox posture is identical to Linux/KVM production posture.
- [ ] Do not bypass `or3-net` with direct remote calls to `or3-intern` or `or3-sandbox`.
