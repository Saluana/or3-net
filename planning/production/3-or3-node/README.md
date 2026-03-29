# 3. OR3 Node

## Repo Role

`or3-node` is the machine-side agent.

The current repo already documents the intended split clearly:

- `or3-net` is the control plane
- `or3-node` is the installable agent that runs on the machine

That means `or3-node` is the correct active workstream, not `or3-sandbox`.

## Verified Current State

From the current repo:

- `README.md` says `or3-net` is the control plane and `or3-node` is the machine-side agent
- `src/runtime-capabilities.ts` advertises:
  - `exec`: yes
  - `file-read` / `file-write`: only with `allowedRoots`
  - `pty`: only on macOS/Linux
  - `service-launch`: currently `false`
- `tests/host-control-services.test.ts` shows there is a real host service manager surface
- `docs/platform-support.md` and `docs/release-gates.md` both say service launch and preview-backed service exposure are disabled by default and release-gated

## Production Implication

The production plan must assume:

- `or3-node` is the primary machine-side path
- `exec`, file ops, and PTY are real
- service launch exists as a scaffold but is not yet default GA capability

So the control plane and chat UX must not treat service launch as baseline behavior.

## Primary Deliverables

### 1. Capability truthfulness

- [ ] keep capability advertising honest
- [ ] keep `service-launch` hidden until hardening is complete
- [ ] ensure `file-*` remains tied to `allowedRoots`
- [ ] ensure PTY remains platform-gated

### 2. Production baseline

Make the production baseline:

- remote execution
- optional file access
- optional PTY
- no assumed service-launch by default

### 3. Service-launch hardening

Only if service launch is required for GA:

- [ ] harden env inheritance
- [ ] harden cwd policy
- [ ] align launch lifecycle with control-plane revoke semantics
- [ ] add stronger smoke tests and release validation

There is already a known audit item in `docs/bug-audit-task-list.md` calling out that service launches inherit unrestricted process state.

### 4. Preview relationship

- [ ] make clear whether previews come from node-managed services, runtime artifacts, or control-plane descriptors
- [ ] ensure control plane remains the source of browser-facing preview policy

## Milestones

### M0: Accept OR3 Node as the active machine path

- [ ] remove `or3-sandbox` from active production planning path
- [ ] make `or3-node` the primary dependency in production docs

### M1: Lock capability posture

- [ ] document default advertised capability set
- [ ] document exact conditions for file and PTY capability
- [ ] document why service-launch remains hidden

### M2: Decide service-launch release scope

Choose one:

- [ ] keep it gated and out of GA baseline
- [ ] or harden it now and make it part of the release gate

### M3: Align OR3 Net and Chat UX

- [ ] ensure OR3 Net only exposes service actions when node capability is present
- [ ] ensure chat plugin only renders launch UX when capability is present

## Definition Of Done

This repo is done only when:

- its advertised capabilities match reality
- the production plan no longer references the old sandbox path as the primary machine integration
- service-launch is either truly ready or explicitly gated out of baseline UX

## References

- `../README.md`
- `../../../../or3-node/README.md`
- `../../../../or3-node/src/runtime-capabilities.ts`
- `../../../../or3-node/tests/host-control-services.test.ts`
- `../../../../or3-node/docs/platform-support.md`
- `../../../../or3-node/docs/release-gates.md`
- `../../../../or3-node/docs/bug-audit-task-list.md`
