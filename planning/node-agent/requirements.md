# OR3 Node Agent Requirements

## 1. Overview

`or3-node-agent` is the installable machine-side agent for OR3 Net.

Its job is to make a real computer controllable through the existing OR3 Net control plane without turning the control plane itself into a host daemon.

Target split:

- `or3-net` = control plane, API, auth, approval, lease scheduling, preview launch, runtime-session broker
- `or3-node-agent` = machine-local agent installed on the computer to be controlled

Scope for this plan:

- make installation and first launch extremely simple
- bootstrap and enroll a machine into OR3 Net
- maintain an authenticated connection from the machine back to OR3 Net
- execute leased work safely on the machine
- expose machine-control capabilities in a way that can back OR3 Net runtime sessions
- keep the implementation small, debuggable, and Bun/TypeScript-aligned with the existing repo

Assumptions:

- `or3-net` remains the public API and persistence layer
- node approval and lease issuance stay in the control plane
- the first production transport should prefer outbound connectivity from the agent to the control plane to avoid inbound firewall requirements
- the first implementation should focus on one agent process, not a second local daemon

### Req 1. Simple install and first-launch UX

As an operator, I want the fastest possible path from “I have a machine” to “OR3 can control it”, ideally through a global install and a single launch command.

Acceptance criteria:

- The primary installation story is `bun install -g or3-node`
- The primary first-run command is `or3-node launch`
- `or3-node launch` can perform first-run setup interactively or via flags without forcing separate manual init steps in the common path
- A new operator can get from install to a running, connectable agent with one docs page and one main command flow
- Advanced commands such as `init`, `enroll`, `doctor`, or `service install` may exist, but they must not replace the simple default path

## 2. Requirements

### Req 2. Machine enrollment and identity bootstrap

As an operator, I want to install `or3-node-agent` on a machine, bootstrap its identity, and attach it to an OR3 Net workspace without handing the long-lived agent a broad workspace bearer token.

Acceptance criteria:

- A fresh agent can generate and persist a local node identity keypair
- The bootstrap flow can enroll a node into a target workspace using a short-lived bootstrap credential or claim flow
- The resulting enrolled node uses the existing OR3 node manifest model and signature verification rules
- Reinstalling or restarting the agent does not silently change the node identity unless explicitly reset
- Invalid, expired, or revoked bootstrap credentials fail with clear errors

### Req 3. Approval and runtime credential handoff

As an operator, I want OR3 Net approval to remain the trust gate before the agent can accept leased work.

Acceptance criteria:

- Enrolled nodes remain `pending` until explicitly approved through OR3 Net
- Approval issues a node runtime credential using the existing control-plane credential model or a compatible extension
- The agent can receive, persist, rotate, and revoke its runtime credential without manual database edits
- Revoked or expired runtime credentials stop new work from starting
- Credential rotation does not require regenerating the node identity keypair

### Req 4. Authenticated outbound control-plane connection

As the system, I want the node agent to establish and maintain an authenticated reverse connection to OR3 Net so machines behind NAT or firewalls can still be controlled.

Acceptance criteria:

- The primary transport is outbound WebSocket or an equivalent long-lived reverse connection aligned with `outbound-wss`
- The agent authenticates the connection using its approved node runtime credential
- OR3 Net can correlate the live connection to a specific approved node record
- Disconnects are detected and reflected in node health within a bounded interval
- The design allows an HTTPS request/response transport for dev or fallback mode without changing the node identity model

### Req 5. Manifest-driven capability advertisement

As OR3 Net, I want the agent to advertise explicit capabilities and resource limits so scheduling and runtime selection remain capability-driven.

Acceptance criteria:

- The agent publishes a signed manifest compatible with the existing `nodeManifestSchema`
- The manifest includes transport support, isolation class, resource limits, version, and declared capabilities
- Capabilities distinguish at least execution, file access, PTY access, service exposure, and optional desktop-related launch support when implemented
- OR3 Net rejects unsupported capability requests instead of silently degrading them
- Capability changes can be applied by updating agent config and re-enrolling or re-advertising as designed

### Req 6. Leased non-interactive job execution

As OR3 Net, I want the first node-agent cut to execute leased jobs through the existing remote-node execution path.

Acceptance criteria:

- The agent handles `execute`, `heartbeat`, and `abort` RPCs compatible with the current node protocol or its planned extension
- Job execution remains bounded by timeout, output limits, and concurrency limits
- Output and terminal result map cleanly into existing OR3 job stream and job result contracts
- Abort requests stop active executions and surface a terminal state
- Missing executables, invalid working directories, and runtime failures produce explicit structured errors

### Req 7. Runtime-session backing for “control a computer” flows

As a user, I want OR3 Net runtime sessions backed by a real installed machine so I can control that computer with the same control-plane model used for other runtimes.

Acceptance criteria:

- The plan defines how the remote-node path grows beyond one-shot jobs to support runtime-session operations
- The first supported remote runtime-session operations are `create`, `exec`, `stop`/`destroy`, and log retrieval
- File transfer and PTY support are planned behind declared capabilities instead of hidden assumptions
- OR3 Net public runtime-session endpoints remain stable while the remote-node adapter gains richer support
- If a requested runtime-session capability is unavailable on the node, OR3 Net returns a clear capability error

### Req 8. File access with explicit safety boundaries

As an operator, I want agent file access to be useful for machine control without exposing the full host filesystem by default.

Acceptance criteria:

- The agent enforces configured allowed roots or workspace policies for file reads and writes
- Upload and download size limits are configurable and enforced
- Path traversal and invalid path encodings are rejected clearly
- File APIs are only advertised when enabled in the node manifest/config
- File operations are auditable through agent logs and control-plane events where applicable

### Req 9. Interactive PTY support

As a user, I want terminal-style remote control when the target machine and agent configuration allow it.

Acceptance criteria:

- The plan defines a PTY-capable transport shape for input, output, resize, close, and exit signaling
- PTY support is optional and capability-gated
- PTY session limits are enforced per node
- Unsupported platforms or shells fail clearly instead of hanging
- PTY lifecycle is cleaned up on disconnect or process exit

### Req 10. Optional service exposure and browser launch support

As a user, I want OR3 Net to expose browser-facing services running on the controlled machine without giving the browser raw node credentials.

Acceptance criteria:

- The node agent can advertise service-exposure capabilities separately from plain command execution
- OR3 Net remains responsible for launch-token minting and browser-facing authorization
- Tunnels or service launches are revocable and expiring
- Browser access flows do not require exposing arbitrary raw host ports as the main model
- Service launch failures surface explicit status and recent failure reasons

### Req 11. Host safety and bounded behavior

As the system, I want the agent to stay safe by default because it runs directly on a real computer.

Acceptance criteria:

- Exec timeout, output byte caps, stdin limits, and concurrency limits are configurable and enforced
- Environment-variable passthrough is allowlisted or explicitly configured
- The agent does not leak stored tokens, secrets, or filesystem contents through generic error messages
- Dangerous capabilities are opt-in and reflected in the manifest
- The default local execution mode is trusted-host oriented, not marketed as hostile-code isolation

### Req 12. Local durability and restart behavior

As an operator, I want restarts to be predictable and not destroy identity or revocation state.

Acceptance criteria:

- The agent persists at least identity material, active credential state, and enough local metadata to recover cleanly from restart
- Restart behavior for in-flight execs and PTYs is explicitly defined and documented
- Revoked credentials remain unusable after restart
- Health and last error information survive long enough to debug recent failures
- The chosen storage approach remains simple and inspectable

### Req 13. Observability and debuggability

As a developer or operator, I want to answer “why isn’t this machine controllable?” quickly.

Acceptance criteria:

- The agent exposes local health and info surfaces suitable for debugging
- Connection state, last control-plane error, and last execution failure are inspectable
- OR3 Net can distinguish enrollment problems, approval problems, credential problems, transport problems, and execution problems
- Local logs are readable without deep distributed tracing infrastructure
- Manual testing from install to first command is documented and repeatable

## 3. Non-functional constraints

- Keep the design low-complexity and low-RAM; prefer a single-process agent with small internal modules
- Optimize the default operator UX around `bun install -g or3-node` and `or3-node launch`; extra setup commands must be optional or clearly advanced
- Stay compatible with OR3 Net’s current SQLite-backed control plane and workspace-scoped auth model
- Favor extending existing contracts in `src/contracts`, `src/nodes`, and `src/runtime` rather than inventing a separate platform
- Prefer outbound connectivity from the node to OR3 Net for production flows
- Keep the public OR3 Net API stable; protocol changes should be internal between the control plane and the node agent
- Minimize new control-plane code in `or3-net`; prefer extending existing node enrollment, transport, lease, executor, and runtime-session seams over adding new route families or services
- Preserve deterministic behavior where possible and make transient failure states explicit
- Do not assume hostile multi-tenant isolation on the host; safety comes from config, limits, and explicit capability declarations
- Keep cross-platform support capability-gated: Linux first for the richest feature set, macOS and Windows for core execution and file control with clear fallbacks
