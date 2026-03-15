# OR3 Desktop Control Center on Top of OR3 Net — Requirements

## Overview

This plan defines the v1 desktop control center for OR3 as an additive package family inside the existing `or3-net` repository.

The desktop product is a launcher and operator shell that sits on top of `or3-net`, not a second control plane. It is responsible for:

- local machine orchestration for the OR3 stack
- browser handoff to existing OR3 web surfaces
- remote host attachment through `or3-net` APIs
- provider-aware runtime and service catalogs
- full-stack update and rollback workflows
- macOS-first delivery

Scope assumptions:

- The planning docs live in `or3-net`, not in a separate `or3-new` repository.
- Desktop implementation depends on `planning/remote-execution-completion`, `planning/operator-session-completion`, and `planning/chat-v1-integration`.
- V1 uses `Tauri 2` with a client-only `Nuxt` shell, `Nuxt UI`, and `Nuxt Icons`.
- V1 ships a bundled `Bun`/TypeScript local supervisor and the full local OR3 stack: `or3-chat`, `or3-net`, `or3-intern`, and `or3-sandbox`.
- V1 is browser-first for full `or3-chat`, `/admin`, and operator pages; it does not embed those full apps inside the desktop window.
- V1 remote operations attach only through `or3-net` host/operator APIs and do not use SSH.
- Local browser handoff uses the normal web auth flow, not a desktop-minted browser session.
- The bundled local sandbox path on macOS uses a managed `QEMU`/`HVF` posture for local and development-grade isolation. Linux with KVM remains the production reference posture.

## Requirements

### 1. Desktop shell must provide a native control-center surface

**Requirement:** As a desktop user, I need a native-feeling control center that lets me manage the OR3 stack without turning the desktop app into a copy of the full web UI.

**Acceptance criteria:**

- The desktop product provides both a main window and tray or menu-bar entrypoints.
- The shell shows local stack status, remote attachments, quick actions, update state, and logs.
- The shell remains focused on launcher and operator workflows and does not host the full `or3-chat` or admin/operator browser apps inside the main UI by default.

### 2. A bundled local supervisor must manage the full local OR3 stack

**Requirement:** As a local operator, I need one bundled supervisor that owns the lifecycle of the full local OR3 stack so desktop state stays truthful and recoverable.

**Acceptance criteria:**

- The supervisor manages `or3-chat`, `or3-net`, `or3-intern`, and `or3-sandbox` as named local services.
- Supported local actions include install, start, stop, restart, reset, logs, backup, and restore.
- Local lifecycle operations detect stale processes, occupied ports, and partial startup failures before claiming success.
- The supervisor is the canonical source of machine-local service status for the desktop shell.

### 3. Desktop must use browser-first handoff for existing OR3 web surfaces

**Requirement:** As a user, I need the desktop shell to open the existing OR3 web surfaces in my browser instead of reimplementing them natively in v1.

**Acceptance criteria:**

- The desktop shell can open local `or3-chat`, local `/admin`, and remote or local operator URLs in the user’s browser.
- Local browser handoff uses the normal web auth flow already enforced by the web surfaces.
- V1 does not require embedded full webviews for the main `or3-chat`, admin, or operator applications.

### 4. Desktop must not bypass `or3-net` for remote control-plane operations

**Requirement:** As a platform maintainer, I need desktop to respect `or3-net` as the control-plane boundary so remote state does not fork across clients.

**Acceptance criteria:**

- Remote attachments use only `or3-net` host or operator APIs for jobs, sessions, nodes, previews, services, and provider metadata.
- Desktop does not call `or3-intern` or `or3-sandbox` directly for remote operations.
- Desktop does not introduce SSH-based remote machine control in v1.

### 5. Runtime and service extensibility must be registry-based

> **Cross-ref:** The runtime-provider registry, adapter contract, capability system, and runtime catalog/session APIs are planned in `planning/runtime-contract/`. This desktop requirement is satisfied by consuming those contracts.

The implementation source of truth for runtime-provider registry work is `planning/runtime-contract/`; desktop should only add consumer behavior and service-app presentation on top of that substrate.

**Requirement:** As a platform developer, I need a provider model that supports multiple runtimes and launchable services without hard-coding OR3 around a single backend or app.

**Acceptance criteria:**

- `or3-net` exposes a runtime-provider registry for execution backends such as `or3-intern` and `nullclaw`. (Planned in `planning/runtime-contract/` as `RuntimeRegistry` with `RuntimeAdapterManifest`.)
- `or3-net` exposes a service or app registry for launchable UIs such as `openclaw`.
- Both desktop and browser clients render available actions from capability metadata rather than service-specific hard-coded branches. (Planned in `planning/runtime-contract/` as `RuntimeDescriptor` with strongly typed capabilities.)
- The runtime-provider registry and service or app registry stay distinct from the existing `or3-chat` tool registry and admin extension systems.

### 6. Desktop must support full-stack updates as a first-class workflow

**Requirement:** As a consumer desktop user, I need the app to update its shell, supervisor, and bundled local services through one coordinated workflow.

**Acceptance criteria:**

- The desktop shell, supervisor, and bundled local services update from one versioned bundle model.
- Update apply is atomic, restart-aware, and rollback-capable.
- Compatibility checks run before mutation and block incompatible bundle transitions.
- Service restarts and rollback are coordinated by the supervisor rather than ad hoc UI logic.

### 7. Bundled local sandboxing on macOS must use a managed VM path

**Requirement:** As a local desktop user, I need the bundled local sandbox to use a managed VM-backed path on macOS instead of falling back to an unbounded trusted-Docker story.

**Acceptance criteria:**

- The desktop product bundles or manages `or3-sandbox` with a `QEMU`/`HVF`-based local runtime path on macOS.
- Startup includes desktop-facing doctor or health checks for the bundled VM prerequisites, guest image readiness, and runtime availability.
- The product documentation explicitly distinguishes local macOS `HVF` posture from Linux/KVM production posture and does not market them as equivalent.

### 8. Local control must be safe by default

**Requirement:** As a security reviewer, I need desktop local control flows to be explicit, authenticated, and secret-safe by default.

**Acceptance criteria:**

- Shell-to-supervisor control uses a local authenticated API boundary.
- Secrets, tokens, cookies, and sensitive env values are redacted from logs, errors, and diagnostics shown to the user.
- Dangerous operations such as reset, restore, rollback, or destructive local reinstall require explicit user intent or confirmation.
- The supervisor defaults to on-demand lifecycle with the desktop app rather than becoming a persistent background daemon automatically.

### 9. Desktop work must fit the current `or3-net` repo shape

**Requirement:** As a maintainer, I need the desktop planning and implementation to extend the current `or3-net` repo rather than pretending it already has a separate monorepo or product split.

**Acceptance criteria:**

- Planning assumes additive package families inside `or3-net` such as `desktop/`, `supervisor/`, and shared desktop contracts rather than a new standalone repo.
- New desktop and supervisor work does not replace the existing Bun host, CLI, or built-in console.
- Existing host API, workspace auth, and session behavior remain backward-compatible where possible.

## Non-functional constraints

- Keep the desktop shell lightweight and native-feeling.
- Keep supervisor process state bounded, deterministic, and recoverable.
- Preserve `or3-net` as the single coordination layer for jobs, sessions, nodes, services, and previews.
- Do not promise production-equivalent isolation for macOS `HVF`.
- Keep browser-first OR3 surfaces usable without rewriting them.
- Keep future cross-platform expansion possible, but optimize v1 delivery for macOS.
- Avoid bypassing existing SSR auth or admin authorization boundaries in `or3-chat`.
- Avoid introducing unbounded local logs, caches, or rollback artifacts without retention policy.
