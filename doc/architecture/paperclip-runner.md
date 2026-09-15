# ADR: Paperclip Runner architecture

- Status: Proposed
- Date: 2026-08-24
- Owners: Paperclip control plane and runner maintainers
- Related: [Paperclip Runner compatibility and rollout](paperclip-runner-compatibility.md)

## Context

Paperclip is a control plane. It owns companies, agents, issues, budgets,
approvals, and durable workflow state. Agent providers remain execution
services. Existing adapters invoke those services directly from the Paperclip
server.

Paperclip Runner introduces a separate execution process for provider sessions.
This process needs durable delivery, restart recovery, and governed access to
Paperclip actions. It must not become a second control plane. It must also land
without changing the behavior of existing adapters.

The implementation remains behind one explicit experimental adapter and one
default-off instance flag. Its qualified provider catalog includes Codex,
OpenCode, Claude Managed, AWS AgentCore, and pinned Claude/Codex ACPX profiles.

## Decision

Add a standalone package named `@paperclipai/paperclip-runner`. The package owns
the language-neutral Paperclip Runner Protocol (PRP), the Rust runner process,
provider drivers, deterministic replay, and semantic action dispatch contracts.

Add one explicit adapter named `paperclip_runner`. The adapter is available only
when an instance-level, default-off rollout flag is enabled. Provider selection
is persisted per run and may use only a qualified provider profile.

Do not route existing adapters through Paperclip Runner. A direct adapter keeps
its current invocation, transcript, interaction, cancellation, and finalization
paths.

## Goals

- Keep runner process ownership outside the Paperclip server process.
- Preserve Paperclip as the authority for identity, policy, and workflow state.
- Recover a run after runner or network interruption without duplicate effects.
- Expose only actions that the current run is allowed to use.
- Make protocol behavior deterministic across TypeScript and Rust.
- Keep existing adapter behavior unchanged while the runner is experimental.

## Non-goals

- Replace existing direct adapters.
- Move business authorization or issue status policy into Rust.
- Give runnerd a broad Paperclip API credential.
- Support unqualified provider versions, arbitrary ACPX agents, or editable
  remote-resource identity in agent configuration.
- Expose browser SDK, React SDK, eval, lab, or scenario-explorer package entry
  points in the initial release.
- Commit recorded screenshots, stress logs, or construction history as product
  architecture.

## Topology

The initial local topology is:

```text
Paperclip server
  |  authenticated PRP v1 WebSocket
  v
paperclip-runnerd
  |  qualified native provider protocol
  v
Codex / OpenCode / ACPX / Claude Managed / AWS AgentCore
```

The server opens a native run and launches a verified runnerd artifact in the
realized execution environment. Runnerd opens the outbound PRP connection. It
then owns the provider process group and the durable transport state for that
run.

The browser does not connect to runnerd. It reads projections from the existing
Paperclip APIs and task-thread models.

## Dependency direction

The runner package must build and test without importing Paperclip server, UI,
CLI, database, or other private workspace implementation modules.

```text
JSON Schema and fixtures
          |
          +------------------+
          v                  v
 TypeScript contracts   Rust runner core
          |                  |
          +--------+---------+
                   v
         deterministic parity

Paperclip server ----implements----> runner public ports
```

The dependency points from an implementation to a contract. The Paperclip
server may implement a public runner port. The runner package must not import
the server implementation.

The initial public package surfaces are:

- `@paperclipai/paperclip-runner` for runtime contracts and clients.
- `@paperclipai/paperclip-runner/testing` for deterministic fakes and
  conformance helpers.

Every export must have an implementation and a clean-consumer test before it is
published. Later SDK, eval, and lab surfaces require separate decisions.

## Protocol boundary

PRP v1 uses a WebSocket at:

```text
/api/runner/v1/connect/:runId
```

JSON Schema is the language-neutral protocol authority. TypeScript and Rust use
the same canonical fixtures and must produce the same replay result.

Protocol rules are fail closed:

- Unknown required protocol or schema versions are rejected.
- Unknown required discriminators and enum values are rejected.
- Additive optional object fields may be accepted when v1 consumers can ignore
  them safely.
- Frames, headers, durable state, diagnostic tails, and replay windows are
  bounded.
- Event identity and ordering remain stable across reconnect and restart.

Provider-native messages do not cross this boundary. Drivers translate them to
provider-neutral PRP events, results, usage, cancellations, and structured
input.

## Trust boundary

The Paperclip server is authoritative for:

- company, agent, issue, run, session, and user attribution;
- rollout and runtime selection;
- action discovery and authorization;
- approval, budget, secret, revision, and workspace policy;
- durable application records and activity history;
- result acceptance, finalization, and issue status.

Runnerd is authoritative only for its local responsibilities:

- provider process supervision;
- provider session and turn transport;
- durable PRP outbox and command receipts;
- stable runner-side event identity;
- bounded process diagnostics.

Runnerd receives a short-lived, one-use bootstrap ticket. The ticket is bound to
the company, agent, issue, run, runner, session, turn, and verified artifact. The
server exchanges it for a short-lived connection lease. Raw tickets are never
stored. Runnerd never receives a broad Paperclip API key.

The server rejects expired, replayed, revoked, cross-company, mismatched,
malformed, oversized, or protocol-incompatible connections. Cancellation,
timeout, supersession, and environment-lease loss revoke runner authority.

## Durable delivery and recovery

Runnerd persists an event before it sends the event. The server acknowledges a
cumulative source cursor. Runnerd removes acknowledged data only after it
validates that cursor.

A reconnect reports the last processed command, the next source sequence, the
last acknowledged source sequence, and the unacknowledged range. The server may
then replay one pending command and accept byte-equivalent event retries.

Command identity is idempotent. Reusing a command ID with the same canonical
input returns the stored result. Reusing the ID with different input fails
closed. A repeated semantic tool call cannot repeat an application effect.

Recovery is bounded. Exhausted storage, reconnect, command, or time limits end
the run with a classified failure instead of an unbounded loop.

## Semantic actions

PRP carries provider-neutral semantic operation IDs. The package may define an
operation catalog, but catalog presence does not grant authority.

For each run, the server projects only operations that have a production
binding and that the current actor may discover. An unbound or unauthorized
operation is absent from discovery. The server validates inputs, executes the
existing application authority, and returns a redacted receipt.

This keeps these invariants in one place:

- company scoping;
- actor and run attribution;
- authorization and approval;
- revision and idempotency checks;
- budget and secret policy;
- activity logging and safe error details.

Runnerd cannot forge identity through tool input. Identity and scope come from
the authenticated connection binding.

## Structured input

Questions use `paperclip.question_set.v1`. Responses use the matching canonical
response contract. Drivers translate between these provider-neutral records and
provider-native input APIs.

The server validates a response at the untrusted API edge and again against the
persisted question set before delivery. A process loss may materialize a durable
task-thread interaction, but cancellation and an already resolved request must
not create a second interaction or continuation.

## Persistence and finalization

Native run records are additive. Existing heartbeat and issue records remain
readable. A runner result is an untrusted claim. It does not directly update an
issue status.

The server validates the result, classifies durable evidence, applies status
policy, commits workflow effects, and records finalization. Each phase is
idempotent and recoverable. Existing direct adapters keep their existing
finalization paths and do not invoke native status arbitration.

Disabling the rollout flag blocks fresh runner starts. It does not make an
already persisted native run unreadable or prevent bounded recovery and
finalization of that run.

## Rollout

The rollout has three gates:

1. The instance flag is enabled.
2. The agent explicitly selects `paperclip_runner`.
3. The adapter selects a provider from the qualified catalog: Codex, OpenCode,
   pinned Claude/Codex ACPX, Claude Managed, or AWS AgentCore.

The adapter is hidden from creation and selection surfaces while the flag is
off. Server validation also rejects a fresh runner selection or start while the
flag is off. UI hiding is not the security boundary.

Runtime selection is persisted before launch. Later setting changes cannot
silently move an in-flight run between the direct and native execution paths.

The detailed compatibility rules are in
[Paperclip Runner compatibility and rollout](paperclip-runner-compatibility.md).

## Observability

The server records structured runner, provider, semantic action, interaction,
usage, and terminal events. Logs and receipts must not contain bootstrap
tickets, leases, provider credentials, secret values, complete environments, or
private host paths.

The task page may project these records through existing thread components. A
runner-only control must depend on persisted runtime facts. It must not depend
only on the agent adapter profile.

## Consequences

This design adds process, protocol, and recovery complexity. In return, it gives
provider sessions a durable and testable execution boundary without moving
Paperclip governance into the runner.

The default-off, explicit-adapter rollout duplicates some provider
configuration during the experiment. This is intentional. It keeps comparison
and rollback simple and prevents a global migration of existing agents.

The standalone package boundary requires generated artifacts, clean-consumer
tests, and cross-language parity gates. These checks add build cost, but they
prevent server implementation details from becoming accidental public API.

## Required proof before general availability

- TypeScript and Rust accept and reject the same protocol fixtures.
- Lost acknowledgements, reconnects, runner restarts, and duplicate commands do
  not duplicate events or effects.
- Bootstrap replay, binding mismatch, and cross-company access fail closed.
- Only authorized and production-bound actions appear in discovery.
- Cancellation settles provider, runner, transport, and application state.
- Flag-off direct-adapter runs create no native records and start no runner
  process.
- Persisted native runs remain readable and recoverable after the flag changes.
- Codex completes the server to PRP to runnerd to provider to server path.
- Existing adapter compatibility tests remain byte stable where specified.
