# Paperclip Native Runner Mode
## Minimal spike specification and production-compatible design

**Document status:** Draft v0.2<br>
**Date:** 2026-08-07<br>
**Audience:** Paperclip control-plane, runtime, sandbox, adapter, and UI workers<br>
**Primary goal:** Prove that Paperclip can deliver a Codex-TUI-quality live agent experience without loading the Paperclip skill into the model and without making the model operate Paperclip's control-plane API.

---

## 0. Executive decision

Build an additive **Native Runner Mode** with this shape:

```text
Paperclip control plane and task UI
          |
          | Paperclip Runner Protocol (PRP)
          | outbound, durable, bidirectional WSS
          v
paperclip-runnerd inside the sandbox
          |
          | local harness protocol
          | stdio / Unix socket / loopback HTTP
          v
Harness Driver
  - Codex app-server
  - ACP / acpx
  - Claude Agent SDK or Claude ACP
  - OpenCode
  - Pi
  - sandbox-agent
  - generic JSONL/PTY fallback
          |
          v
Raw agent harness
```

The essential architectural choices are:

1. **The sandbox runner initiates the network connection.** Paperclip does not require an inbound port into Daytona, exe.dev, or another provider.
2. **The network contract is Paperclip-specific.** ACP, Codex app-server, and other harness protocols stay local to the sandbox. They are drivers beneath the runner, not Paperclip's public control-plane protocol.
3. **The runner is deterministic software, not a sidecar LLM.**
4. **Paperclip owns checkout, run identity, retries, budgets, approvals, issue transitions, event durability, and audit.**
5. **The model sees only the task and any task-domain instructions.** It does not see the Paperclip skill, Paperclip API routes, a Paperclip JWT, checkout rules, or heartbeat rules.
6. **Every accepted turn has typed lifecycle events and exactly one terminal state.**
7. **Success requires a structured result.** Process exit code or confident prose is not enough.
8. **Live and replay use the same ordered event reducer.**
9. **The implementation is additive.** Existing adapters continue to use the legacy `execute()` path until migrated.
10. **Direct Codex app-server is the reference driver.** ACP/acpx is the first portability driver. The two should share the same Paperclip-side conformance suite.
11. **The database is authoritative.** A connected runner or remote backend is an active producer, not the sole owner of session truth.
12. **MCP remains a separate tool plane.** Paperclip resolves run-scoped MCP bindings and the runner injects them through capable harness drivers; PRP does not tunnel general MCP traffic.
13. **Native sessions have pluggable backends.** The first backend uses `paperclip-runnerd`; hosted agent platforms can implement the same normalized contract without pretending to be Paperclip-managed sandboxes.
14. **Durable control events and transient media use different paths.** Channel adapters consume the normalized event model, while low-latency audio or media can use an authenticated side channel bound to the same identities.
15. **The protocol is language-neutral and independently testable.** JSON Schema, fixtures, and conformance behavior are authoritative for Rust, TypeScript, and future implementations.

The minimal vertical slice is:

> From a Paperclip task, atomically acquire the task, launch or resume a sandbox, connect an outbound runner, start Codex app-server locally, stream typed Codex events into a new live run console, allow steering and interruption, survive a control-plane connection restart without duplicate events, and finalize the existing Paperclip run through a structured result—all with no Paperclip skill and no Paperclip API credential available to the model.

---

## 1. Why this is a new runtime path rather than a smaller skill

The current Paperclip integration asks the model to interpret an operational contract expressed as prose. The Paperclip skill currently covers responsibilities including:

- wake context and heartbeat behavior;
- authentication environment variables;
- run identity headers;
- task discovery and checkout;
- issue state transitions;
- progress comments;
- blockers;
- delegation and approvals;
- handoff and terminal behavior.

Some of those are legitimate model judgments, but most are deterministic runtime or control-plane behavior.

The current server adapter boundary is also invocation-shaped:

```ts
interface ServerAdapterModule {
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
}
```

The execution context provides callbacks for logs, metadata, runtime progress, process spawn, and related events. That works for a one-shot CLI invocation. It does not naturally express a durable, bidirectional session with:

- multiple turns;
- live steering;
- turn-level interruption;
- permission requests;
- elicitation;
- session reconciliation;
- connection loss and replay;
- independent runner and harness lifecycles;
- persistent warm handles.

Trying to add all of those as optional callbacks around `execute()` would preserve the wrong abstraction. Native Runner Mode therefore introduces a separate session-oriented internal contract while preserving `AdapterExecutionResult` as the terminal compatibility boundary.

The old skill remains useful only as a compatibility polyfill for weak or opaque adapters.

---

## 2. Current Paperclip seams to preserve

This design intentionally reuses the strongest existing Paperclip components.

### 2.1 Environment and sandbox orchestration

Keep the existing environment-run orchestration responsible for:

- resolving the configured environment;
- acquiring or resuming the environment lease;
- enforcing execution allowlists;
- realizing the execution workspace;
- producing a provider-neutral execution target;
- retaining, releasing, or failing the lease;
- finalizing workspace operations after execution.

The native branch should begin **after the execution target and workspace have been realized**, not before.

### 2.2 Run, issue, budget, and governance state

Keep Paperclip authoritative for:

- issue assignment and atomic checkout;
- heartbeat/run records;
- issue execution locks;
- cost and budget enforcement;
- source-trust policy;
- tool access policy;
- workspace policy;
- company and organization permissions;
- issue comments, work products, and final handoffs;
- governance approvals and board controls.

The harness must not become authoritative for any of these.

The database is authoritative. A connected runner or remote backend is an active producer, not the sole owner of session truth. If a provider cannot resume state that was never durably exposed, the normalized session must become explicitly degraded or unrecoverable; Paperclip must not manufacture a replacement provider session and label it resumed.

### 2.3 Existing live-event infrastructure

Reuse the existing Paperclip server-to-browser live-event path for UI fanout. The browser should never connect directly to a sandbox runner.

The native runtime adds:

- a runner-to-control-plane WebSocket;
- durable ingestion and normalization;
- run-filtered browser snapshot and replay APIs;
- richer event types and a dedicated UI reducer.

### 2.4 Existing adapter path

Legacy behavior remains:

```text
heartbeat service
  -> environment acquisition
  -> workspace realization
  -> adapter.execute(...)
  -> onLog/onMeta/onEvent callbacks
  -> AdapterExecutionResult
  -> workspace finalization and run completion
```

Native behavior becomes:

```text
heartbeat service
  -> environment acquisition
  -> workspace realization
  -> nativeSessionRuntime.execute(...)
  -> durable runner commands/events
  -> NativeRunResult
  -> AdapterExecutionResult compatibility conversion
  -> native-aware run/issue finalization
  -> existing workspace finalization
```

This keeps workspace finalization and all legacy adapter behavior intact. The additive native discriminator extends run/issue finalization only where the legacy exit-code heuristic cannot represent a native disposition.

---

## 3. Product definition: what “Codex feels better” must mean

“Feels like Codex” should be defined as a conformance checklist rather than an aesthetic judgment.

### 3.1 Launch feedback

The task page must expose each phase separately:

1. Task checkout acquired.
2. Environment lease requested.
3. Sandbox allocation started.
4. Sandbox reachable.
5. Runner process started or discovered.
6. Runner authenticated.
7. Workspace prepared.
8. Harness process started or reused.
9. Harness initialized.
10. Session created or resumed.
11. Turn accepted.
12. First agent event received.
13. First tool or command event received.

The user must never see a generic spinner for this entire interval.

Each phase records:

- state;
- start time;
- end time;
- duration;
- cold/warm classification;
- retry count;
- failure code and remediation when applicable.

### 3.2 Live event fidelity

The task page must render, as first-class typed objects:

- assistant messages;
- user steering messages;
- reasoning summaries, never hidden chain of thought;
- plans and plan changes;
- tool calls and results;
- shell commands, streaming output, exit code, and duration;
- file changes and patches;
- aggregate diff;
- approvals;
- requests for user input;
- usage and cost updates;
- artifacts;
- verification/test evidence;
- terminal result.

A raw terminal remains useful for debugging or harnesses with no typed protocol, but it is not the canonical model for the native path.

### 3.3 Responsiveness

While a turn is active, the user can:

- send a steering message without waiting for the turn to end, when supported;
- interrupt the current turn without destroying the session;
- interrupt and immediately start a replacement turn;
- stop the current turn;
- stop the whole Paperclip run;
- answer a permission or input request;
- reconnect the browser without losing state.

The composer remains visible and usable while the agent is active.

### 3.4 Stable identity

The UI does not reconstruct identity from text. It receives stable IDs for:

- Paperclip run;
- normalized agent session;
- provider/harness session;
- turn;
- item;
- tool call;
- command;
- permission request;
- input request;
- artifact.

Items appear once. Streaming updates mutate the same item. Reconnect does not duplicate them.

### 3.5 Recovery

The following must work without silently creating a replacement session:

- browser refresh;
- browser disconnect;
- control-plane live-event socket reconnect;
- runner WebSocket reconnect;
- control-plane process restart;
- transient network loss;
- harness process restart when the harness supports resume.

When exact session resume is impossible, the run changes to an explicit recoverable failure or `needs_review`. It must not pretend that a fresh session is the same session.

### 3.6 Terminal clarity

Every accepted turn ends in exactly one of:

- completed;
- failed;
- interrupted;
- cancelled.

Every Paperclip run ends in exactly one structured disposition:

- `done`;
- `blocked`;
- `needs_review`;
- `yielded`;
- `failed`;
- `cancelled`.

A process exit is evidence, not the disposition itself.

---

## 4. Terminology and identity model

Use these terms consistently.

| Term | Meaning |
|---|---|
| **Task** | A Paperclip issue or work item. |
| **Run / attempt** | One Paperclip execution attempt against a task. This is the existing heartbeat run identity. |
| **Environment lease** | Paperclip's claim on a local, SSH, sandbox, VM, or provider environment. |
| **Sandbox** | The isolated compute instance in which the runner and harness execute. |
| **Runner instance** | One `paperclip-runnerd` process identity. A warm runner may serve multiple runs serially or, later, concurrently. |
| **Runner connection** | One authenticated network connection from a runner to the control plane. It can be replaced while preserving runner identity. |
| **Normalized session** | Paperclip's provider-neutral agent-session record. |
| **Driver session** | The session identity exposed by ACP, app-server, SDK, or another harness protocol. |
| **Provider session** | The underlying provider-native thread/session identity, when distinct. |
| **Turn** | One user/input request and the agent work it triggers. Steering may remain in the turn or create a later turn depending on driver semantics. |
| **Item** | A typed unit inside a turn: message, tool, command, file change, plan, approval, and so on. |
| **Runtime request** | A pending permission or elicitation request from the harness. |
| **Control-plane approval** | A Paperclip governance decision. It is not a runtime request. |
| **Artifact** | A durable file, diff, report, test result, URL, or other output referenced by the run. |

### 4.1 Required identity graph

```text
Paperclip issue
  └── Paperclip run / attempt
        ├── environment lease
        ├── runner instance
        └── normalized agent session
              ├── driver session
              ├── provider-native session
              ├── turn 1
              │     ├── item A
              │     └── item B
              ├── human steering
              └── turn 2
```

Never use one session ID field to represent all of these.

### 4.2 Session reuse policy

A runner profile declares one of:

```ts
type SessionReusePolicy =
  | "new_per_run"
  | "reuse_per_issue"
  | "reuse_per_workspace";
```

The spike should implement `new_per_run` and `reuse_per_issue`. `reuse_per_workspace` is deferred because it creates more complex context and access-boundary questions.

---

## 5. System architecture

### 5.1 Northbound and southbound contracts

There are three separate contracts.

#### Contract A: Paperclip Runner Protocol

Between the Paperclip control plane and `paperclip-runnerd`.

This protocol owns:

- authentication;
- runner registration;
- environment/run binding;
- command delivery;
- event delivery;
- acknowledgements;
- replay;
- liveness;
- version negotiation;
- capability advertisement;
- artifact upload references;
- session and turn control.

This is the durable WAN protocol.

#### Contract B: Harness Driver API

Between `paperclip-runnerd` and a local harness.

Examples:

- Codex app-server JSON-RPC over stdio;
- ACP over local stdio or socket;
- acpx embedded runtime or subprocess;
- Claude Agent SDK in-process adapter;
- OpenCode local server;
- Pi RPC/SDK;
- Rivet sandbox-agent on loopback;
- PTY fallback.

This is local and replaceable.

#### Contract C: Optional model-facing semantic tools

Only model judgments that cannot be inferred deterministically should be exposed:

```text
paperclip.finish
paperclip.block
paperclip.ask
paperclip.progress        # optional
```

Managers may later receive:

```text
paperclip.delegate
paperclip.reprioritize
paperclip.request_approval
paperclip.inspect_team
```

These tools are capability-scoped to the current run. They do not expose the general Paperclip REST API.

### 5.2 Control-plane components

```text
NativeSessionRuntime
  ├── NativeSessionBackend
  │     ├── RunnerBackend
  │     └── RemoteAgentBackend
  ├── RunnerRegistry
  ├── RunnerCommandService
  ├── NativeEventIngestor
  ├── NativeSessionService
  ├── NativeRuntimeRequestService
  ├── NativeRunProjectionService
  ├── NativeResultFinalizer
  └── NativeRunRecoveryService
```

`NativeSessionBackend` is the control-plane boundary for normalized session behavior. Both initial backend types expose the same sessions, turns, capabilities, events, runtime requests, results, and recovery states:

- `RunnerBackend` sends PRP commands to `paperclip-runnerd`, which delegates to a local harness driver.
- `RemoteAgentBackend` connects to a hosted agent platform through streaming HTTP, WebSocket, webhook, polling, or a provider SDK hidden behind the connector.

Remote connectors preserve provider event IDs for deduplication and explicitly report unsupported capabilities. Environment placement and agent-session execution remain separate concepts; a hosted agent is not represented as a Paperclip sandbox unless Paperclip actually manages that environment.

### 5.3 Sandbox components

```text
paperclip-runnerd
  ├── PRP transport
  ├── command dispatcher
  ├── durable outbox/spool
  ├── session registry
  ├── process supervisor
  ├── artifact uploader
  ├── redaction/size limits
  └── drivers/
        ├── codex_app_server
        ├── acp
        ├── sandbox_agent
        └── fake
```

### 5.4 Browser components

```text
NativeRunBoundary
  ├── RunConnectionBanner
  ├── RunPhaseStrip
  ├── LiveRunTimeline
  │     ├── MessageItem
  │     ├── PlanItem
  │     ├── ToolItem
  │     ├── CommandItem
  │     ├── FileChangeItem
  │     ├── ApprovalItem
  │     ├── InputRequestItem
  │     ├── UsageItem
  │     └── ResultItem
  ├── LiveRunComposer
  ├── RunArtifactPanel
  └── NativeRunInspectorDrawer
```

The browser subscription is a logical per-run stream. One company-scoped physical connection may carry many run topics, but every snapshot, cursor, command state, and event projection remains isolated by company and run identity.

### 5.5 Interaction channels and transient media

A channel adapter connects a human or external system to a normalized Paperclip session. Initial and future examples include the browser, voice gateways, Slack, Discord, email, and CopilotKit-style channel adapters.

Channel adapters send normalized input and consume the durable event stream for control state, transcripts, tool events, runtime requests, approvals, results, and reconnect behavior. Audio frames and other latency-sensitive transient media may use a separate authenticated media channel bound to the same company, run, session, and turn identities.

The database stores durable media metadata, transcripts, consent records, important markers, and artifact references. It does not need to store every audio frame as a normal run event. Paperclip remains authoritative for authorization, session binding, interruption, audit, and terminal state.

### 5.6 MCP injection boundary

MCP is separate from PRP and the harness driver protocol. Paperclip core owns the MCP gateway, catalog, authentication, authorization, policy, credentials, audit rules, and proxy behavior.

Paperclip passes resolved, run-scoped MCP bindings to the native session backend. A binding may reference an authenticated MCP server, a Paperclip-controlled MCP proxy, or an approved local MCP server definition. A capable local driver translates that binding into the harness-native form, such as a server URL, command configuration, environment reference, or session initialization field.

The runner may expose loopback transport or start an approved workspace-local MCP process when a harness requires it, but it does not become the authority for MCP permissions or long-term secrets. General MCP traffic must not be tunneled through PRP event messages.

### 5.7 Standalone runner workspace

The `packages/paperclip-runner` workspace must support protocol and driver development without booting the full Paperclip product. It includes:

- a deterministic fake harness driver;
- a minimal mock Paperclip control-plane harness that sends commands, ingests events, acknowledges cursors, and simulates reconnects;
- a lightweight browser devtools/example page using the production schemas and reducer behavior;
- standalone examples for real drivers, beginning with direct Codex and then ACP/acpx;
- phase-level latency and throughput instrumentation that excludes unrelated Paperclip startup cost.

These surfaces use the public runner protocol, fixtures, and reducer. They must not create a second control-plane contract or a test-only runner API.

---

## 6. Scope of the minimal spike

A detailed architecture does not require building every production feature in the first spike.

### 6.1 In scope

1. Feature-flagged native execution mode.
2. One outbound runner connection per sandbox.
3. One active native run per runner for the first vertical slice.
4. Direct Codex app-server driver.
5. A fake deterministic driver for conformance tests.
6. One cold-sandbox provider through the existing environment abstraction.
7. A second provider smoke test, specifically Daytona and exe.dev if both are already available.
8. Typed messages, plan, commands, tool calls, file changes/diff, usage, approvals, and final result.
9. Start, steer, interrupt, interrupt-and-send, stop turn, and stop run.
10. Runner reconnect and event replay.
11. Control-plane restart recovery.
12. No Paperclip skill and no Paperclip API credential in the model process.
13. Structured terminal result.
14. Existing workspace finalization and issue/run finalization.
15. Native run UI mounted inside the current task page.
16. Instrumentation that separates sandbox, runner, harness, model, and UI latency.
17. Language-neutral schemas and fixtures consumed by Rust and TypeScript conformance tests.
18. Resolved MCP binding injection through an advertised driver capability.
19. `NativeSessionBackend` with a runner backend and a fake remote-backend conformance implementation.
20. Standalone fake driver, mock control plane, browser devtools page, real-driver examples, and performance harness inside the runner workspace.
21. Channel and media extension points proven by conformance fixtures without requiring a production voice integration.

### 6.2 Explicit non-goals

1. Migrating every existing adapter.
2. Replacing the environment-run orchestrator.
3. Replacing Paperclip's issue, budget, approval, or workspace models.
4. Multi-agent orchestration inside one sandbox.
5. Arbitrary parallel turns in one session.
6. A general third-party public protocol.
7. Binary wire encoding.
8. Browser-to-runner networking.
9. Full terminal emulation as the primary UI.
10. Perfect recovery after permanent sandbox destruction.
11. Broad Paperclip REST access from the model.
12. Deleting the legacy skill or legacy adapter path.
13. Designing manager delegation tools in the first vertical slice.
14. Implementing every hosted agent platform connector.
15. Shipping a production voice, telephony, Slack, Discord, email, or CopilotKit gateway.
16. Storing transient audio frames in the canonical run-event log.
17. Defining a separate fleet protocol or first-spike fleet product; fleet remains a future control-plane projection over existing runner, session, run, health, capability, event, and cursor primitives.

### 6.3 Architecture proof after the first vertical slice

After direct Codex works, add an ACP/acpx driver without changing:

- the runner protocol;
- the control-plane event ingestor;
- the task-page reducer;
- the run state machine;
- the result finalizer.

That is the proof that the abstraction is real.

---

## 7. End-to-end lifecycle

### 7.1 Cold sandbox path

1. A wake or user action requests execution.
2. Paperclip validates agent invokability, budgets, policy, and assignment.
3. Paperclip atomically checks out the issue and creates the heartbeat run.
4. Paperclip resolves the native session backend, runner profile, native driver, and run-scoped MCP bindings.
5. Environment orchestration acquires a lease.
6. Workspace orchestration realizes the workspace.
7. Paperclip creates a `runner_instance` expectation bound to the lease and run.
8. Paperclip mints a one-time runner bootstrap ticket.
9. The provider-specific execution target starts `paperclip-runnerd` with:
   - control-plane URL;
   - bootstrap ticket;
   - runner instance ID;
   - environment lease ID;
   - state directory;
   - allowed driver configuration.
10. The runner establishes outbound WSS over port 443.
11. The runner and control plane negotiate protocol and capabilities.
12. The control plane sends `run.prepare`.
13. The runner validates the requested working directory and resource constraints.
14. The control plane sends `session.open` with the resolved driver configuration and MCP bindings.
15. The Codex driver starts `codex app-server` over local stdio.
16. The driver injects supported MCP bindings, initializes app-server, and creates or resumes a thread.
17. The runner emits `session.ready`.
18. The control plane sends `turn.start` with the task envelope.
19. The runner emits normalized typed events.
20. The control plane persists and ACKs events, then fans them out to the browser.
21. Human steering becomes a durable control-plane command and is delivered over the same runner connection.
22. The harness emits a structured result or invokes the completion tool.
23. The runner emits `run.result`.
24. The control plane finalizes the native session, converts the result to the additive native-aware adapter result shape, and runs native-aware run/issue finalization plus existing workspace finalization.
25. Paperclip applies issue status, handoff, cost, and work-product behavior.
26. The run and environment lease are released or retained according to warm policy.

### 7.2 Remote agent backend path

1. Paperclip validates the run and creates the same durable run/session records used by the runner backend.
2. `RemoteAgentBackend` opens or resumes the provider session through its connector.
3. The connector reports normalized capabilities and preserves provider event IDs.
4. Paperclip sends normalized turn and control commands through the backend.
5. The connector consumes streaming responses, WebSocket events, webhooks, polling results, or SDK callbacks and emits canonical events through the normal ingestor.
6. Unsupported steering, interruption, permissions, media, or MCP behavior is explicit in capabilities and UI degradation.
7. Reconnect and recovery use the same durable snapshot, cursor, request, result, and terminal-state rules as the runner backend.

The first spike needs a fake remote backend that passes conformance tests. It does not need a production connector for every hosted platform.

### 7.3 Warm runner path

If the environment lease and runner are still valid:

1. Paperclip resolves the warm runner by lease and runner profile.
2. The existing runner connection receives `run.prepare`.
3. The runner starts or reuses the harness according to warm policy.
4. A new Paperclip run is bound to a new normalized session or an explicitly resumed session.
5. No sandbox bootstrap or binary install occurs.

Warm reuse must never be inferred solely because a process exists. The runner reports:

- runner version and digest;
- active configuration digest;
- driver versions;
- workspace identity;
- session inventory;
- trust boundary;
- last health check.

Paperclip decides whether reuse is legal.

### 7.4 Browser reconnect path

1. Browser fetches `native-snapshot`.
2. Snapshot includes `lastSeq`.
3. Browser subscribes to the existing Paperclip live-event channel with run filter and `afterSeq`.
4. If the first live event has a sequence gap, the browser pauses projection and fetches events after `lastSeq`.
5. The same reducer applies replay and live events.
6. Items remain deduplicated by stable item ID and canonical event sequence.

This is a logical per-run stream, not a requirement for one physical WebSocket per run.

### 7.5 Control-plane restart path

1. Runner WebSocket disconnects.
2. Runner continues the harness unless its lease policy says otherwise.
3. Runner persists outbound events in its local spool.
4. Control plane restarts and reloads active runs, runner expectations, commands, and last acknowledged source sequence from Postgres.
5. Runner reconnects with its stable runner identity and resume cursors.
6. Control plane returns the highest committed source sequence and pending commands.
7. Runner replays unacknowledged events.
8. Event ingestion deduplicates and ACKs after commit.
9. Session reconciliation asks the driver for current session/turn state when supported.
10. Any divergence becomes an explicit diagnostic or recovery state.

---

## 8. Paperclip server integration

### 8.1 Branch point

Add the native branch after environment and workspace realization, before the current adapter invocation.

Conceptual code:

```ts
const realized = await environmentRunOrchestrator.realizeForRun(...);
const executionTarget = realized.executionTarget;

let adapterResult: AdapterExecutionResult;

if (resolveRuntimeMode(agent, run) === "native") {
  const nativeResult = await nativeSessionRuntime.execute({
    run,
    issue,
    agent,
    executionTarget,
    workspace: realized.workspace,
    runtimeCommandSpec,
    runtimePolicy,
    authContext,
  });

  adapterResult = convertNativeResultToAdapterExecutionResult(nativeResult);
} else {
  adapterResult = await adapter.execute({
    ...existingExecutionContext,
    executionTarget,
  });
}

// Existing workspace finalization and cost recording continue here.
// Run/issue finalization reads adapterResult.nativeFinalization
// for native mode and keeps the legacy heuristic otherwise.
```

### 8.2 Do not extend the heartbeat monolith indefinitely

The current heartbeat service already coordinates a large amount of behavior. Native runtime code should live in focused services and be injected or called by heartbeat orchestration.

Proposed server layout:

```text
server/src/services/native-runtime/
  index.ts
  native-session-runtime.ts
  runner-registry.ts
  runner-command-service.ts
  runner-auth-service.ts
  native-event-ingestor.ts
  native-session-service.ts
  native-runtime-request-service.ts
  native-run-projection.ts
  native-result-finalizer.ts
  native-run-recovery.ts
  native-runtime-metrics.ts
  schemas.ts
```

Transport:

```text
server/src/realtime/native-runner-ws.ts
```

Routes:

```text
server/src/routes/native-runs.ts
server/src/routes/native-runtime-requests.ts
```

Shared protocol:

```text
packages/native-runtime-protocol/
  src/
    envelopes.ts
    commands.ts
    events.ts
    capabilities.ts
    results.ts
    schemas.ts
  json-schema/
  test-vectors/
```

### 8.3 Preserve the existing terminal boundary

`NativeSessionRuntime.execute()` can be internally durable and bidirectional while returning only when the run reaches a terminal state.

```ts
interface NativeSessionRuntime {
  execute(input: NativeExecutionInput): Promise<NativeExecutionResult>;
}
```

`NativeExecutionResult` should contain enough data to populate the current adapter result:

```ts
interface NativeExecutionResult {
  terminalState: "completed" | "failed" | "cancelled";
  disposition:
    | "done"
    | "blocked"
    | "needs_review"
    | "yielded"
    | "failed"
    | "cancelled";

  summary: string;
  result: StructuredRunResult | null;

  usage?: UsageSummary;
  costUsd?: number | null;

  normalizedSessionId: string;
  driverSession: Record<string, unknown> | null;
  sessionDisplayId: string | null;

  provider?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;

  error?: {
    code: string;
    family?: string;
    message: string;
    retryNotBefore?: string;
    metadata?: Record<string, unknown>;
  } | null;

  runtimeServices?: AdapterRuntimeServiceReport[];
}
```

### 8.4 Runner profile

For the spike, store this under existing runtime configuration rather than creating a complete new top-level domain model.

```ts
interface NativeRunnerProfile {
  mode: "native";

  protocolVersion: "1";
  runnerVersion: string;
  runnerDigest?: string;

  driver: {
    kind:
      | "codex_app_server"
      | "acp"
      | "sandbox_agent"
      | "fake";
    command?: string;
    args?: string[];
    versionConstraint?: string;
    config?: Record<string, unknown>;
  };

  sessionPolicy: "new_per_run" | "reuse_per_issue";

  warmPolicy:
    | "none"
    | "runner"
    | "runner_and_harness"
    | "runner_harness_and_session";

  skillMode: "none" | "minimal" | "legacy";

  permissions: {
    runtimePolicy: "interactive" | "policy_auto" | "deny";
    allowedCommands?: string[];
    allowedWriteRoots?: string[];
  };

  limits: {
    maxRunMs: number;
    maxTurnMs: number;
    maxEventBytes: number;
    maxBufferedEventBytes: number;
    maxArtifactBytes: number;
  };

  reconnect: {
    graceMs: number;
    maxOfflineMs: number;
  };
}
```

### 8.5 Runner configuration and instance model

The product should distinguish a **runner profile** from a **runner instance**.

- A runner profile is durable configuration selected by an agent or environment. A human creates or edits it.
- A runner instance is the concrete `paperclip-runnerd` process attached to a realized sandbox lease. The control plane creates and expires it automatically.
- A harness session is subordinate to a runner instance and may be reused according to `sessionPolicy`.

Do not expose an administrative action called “create runner instance.” That would encourage users and server code to treat an ephemeral network participant as durable configuration. Expose **Create runner profile** instead.

The runner-profile editor should contain these groups:

| Group | Required controls |
|---|---|
| Identity | profile name, optional description, enabled flag |
| Environment | Paperclip environment/provider selector, workspace policy |
| Driver | `codex_app_server`, `acp`, `sandbox_agent`, or `fake`; command; arguments; version constraint |
| Model defaults | provider/model/config passed to the driver, without storing provider secrets in the profile |
| Session | new per run vs. reuse per issue; idle and absolute lifetime limits |
| Warmth | cold, runner-warm, harness-warm, or session-warm |
| Skills | none, minimal, or legacy; native profiles default to none |
| Permissions | interactive, policy-auto, or deny; allowlists and write roots |
| Limits | run/turn deadlines, local event spool limit, artifact size limit |
| Reconnect | grace period and maximum disconnected duration |
| Integrity | expected runner version and optional binary digest |

The editor must have a **Validate profile** action. Validation launches or reuses a disposable environment lease and stops before model inference after checking:

1. environment acquisition and realization;
2. `paperclip-runnerd` installation or version match;
3. outbound control-plane connection and authentication;
4. driver executable discovery and version;
5. driver initialization and capability advertisement;
6. workspace read/write probe under the configured policy;
7. cancellation and clean teardown.

The validation result is a structured report with per-phase duration, discovered versions, negotiated capabilities, warnings, and the exact failing phase. It must not collapse failures into “runner failed to start.”

An agent configuration binds to a runner profile by immutable ID plus an optional configuration override. The resolved profile is snapshotted onto every run so historical runs remain explainable after the profile changes.

The task page never asks the user to select a live runner process. It shows the resolved profile and concrete runtime chain for the current attempt:

```text
Environment: daytona-us-east / sandbox sbx_…
Runner:      paperclip-runnerd 0.1.0 / instance rni_…
Driver:      codex_app_server 0.x
Harness:     Codex / thread thr_… / turn turn_…
Connection:  connected / last event 84 ms ago
```

### 8.6 Recommended configuration persistence for the spike

Avoid introducing a new organization-wide runner registry before the vertical slice is proven. Store the profile in the existing adapter/runtime configuration envelope, assign it a stable `runnerProfileId`, and copy a redacted resolved snapshot into `heartbeat_runs.runtime_state` or a dedicated JSON field.

Promote runner profiles to normalized tables only when at least one of these becomes necessary:

- profiles are shared across many agents and need independent RBAC;
- profile revisions require approval or staged rollout;
- fleet-level compatibility queries need indexed fields;
- secrets or provider-specific resources must be attached independently;
- profile usage and cost need first-class reporting.

---

## 9. The sandbox runner daemon

### 9.1 Responsibilities

`paperclip-runnerd` is responsible for:

- dialing the control plane;
- authenticating and renewing its connection lease;
- advertising driver and platform capabilities;
- receiving idempotent commands;
- supervising local harness processes;
- translating driver events into canonical runner events;
- persisting unacknowledged events;
- replaying after reconnect;
- handling cancellation and interruption;
- uploading large artifacts;
- reporting resource and phase metrics;
- enforcing command preconditions;
- keeping Paperclip credentials out of child processes;
- validating working directory boundaries;
- injecting Paperclip-resolved MCP bindings through drivers that advertise the required capability;
- shutting down or draining on lease revocation.

It is not responsible for:

- issue checkout;
- task selection;
- company policy;
- business approvals;
- budgets;
- issue state transitions;
- deciding that prose means success;
- autonomous retry policy across Paperclip attempts.
- MCP catalog, gateway policy, long-term credentials, or authorization decisions.

### 9.2 Language and packaging

Recommended production implementation:

- Rust;
- Tokio async runtime;
- `rustls` rather than a system OpenSSL dependency;
- one Linux x86_64 binary and one Linux aarch64 binary;
- release artifact with checksum and signature;
- no Node dependency;
- no package install at run time;
- optional embedded SQLite for the local outbox;
- protocol types generated or validated from shared JSON Schema.

JSON Schema and the shared protocol fixture corpus are the language-neutral source of truth. TypeScript and Rust types must be generated from or checked against that source, and both implementations must pass the same conformance and fault tests. No TypeScript or Rust implementation detail may become required wire behavior.

Keep the Paperclip control plane and browser in TypeScript.

Why Rust is suitable here:

- low idle memory for warm sandboxes;
- fast process startup;
- robust process and signal supervision;
- easy static or nearly static distribution;
- no need to provision a JavaScript runtime merely for the bridge;
- precedent in Codex app-server, Rivet sandbox-agent, and Conductor's runtime/backend.

However, performance claims must be measured. A TypeScript reference runner is acceptable as a test oracle, but it should not silently become the production default without startup, RSS, and failure testing.

### 9.3 Suggested Rust workspace

```text
runner/
  Cargo.toml
  crates/
    runner-core/
      identities.rs
      state_machine.rs
      command_dispatch.rs
      event_outbox.rs
      artifacts.rs
      process_supervisor.rs
      redaction.rs

    runner-protocol/
      generated/
      envelope.rs
      codec.rs
      validation.rs

    runner-transport-ws/
      connect.rs
      reconnect.rs
      heartbeat.rs
      ack.rs

    driver-api/
      traits.rs
      capabilities.rs
      events.rs

    driver-codex-app-server/
      process.rs
      jsonrpc.rs
      mapping.rs
      reconciliation.rs

    driver-acp/
      process.rs
      mapping.rs
      sessions.rs

    driver-fake/
      script.rs

    paperclip-runnerd/
      main.rs
      config.rs
      diagnostics.rs
```

### 9.4 Local state

Use a small local database or append-only spool at:

```text
$PAPERCLIP_RUNNER_STATE_DIR/runner.db
```

Minimum tables:

```sql
runner_state(
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);

outbox_events(
  source_seq INTEGER PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  envelope BLOB NOT NULL,
  emitted_at TEXT NOT NULL,
  acked_at TEXT
);

processed_commands(
  command_id TEXT PRIMARY KEY,
  accepted_at TEXT NOT NULL,
  terminal_status TEXT,
  terminal_payload BLOB
);

session_bindings(
  normalized_session_id TEXT PRIMARY KEY,
  run_id TEXT,
  driver_kind TEXT NOT NULL,
  driver_session_json BLOB,
  provider_session_json BLOB,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The runner deletes or compacts ACKed events. It retains processed command results long enough to answer duplicate commands idempotently.

### 9.5 Process supervision

Each harness process is launched in its own process group.

The runner must:

- capture stdout and stderr separately;
- retain a bounded diagnostic ring buffer;
- send TERM/interrupt before KILL;
- reap child processes;
- detect orphaned child processes;
- avoid inheriting runner credentials;
- set explicit environment allowlists;
- record PID, process group, start time, version, and command digest;
- report process exit independently of run disposition.

---

## 10. Paperclip Runner Protocol (PRP)

### 10.1 Transport

Use:

- WebSocket over TLS;
- runner-initiated outbound connection;
- normal HTTPS port 443;
- JSON text or binary frames in v1;
- optional per-message compression negotiated by the WebSocket stack;
- application-level acknowledgement and liveness.

Do not expose Codex app-server's experimental WebSocket over the public network. Keep app-server local over stdio or a Unix socket.

Do not use browser WebSockets directly to the runner.

### 10.2 Protocol properties

PRP v1 guarantees:

- at-least-once command delivery;
- at-least-once event delivery;
- idempotent processing;
- cumulative event acknowledgement;
- stable identities;
- ordered events per runner source stream;
- explicit capability negotiation;
- explicit terminal states;
- versioned schemas;
- bounded frames;
- replay after reconnect.

Exactly-once network delivery is not claimed. Exactly-once **effects** are obtained through IDs, unique constraints, and transactional reducers.

### 10.3 Common envelope

```ts
interface PrpEnvelope<T = unknown> {
  protocol: "paperclip.runner";
  version: 1;

  envelopeId: string;       // UUIDv7
  kind: "hello" | "welcome" | "command" | "command_result" | "event" | "ack" | "ping" | "pong";

  runnerInstanceId: string;
  connectionId?: string;

  runId?: string;
  normalizedSessionId?: string;
  turnId?: string;
  itemId?: string;

  sentAt: string;
  payload: T;
}
```

### 10.4 Handshake

Runner:

```json
{
  "protocol": "paperclip.runner",
  "version": 1,
  "envelopeId": "019...",
  "kind": "hello",
  "runnerInstanceId": "rnr_...",
  "sentAt": "2026-08-06T21:00:00.000Z",
  "payload": {
    "protocolMin": 1,
    "protocolMax": 1,
    "runnerVersion": "0.1.0",
    "runnerDigest": "sha256:...",
    "environmentLeaseId": "lease_...",
    "sandboxProvider": "daytona",
    "platform": {
      "os": "linux",
      "arch": "x86_64",
      "hostname": "..."
    },
    "drivers": [
      {
        "kind": "codex_app_server",
        "version": "...",
        "capabilities": { "...": true }
      }
    ],
    "resume": {
      "lastControllerCommandSeq": 18,
      "nextSourceEventSeq": 103,
      "unackedEventRange": [97, 102]
    }
  }
}
```

Control plane:

```json
{
  "protocol": "paperclip.runner",
  "version": 1,
  "envelopeId": "019...",
  "kind": "welcome",
  "runnerInstanceId": "rnr_...",
  "connectionId": "conn_...",
  "sentAt": "2026-08-06T21:00:00.030Z",
  "payload": {
    "selectedVersion": 1,
    "heartbeatIntervalMs": 10000,
    "connectionLeaseExpiresAt": "2026-08-06T22:00:00Z",
    "maxFrameBytes": 1048576,
    "maxBatchEvents": 100,
    "ackedSourceSeq": 96,
    "pendingCommands": []
  }
}
```

### 10.5 Commands

Every command includes:

```ts
interface RunnerCommand<T> {
  commandId: string;          // globally unique, idempotency key
  controllerSeq: number;      // ordered within runner instance
  type: RunnerCommandType;
  issuedAt: string;
  deadlineAt?: string;

  precondition?: {
    runnerState?: string[];
    runState?: string[];
    sessionState?: string[];
    activeTurnId?: string | null;
  };

  payload: T;
}
```

Required v1 commands:

| Command | Purpose |
|---|---|
| `run.prepare` | Bind run, workspace, limits, and task context to the runner. |
| `session.open` | Create or resume the normalized/driver session. |
| `turn.start` | Start a turn with task or steering input. |
| `turn.steer` | Inject guidance into an active turn when supported. |
| `turn.interrupt` | Interrupt active turn while preserving session. |
| `turn.stop` | Stop the turn with explicit terminal intent. |
| `request.resolve` | Resolve runtime permission or elicitation. |
| `session.snapshot` | Ask driver for reconcilable state. |
| `session.close` | Close session and optionally child process. |
| `run.cancel` | Cancel the Paperclip run. |
| `runner.drain` | Stop accepting new work and finish active work. |
| `runner.shutdown` | Stop runner after cleanup. |

Command results:

```ts
type CommandResultStatus =
  | "accepted"
  | "completed"
  | "failed"
  | "rejected"
  | "already_terminal"
  | "unsupported";
```

A duplicate command returns its prior result.

### 10.6 Event envelope

```ts
interface RunnerEvent<T = unknown> {
  sourceEventId: string;       // stable UUIDv7
  sourceSeq: number;           // monotonic per runner instance
  sourceInstanceId: string;    // runner instance
  sourceKind: "runner";

  runId: string;
  normalizedSessionId?: string;
  turnId?: string;
  itemId?: string;

  eventType: NativeEventType;
  schemaVersion: 1;
  priority: 0 | 1 | 2;

  emittedAt: string;
  observedAt?: string;

  payload: T;
}
```

### 10.7 Acknowledgement

After committing an event batch, the control plane sends:

```json
{
  "kind": "ack",
  "payload": {
    "ackedSourceSeq": 102
  }
}
```

The ACK is cumulative and means:

> Every source event through this sequence has been durably committed or deduplicated.

The runner must not delete events before this ACK.

### 10.8 Backpressure

Event priority:

- **P0:** terminal events, approval/input requests, cancellations, session identity, errors. Never dropped.
- **P1:** item starts/completions, plans, diffs, usage snapshots, phase changes. Persisted and not dropped.
- **P2:** text deltas, command-output deltas, repetitive progress. May be coalesced.

Recommended coalescing:

- flush after 20–40 ms;
- or after 4–16 KiB;
- or immediately before a state transition;
- retain the completed item snapshot so dropped/coalesced deltas never lose final content.

When the outbox exceeds limits:

1. coalesce adjacent P2 events for the same item;
2. stop accepting new turns;
3. emit a P0 backpressure diagnostic;
4. never discard P0;
5. cancel only according to an explicit policy.

### 10.9 Large payloads

Do not send large diffs, binary artifacts, archives, or logs through PRP.

Use:

1. control plane issues a presigned upload target or upload capability;
2. runner uploads;
3. runner emits an artifact or diff reference containing size, hash, media type, and storage ID.

### 10.10 Liveness

Use both:

- WebSocket ping/pong;
- application heartbeat containing runner state, active sessions, outbox bytes, CPU/memory, and last driver event.

Connection loss does not immediately imply run failure. The run enters a degraded/reconnecting state for the configured grace period.

---

## 11. Canonical native event model

### 11.1 Event taxonomy

#### Runner and environment

```text
runner.connected
runner.reconnected
runner.disconnected
runner.draining
runner.diagnostic

runtime.phase.changed
sandbox.metric
workspace.ready
```

#### Harness and session

```text
harness.starting
harness.ready
harness.exited
harness.diagnostic

session.starting
session.started
session.resuming
session.resumed
session.reconciled
session.closed
session.failed
```

#### Turn

```text
turn.submitted
turn.accepted
turn.started
turn.completed
turn.failed
turn.interrupted
turn.cancelled
```

#### Item

```text
item.started
item.delta
item.completed
item.failed
```

`item.started` includes a typed item descriptor:

```ts
type NativeItemKind =
  | "assistant_message"
  | "user_message"
  | "reasoning_summary"
  | "plan"
  | "tool"
  | "command"
  | "file_change"
  | "diff"
  | "approval_request"
  | "input_request"
  | "usage"
  | "artifact"
  | "verification"
  | "diagnostic";
```

#### Requests

```text
runtime_request.created
runtime_request.resolved
runtime_request.expired
runtime_request.cancelled
```

#### Result

```text
run.result.proposed
run.result.accepted
run.result.rejected
run.terminal
```

### 11.2 Item examples

Assistant item:

```ts
{
  kind: "assistant_message",
  role: "assistant",
  content: [{ type: "text", text: "..." }]
}
```

Command item:

```ts
{
  kind: "command",
  command: "pnpm test",
  cwd: "/workspace/repo",
  status: "running",
  startedAt: "...",
  outputRef?: null
}
```

File-change item:

```ts
{
  kind: "file_change",
  path: "server/src/foo.ts",
  changeType: "modify",
  patchRef?: "artifact_...",
  status: "completed"
}
```

Plan item is a full replaceable snapshot:

```ts
{
  kind: "plan",
  revision: 3,
  steps: [
    { id: "p1", text: "Inspect current adapter path", status: "completed" },
    { id: "p2", text: "Implement native driver", status: "in_progress" }
  ]
}
```

### 11.3 Raw driver data

A normalized event may include a bounded debug extension:

```ts
debug?: {
  driverEventType: string;
  driverEventId?: string;
  sanitizedPayload?: unknown;
}
```

Raw payload is never the primary UI or state-machine contract.

### 11.4 Hidden reasoning

Do not store or request hidden chain-of-thought. Only map a harness-provided, user-displayable reasoning summary when the harness explicitly exposes one.

---

## 12. State machines

### 12.1 Runner state

```text
expected
  -> bootstrapping
  -> connecting
  -> ready
  -> busy
  -> ready
  -> draining
  -> stopped

Any non-terminal state
  -> disconnected
  -> reconnecting
  -> prior state

Any state
  -> failed
```

### 12.2 Run state

```text
queued
  -> checkout_acquired
  -> environment_acquiring
  -> sandbox_starting
  -> runner_connecting
  -> workspace_preparing
  -> harness_starting
  -> session_ready
  -> turn_running
  -> awaiting_runtime_request
  -> turn_running
  -> finalizing
  -> terminal
```

Alternate terminal paths:

```text
... -> cancelling -> cancelled
... -> failed
... -> yielded
... -> needs_review
```

### 12.3 Turn state

```text
submitted
  -> accepted
  -> running
  -> awaiting_permission
  -> running
  -> awaiting_input
  -> running
  -> completed
```

Other terminals:

```text
failed
interrupted
cancelled
```

### 12.4 Core invariants

1. Every accepted turn has one terminal event.
2. A session has at most one active turn unless both driver and Paperclip profile explicitly support parallel turns.
3. Canonical event sequence is strictly monotonic per Paperclip run.
4. Source-event deduplication occurs before side effects.
5. A reconnect never silently changes the provider session identity.
6. The model cannot authorize its own Paperclip governance change through unstructured prose.
7. Runtime permissions and Paperclip approvals are distinct records and UI treatments.
8. A successful process exit does not equal successful work.
9. A structured run result is applied at most once.
10. Workspace finalization runs at most once per terminal attempt, using existing idempotency.
11. The runner credential is never inherited by the harness process.
12. Live and replayed events enter the same reducer.
13. Control-plane commands are durable before transmission.
14. Event ACK is sent only after transaction commit.
15. Paperclip remains the source of truth for task and run status.
16. The database remains authoritative across runner, connector, control-plane, and browser restarts.
17. Transient media delivery cannot bypass Paperclip authorization or create terminal state outside the durable event path.

---

## 13. Harness Driver API

### 13.1 Driver descriptor

```ts
interface DriverDescriptor {
  kind: string;
  version: string;
  protocolVersion: string;

  capabilities: DriverCapabilities;
}
```

### 13.2 Capabilities

```ts
interface DriverCapabilities {
  sessions: {
    create: boolean;
    resume: boolean;
    list: boolean;
    read: boolean;
    reconcile: boolean;
    close: boolean;
  };

  turns: {
    start: boolean;
    steer: boolean;
    interrupt: boolean;
    cancel: boolean;
  };

  events: {
    typedMessages: boolean;
    reasoningSummary: boolean;
    plans: boolean;
    tools: boolean;
    commandOutput: boolean;
    fileChanges: boolean;
    diffs: boolean;
    usage: boolean;
  };

  interaction: {
    permissions: boolean;
    elicitation: boolean;
  };

  mcp: {
    injectRemoteServers: boolean;
    injectPaperclipProxy: boolean;
    launchApprovedLocalServer: boolean;
  };

  completion: {
    structuredOutput: boolean;
    dynamicTools: boolean;
  };

  diagnostics: {
    rawLogs: boolean;
    pty: boolean;
  };
}
```

### 13.3 Driver interface

```ts
interface HarnessDriver {
  descriptor(): Promise<DriverDescriptor>;

  openSession(input: OpenDriverSessionInput): Promise<DriverSession>;

  recoverSession?(
    snapshot: PersistedDriverSession,
  ): Promise<DriverSessionRecoveryResult>;
}

interface DriverSession {
  ids(): {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };

  events(): AsyncIterable<DriverEvent>;

  startTurn(input: StartDriverTurnInput): Promise<{ turnId: string }>;

  steer?(
    input: { turnId: string; message: DriverUserMessage },
  ): Promise<void>;

  interrupt?(
    input: { turnId: string; reason?: string },
  ): Promise<void>;

  resolveRequest?(
    input: { requestId: string; response: DriverRequestResponse },
  ): Promise<void>;

  snapshot(): Promise<DriverSessionSnapshot>;

  close(input: { reason: string; force?: boolean }): Promise<void>;
}
```

### 13.4 Capability levels for UI degradation

| Level | Contract |
|---|---|
| L0 | Launch, raw logs, kill. |
| L1 | Typed item lifecycle. |
| L2 | Session identity and resume. |
| L3 | Steering and turn interruption. |
| L4 | Permission and input requests. |
| L5 | Plan, diff, usage, read/reconcile, structured completion. |

The UI only renders controls that the active driver supports.

The spike target for direct Codex is L5.

---

## 14. Direct Codex app-server driver

### 14.1 Why it is the reference implementation

Codex app-server already models:

- threads;
- turns;
- typed items;
- item start/delta/completion;
- tool and command activity;
- file changes;
- approvals;
- user input requests;
- plan updates;
- diff updates;
- usage;
- turn steering;
- interruption;
- thread read/resume.

This is closer to the desired Paperclip runtime than parsing Codex TUI output or routing through a generic one-shot CLI wrapper.

### 14.2 Local transport

Launch app-server inside the sandbox and communicate over:

- stdio JSON-RPC for the spike; or
- a local Unix socket after the spike if useful.

Do not depend on its experimental network WebSocket as the Paperclip WAN transport.

### 14.3 Driver startup

1. Resolve Codex binary and version.
2. Start app-server with sanitized environment.
3. Send protocol initialization.
4. Confirm server capabilities/version.
5. Register client-defined semantic tools if configured.
6. Create or resume thread.
7. emit `session.started` or `session.resumed`.
8. Persist thread/session parameters in the normalized session binding.

### 14.4 Event mapping

| Codex app-server concept | Native event |
|---|---|
| thread started/resumed/read | `session.*` |
| turn start/complete/fail/interrupt | `turn.*` |
| item started | `item.started` |
| item delta | `item.delta` |
| item completed | `item.completed` |
| command output | command item deltas |
| file-change patch/status | file-change item |
| plan update | plan item snapshot |
| diff update | diff item snapshot/reference |
| approval request | runtime request |
| user input request | runtime request |
| token/usage update | usage item |
| server error | diagnostic or session/turn failure |

### 14.5 Steering

`turn.steer` maps to app-server steering when the current Codex version and active turn support it.

If steering is unsupported in the current state, return `unsupported` or use the explicit `interrupt_and_send` control-plane operation. Do not fake steering by appending text to stdin.

### 14.6 Interrupt

`turn.interrupt` maps to app-server's turn interruption operation.

The runner reports:

- command accepted;
- interrupt dispatched;
- terminal turn event.

Race behavior:

- if completion committed first, interrupt returns `already_terminal`;
- if interrupt wins, the turn terminal is `interrupted`;
- duplicate interrupts return the prior command result.

### 14.7 Structured completion

Preferred order:

1. app-server structured output schema for terminal run result, when supported;
2. client-defined `paperclip.finish` dynamic tool;
3. invalid/no result becomes `needs_review`, never inferred `done`.

The task envelope tells the model the expected result shape but does not teach Paperclip API mechanics.

### 14.8 Reconciliation

After runner or control-plane reconnect:

1. read persisted thread and active turn IDs;
2. call app-server thread/turn read capability;
3. compare last known item IDs and terminal state;
4. synthesize only explicit reconciliation events;
5. never invent missing deltas;
6. if provider session cannot be found, mark `session_lost` and apply recovery policy.

---

## 15. ACP/acpx driver

### 15.1 Role

ACP is the portable local harness protocol. acpx is one implementation/runtime bridge for ACP-capable agents.

It is not the Paperclip WAN protocol and should not carry Paperclip organization semantics.

### 15.2 Mapping

| ACP concept | Native concept |
|---|---|
| ACP session | driver session |
| provider-native session metadata | provider session |
| prompt | turn start |
| session update | native item/event |
| permission request | runtime request |
| cancel | turn interrupt/cancel |
| session resume/list/read | session recovery/reconciliation |

### 15.3 Required behavior

- Persist ACP session identity separately from Paperclip run identity.
- Reconnect to the exact session when possible.
- Never silently replace a missing session.
- Normalize permission requests.
- Preserve ACP event ordering.
- Advertise actual capabilities rather than assuming all ACP agents support the same features.
- Fail closed for unhandled interactive permissions.
- Keep acpx state directory under the runner's managed state root.
- Measure acpx startup, agent startup, and first-event latency separately.

### 15.4 What this driver proves

A successful ACP driver proves that:

- the northbound protocol is not Codex-specific;
- the task UI is not Codex-specific;
- run lifecycle and result finalization are not tied to app-server;
- Paperclip can add other harnesses without reintroducing the skill.

---

## 16. Lessons from adjacent open-source systems

### 16.1 Centaur

Useful design lessons:

- durable requests, executions, and event streams live in the control plane;
- clients reconnect with an event cursor;
- each session receives isolated execution;
- the sandbox does not receive Kubernetes credentials;
- raw third-party credentials can be injected at a controlled network edge rather than exposed to the agent;
- client UI is a projection over a durable event lifecycle.

What not to copy blindly:

- Centaur's Kubernetes-specific sandbox assignment;
- its Slack-first interaction model;
- its exact harness abstraction.

Paperclip should adopt the durability and credential-boundary principles while keeping its provider-neutral environment layer.

### 16.2 Conductor OSS

Useful design lessons:

- a real PTY is valuable for fidelity, debugging, resize, and restore;
- session and workspace state can be separated from the browser;
- a paired-device bridge validates the remote-runner/relay pattern;
- worktree, diff, preview, and terminal are distinct UI surfaces;
- a native Rust runtime can supervise many CLI harnesses.

What not to copy as the canonical native model:

- terminal bytes as the primary semantic event stream.

Paperclip should offer an optional raw terminal/PTY inspector, but typed events should drive status, recovery, and the default task view.

### 16.3 Rivet sandbox-agent

Useful design lessons:

- a small Rust binary can run inside arbitrary sandbox providers;
- agent-specific interfaces can be normalized behind one API;
- sessions and universal events can be exposed consistently;
- the control plane must persist events externally.

Possible use:

- run sandbox-agent on loopback as a driver beneath `paperclip-runnerd`;
- or reuse/port adapter mappings.

Risks:

- its HTTP/SSE API is not Paperclip's durable outbound runner protocol;
- session durability and organizational lifecycle still belong to Paperclip;
- an inbound sandbox HTTP surface would create provider/tunnel complexity.

The spike should compare a custom direct Codex driver with a loopback sandbox-agent driver, but Paperclip should own PRP regardless.

### 16.4 Codex app-server

Treat as the conformance gold standard for:

- identity;
- typed events;
- steering;
- interruption;
- approval/input request handling;
- reconciliation;
- structured completion.

### 16.5 ACP/acpx

Treat as the portability lane and an abstraction test, not the definition of every possible UI capability.

### 16.6 Pi, OpenCode, Claude SDK, and Hermes

These illustrate future driver patterns:

- in-process SDK driver;
- local JSONL/RPC driver;
- local server driver;
- run API with streamed events.

Do not require all of them in the first spike.

---

## 17. Skillless task envelope

### 17.1 What the model receives

The initial turn contains a compact, task-focused envelope:

```ts
interface NativeTaskEnvelope {
  task: {
    id: string;
    identifier?: string;
    title: string;
    objective: string;
    acceptanceCriteria?: string[];
  };

  context: {
    description?: string;
    relevantComments?: Array<{
      author: string;
      body: string;
      createdAt: string;
    }>;
    documents?: Array<{
      title: string;
      pathOrRef: string;
      summary?: string;
    }>;
    goalAncestry?: Array<{
      id: string;
      title: string;
    }>;
  };

  workspace: {
    cwd: string;
    writeRoots: string[];
    repository?: {
      branch?: string;
      baseRef?: string;
    };
  };

  execution: {
    runId: string;              // opaque correlation only
    deadline?: string;
    verificationExpected: boolean;
  };

  completion: {
    mode: "structured_output" | "semantic_tool";
    schemaName: "paperclip.run_result.v1";
  };
}
```

The model does not receive:

- Paperclip API URL;
- Paperclip JWT;
- checkout instructions;
- heartbeat instructions;
- status transition rules;
- retry or idempotency mechanics;
- organization-wide permissions.

### 17.2 Domain instructions

Project-specific `AGENTS.md`, repository instructions, or task-domain skills may still be loaded. Removing the Paperclip skill does not mean removing all useful instructions.

### 17.3 Minimal semantic tools

```ts
paperclip.finish({
  disposition: "done" | "needs_review" | "yielded",
  summary: string,
  evidence?: Evidence[],
  verification?: VerificationResult[],
  artifacts?: ArtifactRef[],
  nextActions?: string[]
})
```

```ts
paperclip.block({
  summary: string,
  blocker: {
    reason: string,
    needs?: string,
    evidence?: Evidence[]
  }
})
```

```ts
paperclip.ask({
  question: string,
  choices?: Array<{ key: string; label: string }>,
  blocking: boolean
})
```

The tools are implemented by the runner or harness client and translated into typed events. They do not directly mutate issue state.

---

## 18. Structured result and terminal semantics

### 18.1 Result schema

```ts
interface StructuredRunResult {
  schema: "paperclip.run_result.v1";

  disposition:
    | "done"
    | "blocked"
    | "needs_review"
    | "yielded";

  summary: string;

  evidence?: Array<{
    kind:
      | "test"
      | "artifact"
      | "diff"
      | "observation"
      | "external_check";
    description: string;
    status?: "passed" | "failed" | "unknown";
    ref?: string;
  }>;

  verification?: Array<{
    commandOrCheck: string;
    status: "passed" | "failed" | "not_run";
    detail?: string;
    artifactRef?: string;
  }>;

  blocker?: {
    reason: string;
    needs?: string;
    ownerHint?: string;
  };

  artifacts?: Array<{
    kind: string;
    ref: string;
    title?: string;
  }>;

  nextActions?: string[];
}
```

### 18.2 Validation

The control plane validates:

- schema version;
- disposition;
- size limits;
- artifact ownership;
- run/session binding;
- whether blocker is present when blocked;
- whether verification evidence is required by policy;
- whether issue transition is legal.

Invalid result:

- emit `run.result.rejected`;
- allow a bounded correction turn when policy permits;
- otherwise finish `needs_review`.

### 18.3 Mapping to Paperclip

The native runtime returns the structured result to the finalization pipeline. Native mode requires the additive finalizer contract in section 18.4; it must not pass a native result through the legacy exit-code-only decision path.

The finalizer:

- records run summary;
- records usage and cost;
- creates or promotes work products;
- creates one compact durable final comment or handoff;
- applies the existing legal issue transition;
- releases checkout/lock according to policy;
- finalizes workspace and environment.

### 18.4 Complete terminal conversion contract

The three vocabularies describe different layers. They are not independent outcome sets:

- `StructuredRunResult.disposition` is the accepted work disposition produced by the model or semantic tool;
- `NativeExecutionResult.terminalState` is the native runtime lifecycle result;
- `AdapterExecutionResult` is the legacy heartbeat compatibility record.

`AdapterExecutionResult` needs one additive, typed discriminator before native mode can ship:

```ts
interface NativeFinalizationResult {
  schema: "paperclip.native-finalization.v1";
  terminalState: NativeExecutionResult["terminalState"];
  disposition: NativeExecutionResult["disposition"];
}

interface AdapterExecutionResult {
  // Existing fields stay unchanged.
  nativeFinalization?: NativeFinalizationResult;
}
```

Legacy adapters omit `nativeFinalization` and keep the current exit-code heuristic. Native adapters must set it. The heartbeat finalizer must validate it against `resultJson`, select the run outcome and issue action from it, and only then use the compatibility fields for process diagnostics. `errorCode`, a null exit code, or a zero exit code is not a native disposition signal.

The native finalizer must use this table:

| Native disposition | Native terminal state | `AdapterExecutionResult` compatibility fields | Finalizer action |
|---|---|---|---|
| `done` | `completed` | `nativeFinalization` carries both values; `exitCode: 0`, `timedOut: false`, no error; structured result in `resultJson` | Persist the run as `succeeded`, then apply the legal `done` issue transition. |
| `blocked` | `completed` | `nativeFinalization` carries both values; `exitCode: 0`, `timedOut: false`, no error; structured result and blocker in `resultJson` | Persist the run as `succeeded`. Apply `blocked` only when the blocker payload and unblock owner/action are valid. Otherwise convert to `needs_review`. |
| `needs_review` | `completed` | `nativeFinalization` carries both values; `exitCode: 0`, `timedOut: false`, no error; structured result in `resultJson` | Persist the run as `succeeded`. Create or bind a real reviewer, approval, interaction, or monitor path, then apply `in_review`. If no review path can be created, keep the issue `in_progress` and record a finalization error. |
| `yielded` | `completed` | `nativeFinalization` carries both values; `exitCode: 0`, `timedOut: false`, no error; structured result in `resultJson` | Persist the run as `succeeded`. Keep the issue `in_progress` and enqueue the declared continuation or delegated follow-up. If no live continuation can be scheduled, convert to `needs_review`. |
| `failed` | `failed` | `nativeFinalization` carries both values; nonzero driver exit code when available, otherwise `exitCode: 1`; set `errorMessage`, `errorCode`, and error metadata; include the failure disposition in `resultJson` | Persist the run as `failed` and apply the existing retry and recovery policy. Do not directly change the issue to a terminal status. |
| `cancelled` | `cancelled` | `nativeFinalization` carries both values; `exitCode: null`, `timedOut: false`, optional cancellation diagnostics in `errorCode` and `resultJson` | Persist the run as `cancelled` from `nativeFinalization`, without relying on `errorCode` or the null-exit fallback. Change the issue to `cancelled` only when the cancellation scope explicitly includes the issue; otherwise leave the issue unchanged. |

All compatibility results set `signal: null` unless the harness reported a real signal. They preserve usage, cost, session, provider, model, billing, and runtime-service fields without changing their meaning. `resultJson` always contains `schema`, `disposition`, `summary`, and the validated structured result when one exists.

`failed` and `cancelled` are runtime-owned dispositions, so the model-facing `StructuredRunResult` and semantic tools do not accept them. The runtime constructs them from an explicit driver, policy, timeout, interrupt, or cancellation event. `done`, `blocked`, `needs_review`, and `yielded` require a valid `StructuredRunResult`; they all produce a successful process exit, but `nativeFinalization.disposition` preserves their distinct issue and continuation behavior.

Native-mode enablement is gated on finalizer conformance tests for all six rows. Each test must prove the persisted heartbeat run status, issue status, continuation/review side effect, and cancellation scope. A native adapter result without a valid `nativeFinalization` object is rejected as `native_finalization_missing`; it never falls back to the legacy success heuristic.

It does not create an issue comment for every tool call or token delta.

---

## 19. Sandbox and provider integration

### 19.1 Outbound connection rule

Every supported provider must allow the runner to establish outbound HTTPS/WSS. No inbound public port is required for the native runtime.

This accommodates:

- cold ephemeral sandboxes;
- persistent VMs;
- private provider networks;
- providers with awkward port-exposure APIs.

### 19.2 Bootstrap sequence

Preferred production flow:

1. Runner binary is baked into the image, snapshot, or VM template.
2. Paperclip starts the sandbox with a short-lived one-time bootstrap ticket.
3. Runner dials the control plane.
4. Ticket is exchanged for a runner connection lease.
5. Runner lease is bound to:
   - company;
   - environment lease;
   - runner instance;
   - runner digest;
   - expiry;
   - allowed native profile;
   - optional source IP/provider claim.
6. Child harness processes do not inherit this credential.
7. Lease is rotated over the authenticated channel.
8. Lease revocation drains or terminates the runner.

For development, Paperclip may copy or install the binary through the existing execution target. Production must avoid downloading and installing it on every run.

### 19.3 Warm tiers

Record one of:

| Tier | State |
|---|---|
| C0 | Cold sandbox, cold runner, cold harness, no session. |
| W1 | Warm sandbox and runner, cold harness. |
| W2 | Warm runner and harness, no resumed agent session. |
| W3 | Warm runner, harness, and resumable agent session. |

The UI and metrics show the tier. Performance comparisons must not mix tiers.

### 19.4 Daytona

Desired operational pattern:

- snapshot contains runner and harness binaries;
- provider launches sandbox;
- runner auto-starts and dials outbound;
- workspace and runner state directories are on persistent storage when session reuse is desired;
- snapshots never contain live runner tokens;
- sandbox stop/sleep is treated separately from session closure.

### 19.5 exe.dev

Desired operational pattern:

- `paperclip-runnerd` installed as a systemd unit;
- root-owned configuration directory;
- persistent disk for runner state and workspaces;
- control plane can wake/start the VM through existing provider infrastructure;
- runner reconnects automatically after boot;
- VM-level SSH remains an operator/debug path, not the primary protocol.

### 19.6 Provider adapter contract additions

The existing provider-neutral execution target should gain or expose operations sufficient for:

```ts
interface NativeRunnerBootstrapTarget {
  ensureAsset(input: {
    source: RunnerArtifact;
    destination: string;
    mode: number;
  }): Promise<void>;

  ensureService(input: {
    serviceId: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    restartPolicy: "never" | "on_failure" | "always";
  }): Promise<ServiceHandle>;

  signalService?(handle: ServiceHandle, signal: string): Promise<void>;

  inspectService(handle: ServiceHandle): Promise<ServiceStatus>;
}
```

For the spike, this can be implemented using the existing command runner without formalizing every method. The long-term interface should avoid provider-specific code in native runtime orchestration.

---

## 20. Security model

### 20.1 Trust boundaries

```text
Control plane: trusted organizational authority
Runner: trusted Paperclip runtime component
Harness/model process: untrusted workload
Repository/task content: potentially adversarial
External tools/content: potentially adversarial
```

### 20.2 Credential rules

- Runner connection credential never enters harness environment.
- Model never receives a Paperclip API credential.
- Provider-management API keys stay in the control plane.
- Model-provider credentials should be short-lived, proxy-injected, or narrowly scoped where possible.
- Tool credentials should be resolved at a policy boundary rather than preloaded broadly.
- Artifact upload uses run-scoped presigned capabilities.
- Secrets are redacted in logs and events before persistence.
- A runner can only act on its bound environment lease and commands.
- A semantic tool can only report against its current run.

### 20.3 Permission separation

Runtime request:

> May this harness execute command X, edit path Y, or access resource Z?

Paperclip governance approval:

> May this company exceed a budget, deploy, publish, hire, or perform another organizational action?

They must use different:

- database records;
- APIs;
- UI cards;
- policy evaluators;
- audit events.

### 20.4 Binary integrity

Production runner bootstrap checks:

- signed release manifest;
- SHA-256 digest;
- expected architecture;
- allowed version range;
- file ownership and permissions.

Runner advertises its digest in the handshake. Paperclip rejects an unapproved digest.

### 20.5 Filesystem constraints

Runner validates:

- `cwd` exists;
- `cwd` is inside the realized workspace or allowed roots;
- requested write roots are not broader than policy;
- symlink traversal does not escape allowed roots;
- child environment does not contain runner tokens;
- artifact paths are normalized and bounded.

### 20.6 Network

Minimum:

- TLS;
- outbound WSS;
- run/lease-scoped authentication;
- frame size limits;
- request rate limits;
- egress policy inherited from sandbox provider or environment configuration.

Optional later:

- mTLS runner identity;
- provider-attested runner claims;
- egress credential proxy modeled after Centaur's boundary.

---

## 21. Persistence and database changes

### 21.1 Event reliability problem to fix

A reconnectable remote runner cannot rely on `MAX(seq) + 1` allocation or merely an index on `(run_id, seq)`. Concurrent server events, replayed runner events, and lost ACKs can produce duplicates or sequence races.

### 21.2 Extend heartbeat runs

Proposed fields:

```sql
ALTER TABLE heartbeat_runs
  ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN runner_instance_id UUID,
  ADD COLUMN native_session_id UUID,
  ADD COLUMN driver_kind TEXT,
  ADD COLUMN driver_version TEXT,
  ADD COLUMN next_event_seq BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN native_phase TEXT,
  ADD COLUMN native_phase_updated_at TIMESTAMPTZ;
```

Backfill `next_event_seq` from existing events before enabling unique sequencing.

### 21.3 Extend heartbeat run events

```sql
ALTER TABLE heartbeat_run_events
  ADD COLUMN source_event_id TEXT,
  ADD COLUMN source_kind TEXT,
  ADD COLUMN source_instance_id TEXT,
  ADD COLUMN source_seq BIGINT,
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN session_id TEXT,
  ADD COLUMN turn_id TEXT,
  ADD COLUMN item_id TEXT,
  ADD COLUMN priority SMALLINT NOT NULL DEFAULT 1;
```

Indexes:

```sql
CREATE UNIQUE INDEX heartbeat_run_events_run_seq_uq
  ON heartbeat_run_events(run_id, seq);

CREATE UNIQUE INDEX heartbeat_run_events_source_event_uq
  ON heartbeat_run_events(run_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE UNIQUE INDEX heartbeat_run_events_source_seq_uq
  ON heartbeat_run_events(source_instance_id, source_seq)
  WHERE source_instance_id IS NOT NULL
    AND source_seq IS NOT NULL;

CREATE INDEX heartbeat_run_events_run_item_idx
  ON heartbeat_run_events(run_id, item_id)
  WHERE item_id IS NOT NULL;
```

### 21.4 Transactional sequence allocation

Allocate a canonical run sequence only after deduplication, in the same transaction as insertion. Lock the owning run row first so concurrent ingestion for one run is serialized.

For one event:

```sql
BEGIN;

SELECT next_event_seq
FROM heartbeat_runs
WHERE id = $1
FOR UPDATE;

SELECT seq
FROM heartbeat_run_events
WHERE run_id = $1
  AND source_event_id = $2;

-- If the source event exists, COMMIT and return its canonical seq.
-- Do not update next_event_seq and do not insert another event.

WITH allocated AS (
  UPDATE heartbeat_runs
  SET next_event_seq = next_event_seq + 1
  WHERE id = $1
  RETURNING next_event_seq - 1 AS seq
)
INSERT INTO heartbeat_run_events (..., seq, source_event_id, ...)
SELECT ..., allocated.seq, $2, ...
FROM allocated
RETURNING seq;

COMMIT;
```

Under PostgreSQL `READ COMMITTED`, the statement after the row lock gets a new snapshot. A transaction that waited for another ingestor therefore sees the committed source event before it allocates a sequence. The unique source-event index remains a safety constraint; an unexpected conflict rolls back the transaction instead of discarding an already allocated sequence.

For batches, acquire the same run-row lock, remove source events that are already persisted, preserve the source order of the remaining unique events, and then reserve exactly that count of contiguous values. An empty deduplicated batch reserves no values. Duplicate replay returns the previously committed canonical sequences in the ACK.

A source event and canonical sequence are different:

- `source_seq` orders events produced by one runner;
- canonical `seq` orders all persisted events for one Paperclip run, including server-originated events.

### 21.5 Runner tables

```sql
CREATE TABLE runner_instances (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  environment_lease_id UUID,
  expected_run_id UUID,
  version TEXT,
  digest TEXT,
  provider TEXT,
  platform JSONB,
  capabilities JSONB,
  state TEXT NOT NULL,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  connection_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
```

```sql
CREATE TABLE runner_commands (
  id UUID PRIMARY KEY,
  runner_instance_id UUID NOT NULL,
  run_id UUID,
  controller_seq BIGINT NOT NULL,
  command_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  UNIQUE(runner_instance_id, controller_seq)
);
```

```sql
CREATE TABLE native_runtime_requests (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  run_id UUID NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  driver_request_id TEXT NOT NULL,
  request_type TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL,
  resolution JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  UNIQUE(run_id, driver_request_id)
);
```

### 21.6 Session table

Extend or normalize `agent_task_sessions` so it stores:

- normalized session ID;
- adapter/runtime mode;
- driver kind and version;
- protocol version;
- driver session parameters;
- provider session parameters;
- workspace identity and affinity;
- environment lease affinity;
- last reconciled time;
- resume status;
- capability snapshot;
- last run ID;
- last error.

Do not keep using one opaque `sessionParams` field as the only durable identity if native mode becomes first-class.

### 21.7 Item projection

For the spike, a snapshot can reconstruct completed items from events. If performance or complexity warrants, add:

```sql
CREATE TABLE heartbeat_run_items (
  run_id UUID NOT NULL,
  item_id TEXT NOT NULL,
  turn_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  content JSONB NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(run_id, item_id)
);
```

The projection must be rebuildable from the event log.

### 21.8 Retention

- Keep terminal result, completed item snapshots, artifact references, usage, and phase timings durably.
- Raw deltas can have a configurable shorter retention window.
- Do not emit organization activity-log records for every token delta.
- Promote consequential runtime facts into the business/event graph: run started, artifact created, verification passed, result accepted, cost incurred, blocker declared.

---

## 22. Server APIs

### 22.1 Runner endpoint

```text
GET /api/runtime/v1/connect
Upgrade: websocket
Authorization: Bearer <runner-bootstrap-or-lease-token>
```

### 22.2 Browser snapshot and replay

```text
GET /api/heartbeat-runs/:runId/native-snapshot
GET /api/heartbeat-runs/:runId/events?afterSeq=<n>&limit=<n>
```

Snapshot includes:

```ts
interface NativeRunSnapshot {
  run: NativeRunView;
  runner: RunnerView | null;
  session: NativeSessionView | null;
  turns: NativeTurnView[];
  items: NativeItemView[];
  requests: NativeRuntimeRequestView[];
  artifacts: ArtifactView[];
  capabilities: DriverCapabilities | null;
  lastSeq: number;
}
```

### 22.3 Control operations

```text
POST /api/heartbeat-runs/:runId/turns
POST /api/heartbeat-runs/:runId/steer
POST /api/heartbeat-runs/:runId/interrupt
POST /api/heartbeat-runs/:runId/interrupt-and-send
POST /api/heartbeat-runs/:runId/stop-turn
POST /api/heartbeat-runs/:runId/stop
POST /api/heartbeat-runs/:runId/runtime-requests/:requestId/resolve
```

These APIs:

- authorize the current board user;
- persist the command first;
- return a command ID and accepted state;
- do not block until the harness operation completes;
- expose command progress through events.

### 22.4 Human message durability

A steering message should reuse or integrate with Paperclip's current issue-comment queue semantics:

1. Persist the human comment/input first.
2. Bind it to run and command ID.
3. Deliver to the native session.
4. Mark delivery accepted or failed.
5. Render it once in the conversation timeline.

Tool events and command deltas are not issue comments.

---

## 23. Task-page Live Run Console

### 23.1 Integration strategy

Do not continue expanding all runtime behavior inline inside the large issue-detail page.

Mount a contained component:

```tsx
<NativeRunBoundary
  issueId={issue.id}
  runId={activeRun?.id}
  fallback={<LegacyIssueRunView ... />}
/>
```

Suggested UI files:

```text
ui/src/components/native-run/
  NativeRunBoundary.tsx
  NativeRunConsole.tsx
  RunConnectionBanner.tsx
  RunPhaseStrip.tsx
  LiveRunTimeline.tsx
  LiveRunComposer.tsx
  NativeRunInspectorDrawer.tsx
  items/
    AssistantMessageItem.tsx
    UserMessageItem.tsx
    PlanItem.tsx
    ToolItem.tsx
    CommandItem.tsx
    FileChangeItem.tsx
    DiffItem.tsx
    RuntimeRequestItem.tsx
    UsageItem.tsx
    ResultItem.tsx

ui/src/lib/native-run/
  reducer.ts
  snapshot.ts
  event-types.ts
  gap-recovery.ts
  optimistic-commands.ts
```

### 23.2 Data flow

1. Initial REST snapshot.
2. Existing Paperclip live-event subscription filtered by run.
3. Ordered reducer.
4. Gap detection.
5. REST replay.
6. Same reducer.
7. Polling only as a degraded fallback.

Healthy native mode must not rely on 3-second or 5-second run polling for live state.

### 23.3 Header

Show:

- agent;
- driver and model;
- sandbox/provider;
- cold/warm tier;
- run state;
- session state;
- connection health;
- elapsed time;
- cost/tokens;
- current phase;
- last event age.

### 23.4 Phase strip

Example:

```text
Checkout ✓  Sandbox 2.3s  Runner 84ms  Harness 190ms
Session 42ms  First response 1.4s
```

Clicking a phase opens diagnostics, not raw secrets.

### 23.5 Timeline behavior

- `item.started` inserts a stable card.
- `item.delta` updates the card.
- `item.completed` seals it.
- Plan is pinned or collapsible and reflects latest full snapshot.
- Command output streams in a bounded viewport and exposes full artifact/log on demand.
- File changes link into existing file viewer/diff surfaces.
- Approval and input cards remain actionable until resolved.
- Replayed events do not animate as if newly produced.
- Connection reconnection is shown as a small system marker, not a new agent message.
- Final result is visually distinct from the last assistant prose.

### 23.6 Composer behavior

States:

| Run state | Primary action |
|---|---|
| no active turn, session ready | Send |
| active turn, steer supported | Steer |
| active turn, steer unsupported | Interrupt & Send |
| awaiting input | Answer |
| disconnected within grace | Queue message |
| terminal | Start continuation/new run according to policy |

Controls:

- Send/Steer;
- Interrupt & Send;
- Stop Turn;
- Stop Run;
- Retry or Resume;
- keyboard shortcut for send;
- visible capability explanation when a control is unavailable.

### 23.7 Interrupt UX

There are four distinct actions:

1. **Steer:** add guidance to current turn.
2. **Interrupt:** stop current turn, preserve session.
3. **Interrupt & Send:** stop current turn and start a replacement turn in the same session.
4. **Stop Run:** terminate the Paperclip attempt and enter finalization.

Never label all four as “Stop.”

### 23.8 Inspector drawer

For developers/operators:

- runner identity/version/digest;
- connection ID and reconnect count;
- source and canonical sequence cursors;
- driver capabilities;
- normalized/driver/provider session IDs;
- raw sanitized driver event;
- process information;
- outbox size;
- phase timestamps;
- recent diagnostics;
- optional PTY/raw logs.

### 23.9 Exact UX acceptance checklist

1. A card appears within one rendered frame of `item.started`.
2. Message deltas update the same card.
3. No duplicate card after browser refresh.
4. A user can type while the agent is working.
5. Steering shows queued, accepted, and delivered states.
6. Interrupt shows command accepted before turn terminal.
7. A permission request is actionable without refreshing.
8. A plan update replaces the prior plan snapshot.
9. Command output is visible while the command runs.
10. File changes appear before the run completes when the driver emits them.
11. Reconnection does not erase or reorder items.
12. Terminal result is unambiguous.
13. Cold-start phase is visible separately from model latency.
14. Unsupported features are hidden or explained, not silently broken.
15. Legacy task runs continue to render through the current path.

---

## 24. Performance budgets and benchmark design

These are spike targets, not claims about current performance.

### 24.1 Runner targets

- warm runner process to authenticated connection:
  - p50 under 100 ms;
  - p95 under 300 ms;
  - excluding provider wake and WAN variability.
- idle runner RSS under 25 MiB.
- active runner overhead excluding harness under 50 MiB.
- compressed runner binary target under 25 MiB.
- no dependency on Node in the sandbox.

### 24.2 Interaction targets

- committed runner event to browser render, same region:
  - p95 under 250 ms;
  - excluding model generation time.
- interrupt click to durable command accepted:
  - p95 under 150 ms.
- durable command to runner dispatch:
  - p95 under 300 ms while connection is healthy.
- delta coalescing:
  - 20–40 ms default.

### 24.3 Reliability targets

- zero duplicate persisted source events in 100 forced reconnect trials;
- zero duplicate final status mutations in 100 lost-ACK trials;
- 100% of accepted turns receive a terminal state in fault tests;
- no silent provider-session replacement;
- no model process can read the runner credential;
- legacy adapter conformance remains unchanged.

### 24.4 Phase instrumentation

Record timestamps for:

```text
run requested
checkout committed
environment acquisition started
sandbox provider request sent
sandbox ready
runner process requested
runner connected
workspace ready
harness spawn
harness initialized
session ready
turn submitted
turn accepted
first item started
first text delta
first tool/command
last item
structured result
workspace finalization started
run terminal committed
```

Derived metrics:

- sandbox cold start;
- runner bootstrap;
- runner handshake;
- harness cold start;
- session start/resume;
- model time to first event;
- first tool latency;
- event transport latency;
- interrupt dispatch;
- finalization duration;
- total cost by phase/provider/model.

### 24.5 Comparison matrix

Run the same repository, task, model, and sandbox image through:

```text
A. Existing Paperclip CLI adapter + Paperclip skill
B. Existing Paperclip ACPX mode
C. Native runner + ACP/acpx driver, no Paperclip skill
D. Native runner + direct Codex app-server, no Paperclip skill
E. Codex TUI inside the same environment as a qualitative/control baseline
```

For each warm tier, record:

- task success;
- verification success;
- prompt/tool-schema tokens;
- first-event latency;
- first-tool latency;
- interrupt latency;
- event fidelity;
- session-resume success;
- duplicate/replay defects;
- runner and harness RSS;
- human intervention;
- total cost.

Do not mix cold and warm runs in one latency distribution.

---

## 25. Observability and business provenance

Native runtime events should become high-quality operational provenance for Paperclip's broader company model.

### 25.1 OpenTelemetry spans

Suggested trace:

```text
paperclip.run
  environment.acquire
  sandbox.provision
  runner.bootstrap
  runner.connect
  workspace.realize
  harness.start
  session.open
  turn.execute
    item.tool
    item.command
    item.file_change
  result.validate
  workspace.finalize
  issue.transition
```

Propagate trace context through PRP and into runner logs. Do not expose it to the model unless needed for a task-domain tool.

### 25.2 Operational versus business events

Operational events:

- token deltas;
- process output;
- reconnect diagnostics;
- phase changes.

Business-relevant facts:

- task attempt started;
- cost incurred;
- artifact produced;
- test passed/failed;
- blocker declared;
- structured result accepted;
- issue status changed;
- human intervention required.

Only the latter should feed broad company activity/equation views by default.

### 25.3 Outputs versus outcomes

The runtime can prove:

- files changed;
- tests run;
- artifact produced;
- deployment invoked;
- tokens/cost spent.

It usually cannot prove the downstream business outcome by itself.

Preserve this distinction in result evidence and future metric attribution.

---

## 26. Failure and recovery matrix

| Failure | Required behavior |
|---|---|
| Browser disconnect | Agent continues; browser reloads snapshot and events after cursor. |
| Browser live-event socket reconnect | Gap-detect and replay through same reducer. |
| Control plane process restart | Runner spools; reconnects; server reloads commands/cursors; deduplicates replay. |
| Runner WebSocket transient loss | Harness continues within grace policy; runner buffers events. |
| Runner process crash | Supervisor/provider restarts if configured; runner reconciles harness/session or run becomes recoverable failure. |
| Harness process crash | Emit harness exit; attempt exact session recovery if supported; otherwise explicit failure. |
| Sandbox destroyed | Run becomes environment-lost; retain event trail; apply retry policy as a new attempt. |
| Duplicate command | Return previously persisted command result; no repeated side effect. |
| Event committed, ACK lost | Runner replays; unique source event ID deduplicates; ACK advances. |
| Events arrive out of order | Buffer within bounded window or reject/reconnect; never apply canonical UI sequence out of order. |
| Event gap cannot be filled | Mark run stream degraded; request driver snapshot; do not invent events. |
| Approval while disconnected | Persist request; UI can resolve; command delivers after reconnect unless expired. |
| Interrupt races with completion | First terminal state committed wins; other operation returns `already_terminal`. |
| Driver lacks steer | UI offers interrupt-and-send, not fake steer. |
| Driver cannot resume session | Explicit `session_lost`; policy chooses needs-review or new Paperclip attempt. |
| Outbox exceeds limit | Coalesce P2; reject new turns; preserve P0; expose backpressure. |
| Bad runner digest/version | Reject connection and fail bootstrap visibly. |
| Expired runner credential | Re-authenticate through lease flow or drain; never pass token to harness. |
| Workspace path invalid | Reject `run.prepare` before harness launch. |
| Structured result invalid | Reject result, optionally request correction, then needs-review. |
| Process exits zero without result | Needs-review/yielded, not done. |
| Model calls Paperclip tool twice | Tool call is idempotent by item/call ID; result applied once. |
| Control plane cannot finalize workspace | Run remains finalizing/recovery-required; do not report clean success. |
| Paperclip issue transition rejected | Preserve run result, show finalization error, and use existing recovery path. |

---

## 27. Testing and conformance

### 27.1 Fake deterministic driver

Build a scriptable fake driver before Codex integration.

Example scenario:

```yaml
capabilities:
  steer: true
  interrupt: true
events:
  - after_ms: 10
    type: item.started
    item: { kind: assistant_message, id: msg-1 }
  - after_ms: 20
    type: item.delta
    item_id: msg-1
    text: "Inspecting"
  - await_command: turn.steer
  - emit: item.completed
  - emit: run.result.proposed
```

This makes protocol, UI, and reconnection tests deterministic and inexpensive.

### 27.2 Driver conformance suite

Every driver must pass:

1. create session;
2. report stable IDs;
3. start turn;
4. emit ordered typed events;
5. terminalize accepted turn;
6. interrupt or explicitly advertise unsupported;
7. steer or explicitly advertise unsupported;
8. permission request or advertise unsupported;
9. snapshot;
10. recover or explicitly report non-resumable;
11. close;
12. process exit mapping;
13. structured result behavior;
14. duplicate command idempotency.

### 27.3 Protocol tests

- schema compatibility;
- handshake version negotiation;
- duplicate hello/reconnect;
- command idempotency;
- source sequence gap;
- source event duplicate;
- canonical sequence allocation under concurrency;
- ACK loss;
- partial batch commit;
- frame size rejection;
- backpressure;
- clock skew;
- token expiry and rotation.

### 27.4 Fault injection

Automated tests kill or disconnect:

- browser connection;
- live-event server;
- control-plane process;
- runner transport;
- runner process;
- harness process;
- sandbox;
- database transaction after insert but before ACK;
- artifact upload.

Run at deterministic points:

- before turn accepted;
- during first message delta;
- during command output;
- while awaiting permission;
- after structured result but before finalization;
- during workspace finalization.

### 27.5 Security tests

- child process environment inspection confirms no runner token;
- path traversal and symlink escape;
- malicious event payload length;
- secret redaction;
- forged run ID;
- reused bootstrap ticket;
- runner digest mismatch;
- cross-company runner binding;
- runtime request cannot resolve a governance approval;
- semantic tool cannot mutate another run.

### 27.6 UI tests

- initial snapshot;
- live event;
- replay gap;
- duplicate event;
- item delta/completion;
- reconnect marker;
- steering optimistic state;
- interrupt race;
- permission resolution;
- legacy fallback;
- accessibility and keyboard operation.

### 27.7 Extension-point and standalone tests

- inject an authenticated remote MCP server binding through a capable fake driver;
- inject a Paperclip MCP proxy binding without exposing its long-term credential to the harness;
- reject an MCP binding when the driver lacks the required capability;
- prove that PRP carries binding configuration and canonical tool events, not general MCP traffic;
- drive start, steer, interrupt, permission resolution, stop, replay, and reconnect through the standalone browser page and mock control plane;
- run the same fixtures and reducer assertions in standalone and production-integration tests;
- preserve channel, run, session, and turn identity across a simulated voice interrupt;
- keep transient media frames off the canonical event log while persisting transcript and consent metadata;
- run the fake remote backend through session, turn, event, request, result, deduplication, and recovery conformance;
- report unsupported remote-backend capabilities without presenting non-functional UI controls;
- compare cold start, warm start, command acknowledgement, first event, replay, and terminalization without full Paperclip startup cost.

---

## 28. Rollout and compatibility

### 28.1 Feature flags

```text
native_runner_enabled
native_runner_codex_app_server_enabled
native_runner_acp_enabled
native_run_ui_enabled
native_runner_remote_sandboxes_enabled
```

Enable per instance, company, agent, and run profile.

### 28.2 Compatibility modes

```text
legacy
  Existing adapter.execute and Paperclip skill behavior.

managed
  Existing process adapter with small semantic tools and host-owned lifecycle.

native
  PRP runner, typed session driver, no Paperclip skill.
```

### 28.3 Rollout gates

1. Fake driver local loopback.
2. Direct Codex local execution target.
3. Direct Codex in one cold sandbox provider.
4. UI steering/interrupt.
5. Reconnect/replay fault suite.
6. Second provider.
7. ACP/acpx driver.
8. Warm runner.
9. Warm harness/session.
10. Additional drivers.

### 28.4 Kill switch

The control plane can:

- stop dispatching new native runs;
- drain runners;
- fall back new attempts to the legacy adapter;
- leave active native runs visible and recoverable.

Never change an active run from native to legacy mid-session.

---

## 29. Proposed work breakdown

The issue identifiers below are placeholders. Each issue is intended to be assignable to a Paperclip worker with a narrow contract.

### NR-001 — Native runtime protocol package

**Goal:** Define PRP v1 schemas, identities, commands, events, results, capabilities, and test vectors.

**Primary files:**

```text
packages/native-runtime-protocol/
```

**Deliverables:**

- TypeScript types;
- JSON Schemas;
- sample envelopes;
- schema validation;
- protocol-version negotiation rules;
- fixture corpus for Rust and TypeScript;
- compatibility rules.

**Acceptance:**

- all examples validate;
- unknown optional fields are forward-compatible;
- unknown required command/event versions fail clearly;
- size limits are testable;
- event and command IDs are mandatory.

**Dependencies:** none.

---

### NR-002 — Database migrations and transactional event ingestor

**Goal:** Make native event ingestion durable, ordered, and idempotent.

**Primary files:**

```text
packages/db/src/schema/
server/src/services/native-runtime/native-event-ingestor.ts
```

**Deliverables:**

- migrations described in Section 21;
- atomic canonical sequence allocation;
- source-event unique constraints;
- batch insertion;
- ACK cursor return;
- replay query;
- concurrency tests.

**Acceptance:**

- 100 concurrent insert workers cannot produce duplicate `(run_id, seq)`;
- replay of the same source batch produces no duplicates;
- lost ACK replay is harmless;
- committed batch returns highest contiguous source cursor.

**Dependencies:** NR-001.

---

### NR-003 — Runner registry, authentication, and outbound WebSocket

**Goal:** Authenticate and manage runner connections independently of harness behavior.

**Primary files:**

```text
server/src/realtime/native-runner-ws.ts
server/src/services/native-runtime/runner-registry.ts
server/src/services/native-runtime/runner-auth-service.ts
runner/crates/runner-transport-ws/
```

**Deliverables:**

- bootstrap ticket;
- connection lease;
- hello/welcome;
- liveness;
- reconnect;
- runner state persistence;
- version/digest validation;
- drain/revoke.

**Acceptance:**

- runner connects using only outbound WSS;
- one-time ticket cannot be reused;
- reconnect preserves runner identity;
- unapproved digest is rejected;
- child process does not inherit connection secret.

**Dependencies:** NR-001, NR-002.

---

### NR-004 — Runner outbox, command dispatcher, and process supervisor

**Goal:** Make runner delivery and local process control crash-safe and idempotent.

**Primary files:**

```text
runner/crates/runner-core/
runner/crates/paperclip-runnerd/
```

**Deliverables:**

- local spool;
- cumulative ACK handling;
- processed-command cache;
- process groups;
- bounded logs;
- signal escalation;
- backpressure;
- diagnostic heartbeat.

**Acceptance:**

- restart runner with unacknowledged events and replay them;
- duplicate command produces one process effect;
- TERM/interrupt precedes KILL;
- outbox limit preserves P0 events;
- runner reports process exit separately from run result.

**Dependencies:** NR-001, NR-003.

---

### NR-005 — Fake driver and conformance kit

**Goal:** Decouple protocol/UI testing from real model calls.

**Primary files:**

```text
runner/crates/driver-api/
runner/crates/driver-fake/
packages/native-runtime-protocol/test-vectors/
```

**Deliverables:**

- driver trait;
- capability model;
- scripted fake;
- common conformance test suite;
- reconnect and interrupt scenarios.

**Acceptance:**

- can script every canonical event and runtime request;
- can force races and failures;
- all conformance assertions run without network/model dependencies.

**Dependencies:** NR-001, NR-004.

---

### NR-006 — Native Session Runtime integration in heartbeat orchestration

**Goal:** Add the feature-flagged native branch while preserving workspace finalization and extending run/issue finalization additively.

**Primary files:**

```text
server/src/services/native-runtime/native-session-runtime.ts
server/src/services/heartbeat.ts
server/src/services/environment-run-orchestrator.ts
```

**Deliverables:**

- runtime-mode resolver;
- runner expectation/bootstrap;
- `NativeSessionRuntime.execute`;
- terminal conversion to `AdapterExecutionResult`;
- typed `nativeFinalization` validation and six-row disposition handling;
- native finalizer conformance tests for run status, issue status, continuation/review effects, and cancellation scope;
- cancellation hook;
- no behavior change for legacy adapters.

**Acceptance:**

- fake driver run completes through native-aware run/issue finalization and existing workspace finalization;
- native run can be cancelled through existing board controls;
- a missing or invalid native finalization discriminator fails closed instead of using the legacy success heuristic;
- legacy integration tests are unchanged;
- no Paperclip skill materialization occurs in native mode.

**Dependencies:** NR-002 through NR-005.

---

### NR-007 — Direct Codex app-server driver

**Goal:** Implement the high-fidelity reference driver.

**Primary files:**

```text
runner/crates/driver-codex-app-server/
```

**Deliverables:**

- process startup;
- JSON-RPC client;
- thread create/resume/read;
- turn start/steer/interrupt;
- item mapping;
- approval/input mapping;
- usage mapping;
- session snapshot/reconciliation;
- structured completion.

**Acceptance:**

- passes driver conformance;
- no TUI/stdout parsing for canonical events;
- active turn can be interrupted without killing session;
- steering works where app-server reports support;
- session read/reconciliation survives runner transport reconnect;
- provider session ID remains stable.

**Dependencies:** NR-004, NR-005.

---

### NR-008 — Skillless task envelope and semantic completion

**Goal:** Remove Paperclip operational instructions from model context.

**Primary files:**

```text
server/src/services/native-runtime/native-task-envelope.ts
runner/crates/driver-codex-app-server/tools.rs
```

**Deliverables:**

- compact task envelope;
- `paperclip.finish`, `paperclip.block`, `paperclip.ask`;
- structured result validator;
- no Paperclip API credential in harness;
- model-context test.

**Acceptance:**

- native prompt contains no Paperclip REST routes or heartbeat manual;
- harness environment contains no runner or broad Paperclip credential;
- duplicate finish tool call applies once;
- exit zero without result becomes needs-review/yielded.

**Dependencies:** NR-006, NR-007.

---

### NR-009 — Task-page Live Run Console

**Goal:** Render snapshot plus ordered live/replayed events with Codex-like controls.

**Primary files:**

```text
ui/src/components/native-run/
ui/src/lib/native-run/
server/src/routes/native-runs.ts
```

**Deliverables:**

- snapshot/replay endpoints;
- native reducer;
- typed timeline;
- phase strip;
- connection health;
- composer;
- debug inspector;
- legacy fallback.

**Acceptance:**

- no healthy-state 3/5-second polling;
- duplicate replay does not duplicate items;
- gap recovery works;
- command/file/tool/plan events render live;
- task page remains usable with legacy run;
- composer remains active during turn.

**Dependencies:** NR-002, NR-005, NR-006.

---

### NR-010 — Steering, interruption, and runtime requests

**Goal:** Complete the bidirectional human-in-the-loop loop.

**Primary files:**

```text
server/src/services/native-runtime/runner-command-service.ts
server/src/services/native-runtime/native-runtime-request-service.ts
server/src/routes/native-runtime-requests.ts
ui/src/components/native-run/LiveRunComposer.tsx
```

**Deliverables:**

- durable commands;
- steer;
- interrupt;
- interrupt-and-send;
- stop turn;
- stop run;
- permission/input resolution;
- optimistic command UI;
- race handling.

**Acceptance:**

- every operation has command ID and eventual terminal command result;
- duplicate clicks do not duplicate effects;
- interrupt/completion race is deterministic;
- runtime permissions remain separate from governance approvals.

**Dependencies:** NR-003, NR-007, NR-009.

---

### NR-011 — Reconnect, replay, reconciliation, and chaos suite

**Goal:** Prove liveness and idempotency.

**Primary files:**

```text
server/src/services/native-runtime/native-run-recovery.ts
runner/crates/runner-core/
tests/native-runtime-chaos/
```

**Deliverables:**

- connection recovery;
- pending command replay;
- driver snapshot/reconciliation;
- control-plane restart test harness;
- lost-ACK tests;
- runner/harness kill tests;
- explicit session-lost behavior.

**Acceptance:**

- reliability targets in Section 24.3;
- live and replay use the same reducer;
- no silent new session;
- terminal state remains exactly once.

**Dependencies:** NR-002 through NR-010.

---

### NR-012 — ACP/acpx driver abstraction proof

**Goal:** Add a second harness path without changing northbound/UI contracts.

**Primary files:**

```text
runner/crates/driver-acp/
```

**Deliverables:**

- ACP session and prompt mapping;
- updates/events;
- permissions;
- cancel;
- resume where supported;
- capability mapping;
- acpx configuration/state management.

**Acceptance:**

- passes applicable conformance tests;
- task UI needs no ACP-specific branch for normal events;
- unsupported features degrade by capability;
- session identity is not conflated with Paperclip run.

**Dependencies:** NR-005, NR-011.

---

### NR-013 — Daytona and exe.dev provider conformance

**Goal:** Prove the outbound runner model across cold and persistent environments.

**Deliverables:**

- runner image/snapshot/bootstrap for Daytona;
- systemd or persistent service for exe.dev;
- workspace/state persistence behavior;
- cold/warm benchmark report;
- teardown and token revocation tests.

**Acceptance:**

- neither provider requires a public inbound runner port;
- cold run and warm run both complete;
- runner reconnects after environment restart where provider supports persistence;
- secrets are not baked into snapshots/images.

**Dependencies:** NR-003 through NR-011.

---

### NR-014 — Performance and build-vs-adopt comparison

**Goal:** Measure direct driver, ACPX, and sandbox-agent options.

**Deliverables:**

- comparison matrix from Section 24.5;
- runner RSS/binary/startup report;
- event fidelity matrix;
- recommendation recorded as an ADR;
- flamegraphs or traces for slow startup phases.

**Acceptance:**

- all comparisons use the same task/image/model/warm tier;
- sandbox and model latency are separated from runner overhead;
- architecture decision is based on measured data.

**Dependencies:** NR-007, NR-012, NR-013.

---

### NR-015 — Standalone workspace and extension-point conformance

**Goal:** Prove that runner development, MCP injection, channel/media boundaries, and remote backends can evolve without booting the full Paperclip product or changing the canonical session model.

**Primary files:**

```text
packages/paperclip-runner/
  protocol/
  fixtures/
  drivers/fake/
  backends/fake-remote/
  devtools/mock-control-plane/
  devtools/browser/
  examples/codex/
  examples/acp/
  benchmarks/
```

**Deliverables:**

- language-neutral schemas and fixture corpus;
- deterministic fake driver and fake remote backend;
- mock Paperclip control-plane harness;
- lightweight browser devtools/example page;
- MCP binding capability and injection fixtures;
- channel and media side-channel fixtures;
- direct Codex and ACP/acpx standalone examples;
- phase-level benchmark commands and reports.

**Acceptance:**

- standalone and production integration use the same protocol schemas, fixtures, and reducer behavior;
- replay and reconnect tests pass without the full Paperclip application;
- MCP credentials remain outside model-visible configuration;
- simulated voice interruption preserves normalized identities and durable audit events;
- the fake remote backend passes the common native-session conformance suite;
- benchmarks isolate runner and harness overhead from unrelated application startup.

**Dependencies:** NR-001, NR-004, NR-005; integrates with NR-007, NR-009, NR-010, and NR-012.

---

## 30. Suggested issue dependency graph

```text
NR-001 Protocol
  ├── NR-002 Event durability
  ├── NR-003 Runner connection
  └── NR-005 Driver API/fake
          |
NR-003 + NR-004 + NR-005
          |
       NR-006 Server integration
          |
       NR-007 Codex driver
          |
       NR-008 Skillless completion
          |
       NR-009 UI
          |
       NR-010 Bidirectional controls
          |
       NR-011 Chaos/recovery
          |
       ├── NR-012 ACP/acpx
       ├── NR-013 Providers
       ├── NR-014 Benchmarks/ADR
       └── NR-015 Standalone workspace/extensions
```

Parallelizable branches:

- NR-002, NR-003, and NR-005 after protocol;
- UI reducer against fake fixtures while Codex driver is built;
- provider bootstrap after runner handshake is stable;
- security tests alongside runner auth.
- standalone mock control plane and browser devtools after NR-001 fixtures stabilize;
- fake remote backend and channel/MCP conformance alongside the direct driver path.

---

## 31. Spike exit criteria

The spike is successful only if all of the following are demonstrated.

### Model/runtime boundary

- [ ] No Paperclip skill is loaded.
- [ ] No Paperclip API route manual is included in the prompt.
- [ ] No Paperclip or runner connection credential is available to the model/harness process.
- [ ] Task instructions remain sufficient to complete the work.
- [ ] Completion is structured.

### Control plane

- [ ] Checkout occurs before expensive sandbox/model execution.
- [ ] Existing budgets and workspace policy still apply.
- [ ] Existing workspace finalization still runs, and the additive native finalizer applies the legal issue transition for all six dispositions.
- [ ] Legacy adapters are unchanged.
- [ ] Runtime permission and governance approval are separate.
- [ ] Database state remains authoritative when the active producer disconnects.
- [ ] Runner and fake remote backends expose the same normalized session contract.
- [ ] Fleet remains a future projection and does not require a separate first-spike protocol.

### Sandbox/network

- [ ] Runner initiates outbound WSS.
- [ ] Cold sandbox can bootstrap.
- [ ] Warm runner can be reused.
- [ ] Runner reconnects after control-plane restart.
- [ ] No inbound sandbox port is required.

### Session

- [ ] Stable normalized, driver, and provider identities are stored separately.
- [ ] Turn events are typed.
- [ ] Steering is supported or explicitly degraded.
- [ ] Interruption preserves session.
- [ ] Accepted turns terminalize exactly once.
- [ ] No silent replacement session.
- [ ] Driver MCP capabilities are negotiated and resolved bindings are injected without exposing long-term credentials.
- [ ] Unsupported remote-backend capabilities degrade explicitly.

### UI

- [ ] Task page shows launch phases.
- [ ] Messages, tools, commands, file changes, plan, diff, usage, and requests stream live.
- [ ] Composer remains usable.
- [ ] Browser refresh reconstructs the same view.
- [ ] No duplicate items after replay.
- [ ] No healthy-state polling is required.
- [ ] Final result is unambiguous.
- [ ] The run subscription behaves as a logical per-run stream over a shared company connection.
- [ ] A simulated channel/voice interrupt uses the same durable command and event state.

### Reliability and performance

- [ ] Event sequence allocation is transactional.
- [ ] Source events are idempotent.
- [ ] Lost ACK does not duplicate state.
- [ ] Interrupt/completion race is deterministic.
- [ ] Startup phases and transport latency are measured.
- [ ] Direct Codex and ACPX paths can be compared fairly.
- [ ] Rust and TypeScript implementations pass the same language-neutral fixtures.
- [ ] Standalone mock-control-plane replay and reconnect tests pass.
- [ ] The lightweight browser devtools page exercises start, steer, interrupt, permission resolution, stop, replay, and reconnect.
- [ ] Fake remote-backend conformance passes.
- [ ] Transient media stays off the canonical event log while durable transcript and consent metadata remain recoverable.

---

## 32. Decisions that should not be reopened during the spike

Unless implementation evidence forces a change:

1. The runner dials outbound.
2. The browser never connects to the runner.
3. PRP is separate from ACP and app-server.
4. The runner is deterministic, not another agent.
5. Direct Codex app-server is the first reference driver.
6. ACP/acpx is the second abstraction-proof driver.
7. JSON over WSS is sufficient for v1.
8. Events are at-least-once with idempotent effects.
9. Process exit does not imply success.
10. Paperclip owns task state and governance.
11. The model receives no Paperclip operational skill in native mode.
12. Legacy execution remains available behind a feature flag.
13. The database is authoritative; connected producers are not the sole owners of session truth.
14. MCP policy and credentials remain in Paperclip core; PRP only carries resolved binding configuration and canonical events.
15. JSON Schema and fixtures are language-neutral protocol authority.
16. Hosted agent platforms use `NativeSessionBackend` rather than being modeled as fake sandboxes.
17. Transient media may use a side channel, but control, audit, transcript, and terminal state remain durable.
18. Fleet is a future control-plane projection, not a first-spike protocol feature.

---

## 33. Questions deliberately left for measured resolution

These are real design choices, but none blocks the initial vertical slice.

1. **Custom Codex driver versus Rivet sandbox-agent driver:** implement or benchmark both beneath the same driver API.
2. **Rust runner versus TypeScript runner:** production direction is Rust; use measurements to validate the cost. A TypeScript test/reference client is still useful.
3. **SQLite versus append-only file spool:** choose after fault and binary-size tests; protocol semantics do not depend on the storage engine.
4. **Structured output versus finish tool:** prefer structured output where first-class; retain semantic tool as cross-driver fallback.
5. **Warm harness/session retention duration:** base on measured cost, provider billing, and session-resume reliability.
6. **Completed item projection table:** add if event reconstruction is too expensive or complex.
7. **PTY support:** add as an inspector/fallback after typed Codex vertical slice.
8. **Binary encoding:** only after JSON frame and CPU profiles show it matters.
9. **Runner multiplexing:** protocol supports it; first implementation may restrict one active run.
10. **Long-lived runner identity on persistent VMs:** begin with environment-lease-scoped identity; evolve to device credentials if operationally valuable.

---

## 34. Copy/paste epic for Paperclip workers

> **Epic: Native Runner Mode / Skillless Codex Vertical Slice**
>
> Implement a feature-flagged native runtime path that lets a Paperclip task run through a deterministic daemon inside the realized sandbox rather than through the existing one-shot adapter contract. The daemon must initiate an outbound authenticated WebSocket to the Paperclip control plane, supervise Codex app-server locally over stdio, normalize its thread/turn/item events, persist unacknowledged events for replay, accept durable steer/interrupt/permission commands, and emit a structured terminal result.
>
> Preserve the existing environment-run orchestrator, execution workspace realization, issue checkout, budgets, governance, run records, workspace finalization, and legacy adapters. Branch after the execution target is realized. Internally use a session-oriented Native Session Runtime; at terminal completion convert the native result to the additive native-aware adapter-result boundary. Extend run/issue finalization to consume the typed native disposition, and retain the legacy exit-code heuristic only for adapters that omit that discriminator.
>
> Native mode must not materialize the Paperclip skill or expose a Paperclip/runner credential to the model process. The model receives a compact task envelope plus a structured completion schema or tiny run-scoped semantic completion tools.
>
> Add a dedicated Live Run Console to the task page using an initial snapshot plus an ordered, replayable event stream. Render typed assistant messages, plans, tools, commands, file changes/diffs, usage, runtime permission/input requests, phase timing, connection health, and terminal result. Keep the composer usable while the turn is active and support steer, interrupt, interrupt-and-send, stop turn, and stop run according to advertised driver capabilities. Do not depend on healthy-state multi-second polling.
>
> Event ingestion must be at-least-once and idempotent. Add stable source event IDs, transactional canonical per-run sequencing, unique constraints, cumulative ACKs, and a shared reducer for live and replay. Every accepted turn must terminalize exactly once. A lost session must be explicit; never silently create a fresh provider session and label it resumed. Process exit alone must never mark the task done.
>
> First prove the path with a deterministic fake driver, then direct Codex app-server, then an ACP/acpx driver without changing the control-plane protocol or task-page reducer. Exercise the path in a cold sandbox and a warm runner on Daytona and/or exe.dev through the existing provider-neutral environment layer. Instrument every launch phase and compare direct app-server, native ACPX, current ACPX, current legacy adapter, and Codex TUI baselines under the same model/repository/warm tier.
>
> The epic is complete only when the spike exit criteria in this specification pass, including no Paperclip skill, no model-visible control-plane credential, typed live events, quick steering/interruption, restart-safe replay with no duplicates, structured completion, legacy compatibility, and measured phase-level latency.

---

## 35. Final architectural test

The cleanest test of the design is this question:

> Could the same Paperclip run UI and control-plane state machine operate a direct Codex app-server session, an ACP/acpx session, and a fake deterministic session without knowing which harness produced the events?

If yes, the abstraction is correctly placed.

A second test is:

> Could the raw agent complete its repository task without knowing that Paperclip exists, while Paperclip still knows exactly what is running, can interrupt it, can ask or answer permissions, can recover its session, can account for its cost, and can apply a legal terminal task transition?

If yes, the Paperclip skill has been replaced by a real runtime contract rather than merely shortened.

---

## Appendix A — Recommended repository observations to verify before implementation

The spec was designed around these current Paperclip seams. Workers should re-open the current branch before editing because paths and types may move:

- `packages/adapter-utils/src/types.ts`
  - invocation-oriented `ServerAdapterModule.execute`;
  - opaque adapter session parameters;
  - execution-target and runtime callback fields;
  - ACP configuration and warm-handle fields;
  - flattened transcript entry types.
- `server/src/services/heartbeat.ts`
  - environment/workspace acquisition;
  - adapter invocation callbacks;
  - runtime progress/event append;
  - result, cost, workspace, and issue finalization.
- `server/src/services/environment-run-orchestrator.ts`
  - provider-neutral environment lease and execution target.
- `packages/adapter-utils/src/execution-target.ts`
  - local/SSH/sandbox execution target and callback bridge behavior.
- `packages/db/src/schema/heartbeat_run_events.ts`
  - current event sequence and indexes.
- `packages/db/src/schema/heartbeat_runs.ts`
  - run/session/process/result fields.
- `packages/db/src/schema/agent_task_sessions.ts`
  - task/session persistence.
- `ui/src/pages/IssueDetail.tsx`
  - active/live/linked run polling and current task timeline.
- `skills/paperclip/SKILL.md`
  - operational responsibilities to remove from native model context.

---

## Appendix B — Reference-system takeaways

- **Codex app-server:** reference typed session/turn/item contract and direct steer/interrupt path.
- **ACP:** portable local agent/client protocol with sessions, updates, permission requests, cancellation, and capability negotiation.
- **acpx:** useful ACP runtime/bridge; keep its state and lifecycle below Paperclip's runner protocol.
- **Centaur:** durable event cursor, isolated execution, and credential-safe egress.
- **Conductor OSS:** real PTY, worktree/diff surfaces, Rust runtime, and paired remote bridge.
- **Rivet sandbox-agent:** small static sandbox daemon and universal harness adapter; possible southbound implementation, not Paperclip's northbound authority.
- **Daytona:** outbound worker connection and snapshot/warm-sandbox pattern.
- **exe.dev:** persistent VM and system service pattern.
