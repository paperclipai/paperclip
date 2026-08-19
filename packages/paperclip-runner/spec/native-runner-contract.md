# Paperclip Native Runner Mode
## Minimal spike specification and production-compatible design

**Document status:** Canonical working draft<br>
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

Provider-managed services use the sibling path:

```text
Paperclip control plane and task UI
          |
          | NativeSessionBackend
          v
RemoteAgentBackend
          |
          | Contract B2: provider API / SDK / stream / webhook
          v
AWS AgentCore, Cursor Cloud Agents, or another managed service
```

A provider-side Paperclip gateway may speak PRP instead when the platform can host it. The normalized session contract stays the same in both paths.

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
11. **The durable control record is authoritative.** PostgreSQL owns normalized lifecycle, control, audit, result, and replay metadata; it does not need every token delta, terminal byte, audio frame, or large artifact body.
12. **MCP remains a separate tool plane.** Paperclip resolves run-scoped MCP bindings and the runner injects them through capable harness drivers; PRP does not tunnel general MCP traffic.
13. **Native sessions have pluggable backends.** The first backend uses `paperclip-runnerd`; hosted agent platforms can implement the same normalized contract without pretending to be Paperclip-managed sandboxes.
14. **Human-facing channel adapters terminate at Paperclip core.** Slack, email, voice, browser, webhook, and similar ingress must authenticate, authorize, bind, persist, and audit through Paperclip before normalized input reaches a runner or hosted backend.
15. **Durable control events and transient media use different paths.** Core-owned channel adapters consume the normalized event model, while low-latency audio or media can use an authenticated side channel bound to the same identities without bypassing Paperclip authority.
16. **Agent-reported dispositions are advisory inputs, not status mutations.** Paperclip validates evidence, blockers, reviewer paths, continuations, and transition legality before changing an issue status.
17. **Credential delivery has two explicit local modes plus provider-native binding.** Paperclip may materialize narrowly scoped environment values for compatibility, provision a short-lived broker/proxy session so the workload can call approved services without possessing long-term credentials, or bind identity/secrets through a managed runtime's control plane.
18. **The protocol is language-neutral and independently testable.** JSON Schema, fixtures, and conformance behavior are authoritative for Rust, TypeScript, and future implementations.
19. **MCP Apps are a negotiated interactive-UI extension, not generic tool text.** Paperclip preserves app resource declarations, capability negotiation, lifecycle, tool input/results, and auditable user actions so the browser can host supported apps in a sandbox without coupling PRP to iframe transport.
20. **Remote services have an explicit connector contract.** A managed runtime can either host a PRP-speaking Paperclip gateway or use a control-plane connector that implements the same normalized session semantics without running `paperclip-runnerd`.
21. **Normal provider operation is unattended until final human review.** After an operator supplies or approves the required provider account, workload identity, and secret/key bindings, Paperclip must create, invoke, observe, steer, reconcile, and clean up local and remote execution without dashboard clicks, SSH setup, copied commands, or other human runbook steps. This applies equally to Daytona, AWS AgentCore, Cursor, and future providers; infrastructure credentials enter through governed Paperclip bindings, not per-run manual intervention.

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

#### 2.1.1 Workspace compatibility contract

Native Runner Mode must consume the workspace that Paperclip realizes today; it must not introduce a second checkout, clone, upload, mount, or sync subsystem.

The compatibility boundary is the realized execution target plus its server-owned workspace-realization record. The native runtime receives, without reinterpretation:

- the environment lease and provider lease identity already acquired for the run;
- the realized working directory selected by the environment driver;
- `mode`, where `in_place` means the provider path is already authoritative and `copy` means Paperclip owns synchronization around execution;
- `authoritativeRoot`, which is the only default root from which the runner may launch the harness;
- `pathAliases`, which describe approved equivalent paths rather than new writable roots;
- `outboundRestorePaths`, which limit exceptional paths Paperclip may restore during finalization;
- the provider-neutral execution target and its existing command and native file-sync capabilities;
- referenced workspace hints already resolved by Paperclip, including the current limitation that remote realization synchronizes only the anchor workspace unless the provider contract explicitly adds referenced-source transfer.

The runner must treat those values as an immutable run-preparation input. It may validate that the paths exist inside its lease and may create runner-private state outside the project tree, but it must not change workspace mode, choose another checkout, infer a different sync direction, or make a provider-local path authoritative.

Paperclip remains responsible for all pre-run preparation and post-run finalization. For a copied sandbox workspace, Paperclip uploads or otherwise realizes the local workspace before native execution and synchronizes the allowed result set back afterward through the existing execution-target operations. For an in-place workspace, the runner operates directly at `authoritativeRoot` and Paperclip does not perform a redundant copy-back. A native run is not terminally successful until existing workspace finalization succeeds.

This contract intentionally supports the current local, SSH, sandbox, and plugin-backed realization paths. A provider may optimize transfer internally, but Native Runner Mode must observe the same realized files and produce the same finalized local workspace that the legacy adapter path would for the same lease and execution-workspace policy.

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
- MCP App views and their loading, ready, interaction, error, and teardown states;
- terminal result.

A raw terminal remains useful for debugging or harnesses with no typed protocol, but it is not the canonical model for the native path.

MCP App fidelity is more than displaying the text result of an MCP tool call. When the MCP Apps extension is negotiated, the host must preserve the tool-to-`ui://` resource association, fetch and validate the declared app resource, render supported HTML in a sandboxed iframe, exchange the extension's JSON-RPC messages over a controlled `postMessage` bridge, and deliver tool input/results and host-context updates to the same stable view. Text-only fallback remains available when the extension or MIME type is unsupported.

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
- artifact;
- MCP App resource and view instance.

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

When exact session resume is impossible, the run records an explicit recoverable failure. The status arbiter may route the issue to `in_review` only if it atomically creates a real review path. The system must not pretend that a fresh session is the same session.

### 3.6 Terminal clarity

The native protocol keeps four facts separate. No field is an alias for another:

| Fact | Values | Authority | Meaning |
|---|---|---|---|
| **Turn terminal state** | `completed`, `failed`, `interrupted`, `cancelled` | Harness driver, reconciled by the runner and control plane | How one accepted turn stopped. |
| **Run terminal state** | `succeeded`, `failed`, `cancelled` | Runner/finalizer | How the Paperclip execution attempt ended after runtime and workspace finalization. |
| **Reported work disposition** | `done`, `blocked`, `needs_review`, `yielded` | Agent/model or semantic tool | What the agent claims should happen to the assigned work. Advisory only. |
| **Authoritative issue status** | legal Paperclip issue status | Paperclip status arbiter | The organizational state committed to the issue. |

Every accepted turn terminalizes exactly once. Every run terminalizes exactly once, but only after required workspace finalization and result reconciliation. A completed turn and a succeeded run prove execution health; neither proves that the task objective or completion contract was satisfied.

The protocol therefore forbids these inferences:

- `turnTerminalState: "completed"` does not imply `reportedWorkDisposition: "done"`;
- `runTerminalState: "succeeded"` does not imply authoritative issue status `done`;
- `reportedWorkDisposition: "done"` does not grant authority to set issue status `done`;
- `blockingCurrentTurn: true` does not imply authoritative issue status `blocked`;
- process exit code, signal, timeout, or transport closure is runtime evidence only.

When the arbiter rejects or transforms the reported disposition, Paperclip preserves the original claim, criterion-level evidence, verification, artifacts, and remaining-work declaration. Reconciliation appends a new assessment or decision; it does not rewrite the agent report.

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
| **Turn terminal state** | The driver-observed terminal state of one accepted turn: `completed`, `failed`, `interrupted`, or `cancelled`. |
| **Run terminal state** | The finalizer-owned terminal state of one Paperclip attempt: `succeeded`, `failed`, or `cancelled`. It includes required runtime and workspace finalization. |
| **Reported work disposition** | The agent's advisory claim that work is `done`, `blocked`, `needs_review`, or `yielded`. |
| **Completion contract** | The versioned objective, acceptance, verification, artifact, approval, authority, and risk requirements used to assess completion. |
| **Attention request** | A typed request for capability, authority, information, or external action. It is not itself an issue status. |
| **Work assessment** | The durable normalization of runtime facts, agent claims, evidence, unresolved requirements, and live paths for one finalization attempt. |
| **Status decision** | The arbiter's durable authoritative issue transition or no-op, including authority, inputs, reason code, side effects, and supersession lineage. |
| **Runtime request** | A pending permission or elicitation request from the harness. |
| **Control-plane approval** | A Paperclip governance decision. It is not a runtime request. |
| **Artifact** | A durable file, diff, report, test result, URL, or other output referenced by the run. |
| **MCP App view** | A stable browser-hosted instance of a negotiated MCP `ui://` resource, linked to its run, session, turn, item, and tool call. |

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

There are three separate contracts. Contract B has local and remote profiles because a provider-managed service does not necessarily contain `paperclip-runnerd`.

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

#### Contract B1: Harness Driver API

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

#### Contract B2: Remote Provider Connector API

Between the Paperclip control plane and a provider-managed runtime or coding-agent service that Paperclip does not launch as a local harness.

Examples:

- AWS Bedrock AgentCore Runtime invoke, stream, session, and control APIs;
- Cursor Cloud Agents create, follow-up, status, conversation, webhook, and stop APIs;
- Devin, Jules, or GitHub Copilot cloud-agent task APIs;
- a Paperclip-managed gateway deployed inside a cloud runtime.

Every connector implements the same normalized session, turn, event, request, capability, result, and recovery semantics exposed by `NativeSessionBackend`. Provider-specific polling, webhooks, event IDs, SDK callbacks, and cancellation states remain behind the connector.

There are two valid adoption modes:

1. **Native PRP gateway.** When the remote platform can run Paperclip software, deploy a small provider-side gateway that speaks Contract A and adapts the provider locally. The control plane treats it as a remote runner connection, but environment ownership remains explicit.
2. **Control-plane connector.** When the provider exposes only a hosted API, implement Contract B2 in Paperclip core. The connector does not speak PRP on the wire, but it must preserve PRP-equivalent command intent, ordered/idempotent event ingestion, acknowledgements or provider cursors, liveness, capability advertisement, recovery, and terminal semantics.

Contract B2 is remote and replaceable. It must not assume local process supervision, filesystem access, a PTY, or Paperclip-owned sandbox controls. The UI exposes only capabilities the provider can actually enforce.

#### Contract C: Optional model-facing semantic tools

Only model judgments that cannot be inferred deterministically should be exposed:

```text
paperclip.finish
paperclip.block
paperclip.interact
paperclip.progress        # optional
```

`paperclip.interact` is one strict discriminated union over the five current
issue-thread interaction kinds. A provider that cannot register that union
faithfully may expose five generated presentation aliases, but every alias
normalizes into the same union before persistence. A model session sees the
canonical union or the aliases, never both. The legacy `paperclip.ask` surface
is deprecated and may translate only the lossless structured-question subset.

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
  ├── NativeInteractionBridgeService
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
  │     ├── McpAppItem
  │     └── ResultItem
  ├── LiveRunComposer
  ├── McpAppHost
  │     ├── UiResourceResolver
  │     ├── SandboxedAppFrame
  │     ├── AppBridge
  │     └── AppPermissionBoundary
  ├── RunArtifactPanel
  └── NativeRunInspectorDrawer
```

The browser subscription is a logical per-run stream. One company-scoped physical connection may carry many run topics, but every snapshot, cursor, command state, and event projection remains isolated by company and run identity.

`McpAppHost` is a Paperclip web capability, not code supplied by a harness driver. It advertises supported MCP Apps extension versions and MIME types, creates the sandboxed iframe, enforces resource CSP and permission policy, proxies only authorized app requests, and binds every app view to company, run, normalized session, turn, item, tool-call, and UI-resource identity.

### 5.5 Interaction channels and transient media

A channel adapter connects a human or external system to a normalized Paperclip session. Initial and future examples include the browser, voice gateways, Slack, Discord, email, webhooks, and CopilotKit-style channel adapters.

These adapters belong on the Paperclip core/web side of the native-session boundary, not inside `paperclip-runnerd`. They own external identity verification, company and user authorization, rate limits, channel-to-session routing, durable input acceptance, approval presentation, audit attribution, and replay. After those checks, they send normalized input through `NativeSessionRuntime` and consume the same durable event stream used by the browser.

No Slack bot, email handler, voice gateway, or provider-owned channel may send a control command directly to a runner or harness. That shortcut would bypass Paperclip's task state, governance, identity, and audit model. A hosted runtime such as Cloudflare Agents may supply useful channel primitives, but a Paperclip integration must terminate or federate those primitives through an authenticated core-owned gateway before they can affect a Paperclip session.

This ownership choice does not require slow polling. The core channel gateway may keep a company-scoped WebSocket, SSE, or provider callback connection, append accepted input once, and fan out normalized events through the live event infrastructure. Audio frames and other latency-sensitive transient media may use a separate authenticated media channel bound to the same company, user, run, session, and turn identities.

The database stores durable media metadata, transcripts, consent records, important markers, and artifact references. It does not need to store every audio frame as a normal run event. Paperclip remains authoritative for authorization, session binding, interruption, audit, and terminal state.

### 5.6 Credential provisioning and broker boundary

The existing design addresses secret ownership but does not yet define a complete runtime credential-delivery contract. Native mode needs an explicit `CredentialPlan` created by Paperclip core and materialized by the trusted environment/runner boundary. PRP carries only opaque references, policy, and short-lived capabilities; it never emits long-term secret values as normal commands or events.

```ts
interface CredentialPlan {
  schema: "paperclip.credential-plan.v1";
  bindings: Array<
    | {
        mode: "environment";
        bindingRef: string;
        targetName: string;
        exposure: "harness_process" | "approved_child_process";
      }
    | {
        mode: "http_broker";
        brokerSessionRef: string;
        proxyEnvRef: string;
        trustBundleRef?: string;
        allowedServiceIds: string[];
      }
    | {
        mode: "provider_native";
        providerBindingRef: string;
      }
  >;
}
```

The three modes have different boundaries:

1. **Environment materialization** is the compatibility path for CLIs and SDKs that require a real environment value. Paperclip resolves the versioned binding at launch, injects it only into the approved process scope, redacts it from logs/events, and does not persist it in PRP payloads or runner outboxes. This mode reduces accidental spread but does not protect a secret from a fully compromised harness process.
2. **HTTP credential brokering** is the preferred path for supported outbound APIs. Paperclip creates a short-lived, run-scoped broker session and supplies proxy settings, a broker capability, optional trust material, and placeholder values. The broker stays outside the untrusted workload, enforces destination/service policy, attaches the real credential on the wire, audits use, and can revoke access without rotating the underlying secret. This is the architectural pattern demonstrated by Infisical Agent Vault.
3. **Provider-native identity or secret binding** is used when AWS AgentCore, Google Vertex AI Agent Engine, Microsoft Foundry, Cloudflare, or another managed runtime owns process launch and network identity. Paperclip configures an opaque provider binding through the provider control plane and records provenance; it does not pretend the secret was injected by `paperclip-runnerd`.

The broker contract must declare supported protocols and failure behavior. An HTTP/HTTPS proxy does not automatically cover raw database protocols, SSH, custom sockets, certificate-pinned clients, clients that ignore proxy variables, or hostile code that can bypass the intended egress route. Strong mode therefore combines a separate broker host, short-lived session identity, destination allowlists, network egress enforcement, audit, and fail-closed launch when required proxy configuration cannot be established.

### 5.7 MCP injection boundary

MCP is separate from PRP and the harness driver protocol. Paperclip core owns the MCP gateway, catalog, authentication, authorization, policy, credentials, audit rules, and proxy behavior.

Paperclip passes resolved, run-scoped MCP bindings to the native session backend. A binding may reference an authenticated MCP server, a Paperclip-controlled MCP proxy, or an approved local MCP server definition. A capable local driver translates that binding into the harness-native form, such as a server URL, command configuration, environment reference, or session initialization field.

The runner may expose loopback transport or start an approved workspace-local MCP process when a harness requires it, but it does not become the authority for MCP permissions or long-term secrets. General MCP traffic must not be tunneled through PRP event messages.

MCP Apps uses the optional `io.modelcontextprotocol/ui` extension. Paperclip must negotiate support explicitly and advertise the MIME types its browser host can render. A tool's `_meta.ui.resourceUri` association, the referenced `ui://` resource, `text/html;profile=mcp-app` content, resource CSP, requested browser permissions, tool visibility, and app protocol version are typed data; they must not be discarded into an opaque log string.

The boundary is:

- the MCP server remains authoritative for tool definitions, UI resources, and tool results;
- Paperclip core remains authoritative for extension negotiation, resource authorization, audit, tool-call proxying, host capabilities, and durable run linkage;
- the browser `McpAppHost` remains authoritative for iframe sandboxing, `postMessage` origin/channel validation, CSP/permission enforcement, display mode, and view teardown;
- `paperclip-runnerd`, a harness driver, or a remote provider connector only reports normalized MCP App discovery and lifecycle data that it can observe; it does not render third-party HTML or grant browser capabilities.

The canonical run stream stores enough typed lifecycle and linkage data to reconstruct the app item after browser refresh. The high-volume iframe message stream does not automatically become durable PRP traffic. Paperclip durably records security- and workflow-relevant actions such as resource selection, initialization outcome, app-initiated tool calls, user-approved capability use, context-update requests, errors, and teardown. Ephemeral size, animation, and presentation messages may stay browser-local.

If a local harness or hosted provider already acts as an MCP Apps host, its connector must expose whether Paperclip receives the original UI resource and protocol messages, a provider-rendered surface, or only a text/structured fallback. Paperclip must never label a fallback as an interactive app. The preferred mode is host handoff: Paperclip receives the resource declaration and tool data and renders the app in its own browser boundary.

### 5.8 Standalone runner workspace

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
22. All five current issue-thread interaction kinds round-trip from a strict model request, through durable materialization and resolution, into a resumed skillless task envelope.

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
6. Workspace orchestration realizes the workspace and produces the server-owned realization record and provider-neutral execution target.
7. Paperclip creates a `runner_instance` expectation bound to the lease and run, then binds the immutable realized working directory, workspace mode, authoritative root, path aliases, and finalization policy to `run.prepare`.
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
13. The runner validates that the requested working directory is the realized `authoritativeRoot` or an approved alias inside the current lease, and validates resource constraints without cloning, mounting, or synchronizing another workspace.
14. The control plane sends `session.open` with the resolved driver configuration and MCP bindings.
15. The Codex driver starts `codex app-server` over local stdio.
16. The driver injects supported MCP bindings, initializes app-server, and creates or resumes a thread.
17. The runner emits `session.ready`.
18. The control plane sends `turn.start` with the task envelope.
19. The runner emits normalized typed events.
20. The control plane persists and ACKs events, then fans them out to the browser.
21. Human steering becomes a durable control-plane command and is delivered over the same runner connection.
22. The harness emits a structured result, invokes a completion tool, or invokes `paperclip.interact` with a strict request.
23. For an interaction, the runner validates the schema, binds the current company/issue/agent/run/session/turn/tool call, durably proposes it, and waits for the bridge's materialized-or-rejected receipt. The model never sends the runner credential or the host binding.
24. A non-blocking materialized interaction returns its durable reference and the turn continues. A blocking materialized interaction terminalizes the turn once as `completed` with reported disposition `yielded`; a rejected request leaves the turn open for correction.
25. The runner emits `run.result` for a terminal completion path. Interaction request, resolution, progress, and delivery events remain P0 durable events even when the current run has already terminalized.
26. The control plane finalizes the native session, converts the result to the additive native-aware adapter result shape, and runs native-aware run/issue finalization plus existing workspace finalization.
27. Paperclip applies issue status, handoff, cost, work-product, and interaction-continuation behavior through server-owned policy. Creating a blocking interaction does not directly set issue status.
28. When the interaction resolves, the control plane stores the normalized typed response, applies the effective continuation policy, and places the response in the next eligible skillless task envelope until its delivery cursor is acknowledged.
29. The resumed turn consumes that response without Paperclip API credentials. Replayed delivery is deduplicated by the stable interaction response identity.
30. The run and environment lease are released or retained according to warm policy.

### 7.2 Remote agent backend path

1. Paperclip validates the run and creates the same durable run/session records used by the runner backend.
2. `RemoteAgentBackend` opens or resumes the provider session through its connector.
3. The connector reports normalized capabilities and preserves provider event IDs.
4. Paperclip sends normalized turn and control commands through the backend.
5. The connector consumes streaming responses, WebSocket events, webhooks, polling results, or SDK callbacks and emits canonical events through the normal ingestor.
6. If the provider can host a Paperclip gateway, that gateway may use PRP directly; otherwise the control-plane connector preserves PRP-equivalent ordering, idempotency, liveness, recovery, and terminal semantics behind Contract B2.
7. MCP Apps capability reporting distinguishes Paperclip-hostable UI resources from provider-rendered or text-only fallbacks.
8. Unsupported steering, interruption, permissions, media, MCP, or MCP Apps behavior is explicit in capabilities and UI degradation.
9. Reconnect and recovery use the same durable snapshot, cursor, request, result, and terminal-state rules as the runner backend.

The first spike needs a fake remote backend that passes conformance tests. It does not need a production connector for every hosted platform.

#### 7.2.1 Initial hosted-provider targets

As of 2026-08-07, the first two qualification and implementation targets are explicit: AWS AgentCore first, then Cursor Cloud Agents. The remaining entries are later comparison targets. The list deliberately includes both general managed agent runtimes and opinionated coding-agent services because they exercise different parts of `NativeSessionBackend`:

| Order | Provider/platform | Documented runtime boundary | Invoke/observe/control surface | Initial disposition |
| --- | --- | --- | --- | --- |
| 0 | **AWS Bedrock AgentCore Runtime** | Provider-managed, versioned container runtime with isolated sessions, workload identity, network configuration, and separate control/data planes | `CreateAgentRuntime`/endpoint APIs; `InvokeAgentRuntime`; HTTP, SSE, persistent WebSocket, MCP, A2A, and AG-UI service contracts; asynchronous/long-running processing and session IDs | **Top qualification priority and preferred first managed-runtime connector.** Its explicit runtime contract, bidirectional streaming, identity, protocol, version, endpoint, and session boundaries are the strongest reference for shaping Paperclip's provider backend and credential model. |
| 1 | **Cursor Cloud Agents** | Opinionated provider-managed coding environment/session | `POST /v0/agents`; status and conversation reads; webhooks; follow-up and stop operations | **Second qualification target and preferred first coding-agent connector.** It exposes a session-shaped API, follow-ups, stop, status, conversation, and webhook configuration, making it the first test of the same normalized backend against an opinionated coding service. |
| 2 | **Cloudflare Agents** | Durable Object-backed agent instances with durable identity, local SQLite state, WebSockets, scheduling, queues, and recoverable fibers | Worker deployment plus `routeAgentRequest`; HTTP/SSE, WebSocket, callable methods, state sync, and application-defined control methods | **Later managed-runtime comparison target.** Excellent for real-time and durable execution experiments, but the connector must define a Paperclip-specific control API because the SDK is an application framework/runtime rather than a uniform hosted-task API. Its first-party Slack/email/voice/webhook support does not change the rule that Paperclip channel ingress remains core-owned. |
| 2 | **Google Vertex AI Agent Engine** | Managed runtime, exposed under the backwards-compatible `ReasoningEngine` resource, with deploy/scale, sessions, observability, and Google Cloud identity/security integration | deployed `query`, `stream_query`, custom operations, bidirectional streaming for supported agents, and session management APIs | **Later managed-runtime comparison target.** Useful for testing custom operation discovery, session reconciliation, streaming, provider-native Secret Manager bindings, and the distinction between a deployed runtime resource and a Paperclip run. |
| 2 | **Microsoft Agent Framework + Foundry Hosted Agents** | Agent Framework is a framework/hosting library; Foundry Hosted Agents is the Microsoft-managed container runtime that owns scale, session persistence, identity, and lifecycle | OpenAI-compatible `/responses`, generic `/invocations`, A2A, AG-UI, durable Azure Functions/self-hosted extensions, and Foundry-managed sessions | **Later managed-runtime comparison target, with the boundary kept explicit.** Self-hosted Agent Framework belongs under a local/provider driver; Foundry Hosted Agents belongs under `RemoteAgentBackend`. Do not treat the framework package itself as a cloud runtime. |
| 3 | **Devin v3** | Organization-scoped provider-managed coding session | create session; session detail; cursor-paginated messages with stable `event_id`; send message; terminate/archive/delete according to RBAC | **Later coding-agent comparison target** because it has explicit organization scoping, service-user RBAC, stable message event IDs, cursor pagination, and lifecycle controls. |
| 4 | **GitHub Copilot cloud agent tasks** | Repository task delegated to GitHub-managed execution | `POST /agents/repos/{owner}/{repo}/tasks` or issue assignment; list/get documented task states; no general follow-up/cancel primitive in the reviewed task API | **Output-oriented candidate**, not the reference interactive backend. It is useful for asynchronous issue-to-PR delegation but exposes less session control. |
| 4 | **Google Jules v1alpha** | Connected-source coding session in a provider-managed environment | create session; poll and page activities; approve plan; send message; pull-request output | **Conformance/experimental candidate** because the API is alpha and currently documents polling rather than push delivery or cancellation. |

The first production investigation and connector attempt should therefore be AWS AgentCore. Cursor Cloud Agents should be second and should be the first opinionated coding-agent connector attempted. AgentCore should shape the managed-runtime conformance profile: create/version endpoint, invoke/stream, stable session identity, reconcile after Paperclip restart, provider-native identity and secrets, async work, cancellation semantics, and explicit protocol capabilities.

Products are not initial `RemoteAgentBackend` targets when they lack a public hosted-task API even if they have a cloud UI. In particular, the Codex SDK and Claude Agent SDK are harness/runtime integrations that Paperclip can run in an environment it controls; they must not be described as hosted-provider connectors unless a separate public cloud-task API supplies create, observe, control, and reconciliation primitives.

#### 7.2.2 Provider connector contract

Each production connector must implement and document these operations even when some return `unsupported`:

```ts
interface RemoteAgentConnector {
  describe(): ProviderDescriptor;
  createSession(input: CreateRemoteSession): Promise<RemoteSessionRef>;
  getSession(ref: RemoteSessionRef): Promise<RemoteSessionSnapshot>;
  listEvents(ref: RemoteSessionRef, cursor?: ProviderCursor): Promise<ProviderEventPage>;
  sendMessage(ref: RemoteSessionRef, input: RemoteMessage): Promise<ProviderCommandRef>;
  approveRequest(ref: RemoteSessionRef, input: RemoteApproval): Promise<ProviderCommandRef>;
  interrupt(ref: RemoteSessionRef, reason: string): Promise<ProviderCommandRef>;
  cancel(ref: RemoteSessionRef, reason: string): Promise<ProviderCommandRef>;
  reconcile(ref: RemoteSessionRef, checkpoint: ProviderCheckpoint): Promise<RemoteReconciliation>;
}
```

The descriptor must declare:

- authentication model and organizational/account scope;
- repository/source binding and branch semantics;
- create idempotency support;
- provider session, task, message/activity, command, branch, and PR identities;
- streaming, webhook, or polling observation mode;
- cursor/event-ID guarantees and ordering limits;
- follow-up, approval, interrupt, cancel, retry, resume, and fork support;
- artifact/image input and output support;
- provider-managed environment controls, network policy, secrets, MCP/tools, setup scripts, snapshots, and retention;
- terminal states, ambiguous states, rate limits, and reconciliation rules;
- billing/usage visibility and provider data-retention policy.

Provider-specific payloads may be retained in bounded raw envelopes or object storage for diagnostics, but the UI and orchestration path consume normalized capabilities, events, requests, results, and terminal states.

#### 7.2.3 Execution ownership and sandbox semantics

The Paperclip protocol is stable across two execution-ownership modes:

```text
Paperclip-managed execution
  Paperclip environment lease -> paperclip-runnerd -> local harness

Provider-managed execution
  RemoteAgentConnector -> provider session/task -> provider-controlled runtime
```

Both modes implement `NativeSessionBackend`; only the first implements the runner-specific PRP transport and Paperclip environment lease lifecycle. A provider-managed runtime is not a Paperclip sandbox, does not receive a fake environment lease, and must not claim controls that the provider API cannot enforce.

Paperclip remains authoritative for task checkout, run/session binding, command intent, approvals, budget gates, normalized event ingestion, result acceptance, audit, and issue finalization. The provider remains authoritative for facts inside its execution boundary, such as VM/container placement, repository clone, process state, network policy, provider-side secrets, and raw provider logs. The connector reconciles those facts into Paperclip; it does not make Paperclip pretend it owns the machine.

Cancellation therefore has two layers:

1. Paperclip durably records that execution is no longer authorized and prevents further accepted results or budget use.
2. The connector requests provider cancellation/termination when supported and records `cancel_requested`, `cancel_confirmed`, or `cancel_unconfirmed` rather than assuming process death.

This preserves one Paperclip session protocol while allowing runtimes that Paperclip does not control.

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
10. The control plane rebuilds pending interaction context and any undelivered response cursors from authoritative interaction rows plus durable interaction events.
11. A response already delivered but not acknowledged is redelivered with the same response identity; replay cannot recreate an interaction, rematerialize suggested tasks, or queue a second equivalent continuation.
12. Any divergence becomes an explicit diagnostic or recovery state.

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
  native-interaction-bridge.ts
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
server/src/routes/native-interactions.ts
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

`NativeSessionRuntime.execute()` can be internally durable and bidirectional while returning only when native execution reaches a terminal state. The control-plane finalizer derives the run terminal state after workspace finalization and reconciliation.

```ts
interface NativeSessionRuntime {
  execute(input: NativeExecutionInput): Promise<NativeExecutionResult>;
}
```

`NativeExecutionResult` should contain enough data to populate the current adapter result:

```ts
interface NativeExecutionResult {
  turnTerminalState: TurnTerminalState;
  runtimeTerminalState: "completed" | "failed" | "cancelled";
  reportedWorkDisposition: ReportedWorkDisposition | null;

  summary: string;
  result: StructuredRunResult | null;
  completionContractRevision: string;
  attentionRequests: AttentionRequest[];

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
- materializing approved `CredentialPlan` bindings without writing secret values to protocol events or the local outbox;
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
- credential-broker policy, long-term secret storage, or provider identity authorization.

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

#### 10.2.1 Replay executable compatibility profile

The Replay standalone tracer makes the PRP v1 static contract executable under
`packages/paperclip-runner/protocol/`. JSON Schema is authoritative for identity,
capability, command, event, request, result, terminal, and scripted-fixture
shapes. TypeScript types are derived from the checked schema module; the Rust
reference reducer consumes the same fixtures and golden parity summaries.

Required version fields and schema discriminators fail closed when unknown.
Unknown optional object fields are accepted and preserved, but have no reducer
effect until a later schema revision defines one. Scripted fixtures require one
unique `run.result.proposed` event whose payload matches the fixture result and
one unique `run.terminal` event. Repeated `sourceEventId` deliveries must be
byte-equivalent after canonical JSON key ordering.

Static replay orders each source by `(sourceKind, sourceInstanceId, sourceSeq)`,
deduplicates before projection, records rather than fills source-sequence gaps,
and leaves an already-applied snapshot unchanged on replay. The package CLI and
standalone browser must import the same validator/reducer entry point. These
rules clarify the v1 compatibility contract; they do not add transport,
persistence, or control-plane authority in Replay.

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
| `interaction.receipt` | Return the durable materialized/replayed/rejected receipt for a bound semantic interaction request. |
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

The canonical run stream also contains server-originated events. They use the
same `runId`, session/turn identities, schema version, priority, canonical
sequence allocation, and reducer as runner events, but have
`sourceKind: "control_plane"` and a server-owned stable source event ID. A
runner cannot forge that source kind. Interaction materialization, resolution,
continuation, and delivery events are server-originated except for the initial
runner-produced proposal (or local schema rejection).

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

- **P0:** terminal events, runtime approval/input requests, issue-thread
  interaction proposal/materialization/resolution/delivery, cancellations,
  session identity, and errors. Never dropped.
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

#### MCP App view

```text
mcp_app.discovered
mcp_app.resource.resolved
mcp_app.initializing
mcp_app.ready
mcp_app.tool_input
mcp_app.tool_result
mcp_app.action.requested
mcp_app.action.resolved
mcp_app.host_context.changed
mcp_app.failed
mcp_app.teardown
```

These events describe durable run-visible lifecycle and security-relevant actions. They do not mirror every iframe `postMessage`. Each event carries stable `viewId`, `resourceUri`, `toolCallId`, `itemId`, and negotiated extension/MIME-type fields when applicable. Resource content is referenced by an authorized content handle plus digest rather than copied into every event.

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
  | "mcp_app"
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

Runtime requests gate a provider or harness operation inside one run. They do
not create or resolve an issue-thread interaction, formal approval, or
execution-stage decision.

#### Issue-thread interactions

```text
interaction.request.proposed
interaction.request.materialized
interaction.request.rejected
interaction.response.progressed
interaction.response.resolved
interaction.response.delivered
```

All six event families are P0 and are never coalesced or dropped.

- `interaction.request.proposed` carries the stable runner `requestId`, strict
  normalized request, payload hash, and host-owned run/session/turn/tool-call
  binding.
- `interaction.request.materialized` carries the interaction ID, created versus
  replayed receipt, requested and effective policy, target binding, and
  idempotency receipt. It is committed with the authoritative interaction row
  before the runner receives success.
- `interaction.request.rejected` carries the safe stable error, bounded
  validation paths, retryability, and whether any row was created. Detailed
  authorization facts remain in company-scoped audit data.
- `interaction.response.progressed` carries full current item-verdict state,
  newly resolved item IDs, a response cursor, and the server continuation
  decision. Model-authored interactions use progress only for item verdicts in
  v1; output-only trusted tool-action execution updates may use the same event
  family.
- `interaction.response.resolved` carries the complete terminal typed response,
  response cursor, target freshness, effective policies, redacted resolver
  class, and continuation decision.
- `interaction.response.delivered` binds one response cursor to its destination
  run/session/turn and acknowledgement state.

`interaction.request.*` events are bound to the source run. Resolution events
remain durable after that run terminalizes and may also be projected into the
destination resumed run. The business interaction row and
`issue.thread_interaction_*` activity remain authoritative for resolver state
and audit; the native events are the execution-protocol trail. Rebuilding a
projection joins those authoritative rows with the durable events and never
infers a resolution from UI state or an in-memory wake payload.

#### Result

```text
run.result.proposed
run.result.accepted
run.result.rejected
attention.request.proposed
attention.request.routed
attention.request.resolved
attention.request.expired
attention.request.superseded
work.assessment.recorded
issue.status.decision.recorded
issue.status.decision.applied
issue.status.decision.rejected
issue.status.decision.superseded
run.terminal
```

`run.result.proposed` preserves the model-authored `StructuredRunResult` and its contract revision. `run.result.accepted` means the result passed schema and binding validation; it does not mean the completion claim was accepted or the issue became `done`.

`work.assessment.recorded` contains the normalized runtime facts, accepted/missing/rejected/unverifiable evidence, pending governed actions, attention routing, and live continuation paths. `issue.status.decision.*` records the arbiter authority, exact assessment and prior-status inputs, reason code, selected transition or no-op, atomic side effects, policy version, and supersession lineage.

`run.terminal` carries `turnTerminalState`, `runTerminalState`, `reportedWorkDisposition`, `workAssessmentId`, and `statusDecisionId`. Consumers must not infer issue status from this event. Attention events use a stable request ID and dedupe key; stale or duplicate responses are retained for audit but cannot resolve a superseded request.

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
    apps: {
      discoverUiResources: boolean;
      preserveToolUiLinkage: boolean;
      relayToolInputAndResults: boolean;
      paperclipHostHandoff: boolean;
      providerRenderedSurface: boolean;
    };
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

The controller assigns `runId` and `normalizedSessionId` independently. A
normalized session ID is not derived as `session:<runId>` and is never replaced
by a driver thread or provider session ID. A durable driver snapshot keeps
those identities separate together with the exact active turn, the canonical
semantic-result fingerprint and original call binding, and every observed
terminal-turn fingerprint needed for replay deduplication.

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

MCP Apps support is an orthogonal negotiated capability. A backend can be L5 for normal typed events while still reporting no interactive UI support. The browser renders an interactive app only when `paperclipHostHandoff` is true and the negotiated extension version, MIME type, resource policy, and content integrity checks pass.

### 13.5 Remote Provider Connector API

Contract B2 uses a control-plane connector rather than the local `HarnessDriver` process interface:

```ts
interface RemoteProviderConnector {
  descriptor(): Promise<RemoteProviderDescriptor>;

  openSession(
    input: OpenRemoteProviderSessionInput,
  ): Promise<RemoteProviderSession>;

  recoverSession?(
    snapshot: PersistedRemoteProviderSession,
  ): Promise<RemoteProviderRecoveryResult>;
}

interface RemoteProviderSession {
  ids(): {
    providerResourceId?: string | null;
    providerSessionId: string;
    displayId?: string | null;
  };

  capabilities(): Promise<NativeSessionCapabilities>;
  events(input: { afterCursor?: string | null }): AsyncIterable<ProviderEvent>;
  startTurn(input: StartNativeTurnInput): Promise<{ providerTurnId?: string | null }>;
  steer?(input: NativeSteerInput): Promise<void>;
  interrupt?(input: NativeInterruptInput): Promise<ProviderControlOutcome>;
  cancel?(input: NativeCancelInput): Promise<ProviderControlOutcome>;
  resolveRequest?(input: ResolveNativeRequestInput): Promise<void>;
  snapshot(): Promise<RemoteProviderSessionSnapshot>;
  reconcile(): Promise<RemoteProviderReconciliation>;
  close(input: { reason: string }): Promise<ProviderControlOutcome>;
}
```

The descriptor states how the connector observes work (`stream`, `webhook`, `poll`, or `sdk_callback`), the provider event-ID and cursor model, retention limits, cancellation guarantees, environment ownership, artifact access, MCP/MCP Apps fidelity, and which controls are advisory versus confirmed. A connector must pass the same normalized session conformance suite as `RunnerBackend`, with provider-specific fixtures for duplicate webhooks, cursor gaps, expired history, ambiguous cancellation, and restart reconciliation.

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
6. Disable automatic skill, app, collaboration, plugin, memory, and
   multi-agent instruction injection in thread config.
7. Create or resume thread.
8. emit `session.started` or `session.resumed`.
9. Persist thread/session parameters in the normalized session binding.

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
2. client-defined `paperclip_finish` and `paperclip_block` dynamic tools;
3. invalid or missing proposals are rejected/preserved as runtime facts and enter
   server-owned assessment/recovery without manufacturing a model disposition or
   issue status.

The task envelope tells the model the expected result shape but does not teach Paperclip API mechanics.

Every provider-facing object schema is strict and every constant field declares
both its JSON `type` and `const`. The finish tool accepts only `done` and
`needs_review`; the block tool accepts only `blocked` with a typed blocker
owner/action/reason/scope. Both normalize through one canonical
`paperclip.run_result.v1` validator. The first valid result is committed,
canonically identical repeats are idempotent even when a provider retry has a
new call ID, and changed repeats are rejected. The original call binding and
canonical content fingerprint are both durable.

### 14.8 Reconciliation

After runner or control-plane reconnect:

1. read the controller-owned normalized identity, exact driver/provider session
   IDs, exact active turn ID, semantic-result state, and terminal fingerprints
   from the durable snapshot;
2. start a new transport and call app-server thread read for the persisted
   driver thread, validating both session identities before resume;
3. resume that exact thread, then read its turns for reconciliation;
4. reconcile only the persisted active turn: retain it if active, terminalize
   it if terminal, and fail explicitly/recoverably if missing or replaced by a
   different active turn; historical terminal turns are not candidates;
5. reconstruct semantic-result and terminal dedupe state before accepting any
   replay, so identical completion/terminal replay is a no-op and changed
   replay conflicts;
6. synthesize only explicit reconciliation events and never invent missing
   deltas;
7. if the provider session cannot be found, mark `session_lost` and apply
   recovery policy.

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
// Canonical unsigned 64-bit decimal with no leading zeros except "0".
// Compare numerically, never lexicographically or as a timestamp.
type ResponseCursorV1 = string;

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
    interactions: {
      pending: PendingInteractionContextV1[];
      resolved: InteractionResponseV1[];
      deliveryCursor?: ResponseCursorV1 | null;
      resumeCause?: {
        interactionId: string;
        kind: InteractionKind;
        phase: "progress" | "terminal";
        responseCursor: ResponseCursorV1;
      } | null;
    };
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
    contract: CompletionContract;
  };
}
```

`pending` contains the current issue's still-open interaction requests that the
model may need to account for before reporting completion. Each entry contains
the durable interaction ID, strict normalized request, target state, requested
and effective resolver/continuation policies, and source run reference, but no
resolver identity, credential, or writable lifecycle field.

`resolved` contains complete normalized responses in response-cursor order,
including full suggested-task materialization, question answers, confirmation
reason/outcome, checkbox selection, and full item-verdict state plus
`newlyResolvedItemIds` for a progress delivery. Responses remain present until
the destination delivery cursor is durably acknowledged. A reconnect or retry
may redeliver an identical response. The only delivery identity is the
server-issued `(companyId, interactionId, responseCursor)` tuple;
`recordedAt` is display/audit metadata and MUST NOT participate in ordering or
deduplication. Consumers MUST retain the greatest applied cursor per
company/interaction stream and make reapplication harmless. **[Security S1]**

The server selects same-session versus fresh-session continuation. A target-bound
plan acceptance may require a fresh native session and workspace refresh. The
model cannot choose session routing, rewrite target freshness, acknowledge an
undelivered response, or request a wake by editing the envelope.

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
  reportedWorkDisposition: "done" | "needs_review" | "yielded",
  summary: string,
  completionClaim: {
    contractRevision: string,
    objectiveSatisfied: boolean,
    criteria: CriterionClaim[],
    remainingWork?: RemainingWork[]
  },
  evidence?: WorkEvidence[],
  verification?: VerificationResult[],
  artifacts?: ArtifactRef[],
  continuation?: ContinuationIntent
})
```

```ts
paperclip.block({
  summary: string,
  blocker: {
    reasonCode: string,
    owner: ResolverTarget,
    unblockAction: string,
    scope: "current_track" | "task_wide",
    evidence?: WorkEvidence[]
  },
  attention?: AttentionRequest
})
```

```ts
paperclip.interact(input: PaperclipInteractV1)
```

The tools are implemented by the runner or harness client and translated into typed events. They do not directly mutate issue state.

`paperclip.interact` replaces the narrow native `paperclip.ask`. It is a strict,
versioned discriminated union over the five current issue-thread kinds:

```ts
type InteractionKind =
  | "suggest_tasks"
  | "ask_user_questions"
  | "request_confirmation"
  | "request_checkbox_confirmation"
  | "request_item_verdicts";

type PaperclipInteractV1 =
  | InteractVariant<"suggest_tasks", SuggestTasksRequestV1>
  | InteractVariant<"ask_user_questions", AskUserQuestionsRequestV1>
  | InteractVariant<"request_confirmation", RequestConfirmationRequestV1>
  | InteractVariant<"request_checkbox_confirmation", CheckboxConfirmationRequestV1>
  | InteractVariant<"request_item_verdicts", ItemVerdictsRequestV1>;

interface InteractVariant<K extends InteractionKind, R> {
  schema: "paperclip.interact.v1";
  kind: K;
  blockingCurrentTurn: boolean;
  title?: string;
  summary?: string;
  resolverHint?: {
    policy?: "board_only" | "board_or_agents";
    addresseeAgentId?: string;
  };
  continuationHint?:
    | "none"
    | "wake_assignee"
    | "wake_assignee_on_accept"
    | "wake_assignee_on_terminal";
  request: R;
}

type ModelInteractionTargetV1 =
  | {
      type: "issue_document";
      key: string;
      revisionId: string;
      revisionNumber?: number;
      label?: string;
    }
  | {
      type: "custom";
      key: string;
      revisionId?: string;
      revisionNumber?: number;
      label?: string;
    };

interface SuggestTasksRequestV1 {
  version: 1;
  defaultParentId?: string | null;
  tasks: Array<{
    clientKey: string;
    parentClientKey?: string | null;
    parentId?: string | null;
    title: string;
    description?: string | null;
    priority?: "critical" | "high" | "medium" | "low" | null;
    workMode?: "standard" | "ask" | "planning" | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    billingCode?: string | null;
    labels?: string[];
    hiddenInPreview?: boolean;
  }>;
}

interface AskUserQuestionsRequestV1 {
  version: 1;
  submitLabel?: string | null;
  supersedeOnUserComment?: boolean;
  questions: Array<{
    id: string;
    prompt: string;
    helpText?: string | null;
    selectionMode: "single" | "multi";
    required?: boolean;
    options: Array<{
      id: string;
      label: string;
      description?: string | null;
    }>;
  }>;
}

interface RequestConfirmationRequestV1 {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  detailsMarkdown?: string | null;
  supersedeOnUserComment?: boolean;
  target?: ModelInteractionTargetV1 | null;
}

interface CheckboxConfirmationRequestV1 {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  options: Array<{
    id: string;
    label: string;
    description?: string | null;
  }>;
  defaultSelectedOptionIds?: string[];
  minSelected?: number;
  maxSelected?: number | null;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  supersedeOnUserComment?: boolean;
  target?: ModelInteractionTargetV1 | null;
}

type ItemVerdict = "approve" | "reject" | "defer";

interface ItemVerdictsRequestV1 {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  items: Array<{
    id: string;
    label: string;
    description?: string | null;
    previewMarkdown?: string | null;
    href?: string | null;
    attachmentId?: string | null;
  }>;
  verdicts?: ItemVerdict[];
  requireReasonOn?: ItemVerdict[];
  reasonLabel?: string | null;
  allowBulkApprove?: boolean;
  supersedeOnUserComment?: boolean;
  target?: ModelInteractionTargetV1 | null;
}
```

The common `InteractVariant.title` is the one runner-card header and
`InteractVariant.summary` is its supporting copy. Runner input for
`ask_user_questions` MUST reject nested `request.title` with the safe path
`/request/title`; two competing card headers are never accepted. Existing
direct REST/CLI callers remain compatible: the legacy request normalizer lifts
`payload.title` into the common stored title when the common title is absent,
prefers an explicitly supplied common title when both are present, and removes
the legacy nested field before canonical hashing. That normalization is outside
the strict `paperclip.interact.v1` model-input validator. **[UX-1]**

All objects use `additionalProperties: false`. Unknown fields are rejected,
not stripped. The model-facing union contains no company, issue, agent, run,
session, source-comment, resolver, status, audit, idempotency, or trusted
`toolAction` field. Confirmation tool-action enrichment is an output/internal
gateway type only; model-supplied action IDs, invocation IDs, hashes, risk,
expiry, signatures, or equivalent reserved fields fail with `reserved_field`.

Only confirmation, checkbox confirmation, and item verdicts accept a target.
For `issue_document`, the server supplies current issue/document identity and
atomically verifies the latest same-company revision at creation and resolution.
A plan decision is `request_confirmation` targeting the latest `plan` revision.
A later revision resolves it as `stale_target`; a later genuine user comment
uses the existing `superseded_by_comment` policy. A custom target is descriptive
unless a registered server resolver recognizes it and never grants authority.

`resolverHint` and `continuationHint` are advisory. The server stores requested
and effective policies separately and may narrow, replace, or reject them.
`request_item_verdicts` is board/user-resolved in v1; an agent cannot resolve its
own or its source run's request. Additive `wake_assignee_on_terminal` wakes only
when the interaction reaches a terminal status. A blocking item-verdict request
defaults to this terminal-only policy: partial batches update the same durable
card/envelope without waking the assignee. Progress wakes are legal only when
the creator explicitly requests `wake_assignee` and server policy accepts that
opt-in. Other blocking kinds still require a policy that resumes for each
applicable terminal outcome; no continuation hint grants resolver authority.

#### 17.3.1 Host binding, idempotency, and failures

The runner wraps validated model input in a host-owned proposal:

```ts
interface BoundInteractionProposalV1 {
  schema: "paperclip.interaction-proposal.v1";
  requestId: string;
  payloadHash: string;
  binding: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string;
    nativeSessionId: string;
    turnId: string;
    toolCallId: string;
  };
  request: PaperclipInteractV1;
}

interface InteractionRequestFailureV1 {
  schema: "paperclip.interaction-request-failure.v1";
  requestId: string;
  accepted: false;
  error: {
    code:
      | "invalid_schema"
      | "reserved_field"
      | "limit_exceeded"
      | "invalid_combination"
      | "invalid_target"
      | "stale_target"
      | "run_binding_invalid"
      | "interaction_not_allowed"
      | "issue_not_open"
      | "idempotency_conflict"
      | "transient_control_plane_failure";
    message: string;
    paths?: string[];
    retryable: boolean;
  };
}
```

Before materialization and again before every resolution, all five kinds use
one centralized, versioned addressee-eligibility predicate. It returns eligible
only when the candidate resolver already has, independently of the hint:

1. same-company issue and target-resource visibility;
2. the role/action capability required by the canonical kind and target;
3. resolver authority under the stored effective resolver policy;
4. assignment and notification eligibility for the issue at that moment; and
5. no same-creator, same-source-run, separation-of-duties, low-trust, deleted,
   paused, or other policy exclusion.

`resolverHint.addresseeAgentId` may select a subset of that already-authorized
resolver set. It MUST NOT grant issue/resource visibility, role capability,
resolver authority, assignment or notification eligibility, or weaken
`board_only`. Creation and resolution use the same predicate revision and
canonical target classification. An ineligible, hidden, missing, or
cross-company addressee returns the same generic `interaction_not_allowed`
failure and creates no interaction, target-visible audit, notification, wake,
or existence-distinguishing timing branch. Company-side security audit is
permitted, but its externally observable emission is deduplicated and
rate-limited by the non-disclosing canonical request family rather than raw
target identity. **[Security S2]**

Every binding value comes from the authenticated host channel. If the provider
has no tool-call ID, the driver allocates and durably records one before bridge
submission. The host computes the route-safe key (at most 255 characters):

```text
native-interaction:v1:<base64url(sha256(
  canonicalLengthPrefixedTuple(
    companyId, issueId, runId, nativeSessionId, turnId, toolCallId
  )
))>
```

The key deliberately excludes payload. The first accepted payload hash is
stored with it. Replaying the same binding and payload returns the existing
interaction; reusing the invocation with different input returns
`idempotency_conflict`. Only a transient control-plane failure may retry, and
that retry reuses the identical proposal and key. Materialization commits the
interaction, binding receipt, requested/effective policy, target, provenance,
business activity, and protocol event before success is returned.

There is also a pending-equivalence layer across all five kinds, independent of
tool-call retry identity. Under the source-agent/issue family lock, an existing
pending row with the same source agent, kind, canonical normalized payload, and
canonical authorized target replays its original materialization receipt. A
different canonical payload or target is a distinct request, subject to the
family's finite rate and pending-card limits. Equivalence uses only targets the
caller was already authorized to reference; a rejected addressee/target is
processed through the generic denial family above, so dedupe, conflicts, and
rate-limit responses cannot disclose whether that target exists. Resolution or
expiry releases the pending slot but does not erase its immutable receipt.

The runner and server both enforce current validator limits: 1–50 suggested
tasks; 1–10 questions with 1–10 options each; 1–200 checkbox options; 1–200
verdict items; title 240; summary 1,000; reason/free text 4,000; details,
preview, or summary markdown 20,000; href 2,000; and at most 20 safe validation
paths. Requests must also fit `maxEventBytes`; they are never silently moved to
a blob.

#### 17.3.2 Durable response union

```ts
type InteractionResponseV1 =
  | InteractionResponse<"suggest_tasks", SuggestTasksResponseV1>
  | InteractionResponse<"ask_user_questions", AskUserQuestionsResponseV1>
  | InteractionResponse<"request_confirmation", ConfirmationResponseV1>
  | InteractionResponse<"request_checkbox_confirmation", CheckboxResponseV1>
  | InteractionResponse<"request_item_verdicts", ItemVerdictsResponseV1>;

interface InteractionResponse<K extends InteractionKind, R> {
  schema: "paperclip.interaction-response.v1";
  companyId: string;
  interactionId: string;
  responseCursor: ResponseCursorV1;
  requestId: string;
  kind: K;
  phase: "progress" | "terminal";
  status:
    | "pending"
    | "accepted"
    | "rejected"
    | "answered"
    | "cancelled"
    | "expired"
    | "failed";
  result: R;
  target?: {
    requested: ModelInteractionTargetV1;
    resolvedRevisionId?: string | null;
    stale: boolean;
  };
  policy: {
    effectiveResolverPolicy: "board_only" | "board_or_agents";
    effectiveContinuationPolicy:
      | "none"
      | "wake_assignee"
      | "wake_assignee_on_accept"
      | "wake_assignee_on_terminal";
  };
  source: {
    runId: string;
    nativeSessionId: string;
    turnId: string;
    toolCallId: string;
  };
  continuation: {
    action:
      | "none"
      | "wake_queued"
      | "fresh_session_queued"
      | "suppressed_closed"
      | "suppressed_unassigned"
      | "resume_failed";
    resumedRunId?: string | null;
    sessionMode: "same" | "fresh" | "server_selected" | "none";
  };
  recordedAt: string;
}

interface PendingInteractionContextV1 {
  interactionId: string;
  kind: InteractionKind;
  request: PaperclipInteractV1;
  target?: {
    requested: ModelInteractionTargetV1;
    latestRevisionId?: string | null;
    stale: boolean;
  };
  requestedResolverPolicy?: "board_only" | "board_or_agents";
  effectiveResolverPolicy: "board_only" | "board_or_agents";
  requestedContinuationPolicy?:
    | "none"
    | "wake_assignee"
    | "wake_assignee_on_accept"
    | "wake_assignee_on_terminal";
  effectiveContinuationPolicy:
    | "none"
    | "wake_assignee"
    | "wake_assignee_on_accept"
    | "wake_assignee_on_terminal";
  sourceRunId: string;
  createdAt: string;
}

type AdministrativeTerminalV1 =
  | { outcome: "withdrawn"; reason?: string | null }
  | { outcome: "issue_closed"; reason?: string | null }
  | { outcome: "addressee_deleted"; reason?: string | null }
  | { outcome: "failed"; errorCode: string; retryable: false };

type SuggestTasksResponseV1 =
  | {
      outcome: "accepted";
      createdTasks: Array<{
        clientKey: string;
        issueId: string;
        identifier?: string | null;
        title?: string | null;
        parentIssueId?: string | null;
        parentIdentifier?: string | null;
      }>;
      skippedClientKeys: string[];
      materializationId: string;
    }
  | { outcome: "rejected"; reason?: string | null }
  | AdministrativeTerminalV1;

type AskUserQuestionsResponseV1 =
  | {
      outcome: "answered";
      answers: Array<{
        questionId: string;
        optionIds: string[];
        otherText?: string | null;
      }>;
      summaryMarkdown?: string | null;
    }
  | { outcome: "cancelled"; reason?: string | null }
  | { outcome: "superseded_by_comment"; commentId: string }
  | AdministrativeTerminalV1;

type ConfirmationResponseV1 =
  | { outcome: "accepted"; reason?: string | null }
  | { outcome: "rejected"; reason?: string | null; commentId?: string | null }
  | {
      outcome:
        | "superseded_by_comment"
        | "superseded_by_newer_request"
        | "stale_target";
      reason?: string | null;
      commentId?: string | null;
      supersededByInteractionId?: string | null;
    }
  | {
      outcome: "trusted_tool_action";
      status: "approved" | "executing" | "executed" | "failed" | "expired";
      errorCode?: string | null;
      errorMessage?: string | null;
      resultSummary?: string | null;
      resultHref?: string | null;
    }
  | AdministrativeTerminalV1;

type CheckboxResponseV1 =
  | { outcome: "accepted"; selectedOptionIds: string[] }
  | { outcome: "rejected"; reason?: string | null; commentId?: string | null }
  | {
      outcome: "superseded_by_comment" | "stale_target";
      reason?: string | null;
      commentId?: string | null;
    }
  | AdministrativeTerminalV1;

type ItemVerdictsResponseV1 =
  | {
      outcome: "progress" | "resolved";
      complete: boolean;
      newlyResolvedItemIds: string[];
      items: Array<{
        id: string;
        verdict: "approve" | "reject" | "defer";
        reason?: string | null;
        resolvedAt: string;
      }>;
    }
  | {
      outcome: "superseded_by_comment" | "stale_target" | "cancelled";
      complete: false;
      newlyResolvedItemIds: [];
      items: Array<{
        id: string;
        verdict: "approve" | "reject" | "defer";
        reason?: string | null;
        resolvedAt: string;
      }>;
      reason?: string | null;
      commentId?: string | null;
    }
  | AdministrativeTerminalV1;
```

Resolver identity remains in the company-scoped auditable row; model delivery
uses only a redacted resolver class when diagnostics require it. Suggested-task
acceptance materializes selected drafts transactionally in parent-before-child
order and is at-most-once per `(interactionId, clientKey)`. Item verdicts may
deliver progress repeatedly, but already resolved IDs are immutable.

`responseCursor` is immutable, server-issued, numerically monotonic within the
company delivery sequence, and allocated in the same transaction that records
the progress/terminal result, authoritative continuation decision, delivery
row, and any wake outbox row. No timestamp, client counter, resolver retry, or
event sequence may substitute for it. Reducers compare its canonical decimal
value as an unsigned 64-bit integer, never by string or timestamp. Delivery and
ACK rows bind the cursor to one destination run, native session, and turn; an
ACK from any other destination is rejected without advancing delivery.
Lost-ACK and restart replay returns the byte-equivalent normalized response for
that cursor.

#### 17.3.3 Turn-yield and completion coexistence

- A blocking call yields only after `interaction.request.materialized` is
  durable. It terminalizes the turn as `completed` with reported work
  disposition `yielded`; the model does not also call `paperclip.finish`.
- A rejected blocking request does not yield. The tool returns the safe failure
  and the model may correct it through a new tool invocation.
- A non-blocking call returns the materialized interaction reference and the
  model may continue, create more non-blocking interactions, and later invoke
  exactly one terminal `paperclip.finish` or `paperclip.block`.
- A pending interaction is an independent durable fact. If reported completion
  depends on it, the status arbiter preserves a live continuation/review path;
  if completion is independent and policy permits closing, issue closure
  expires pending cards with `issue_closed`.
- Once a blocking interaction auto-yields, later output or a terminal tool from
  that turn fails with `turn_already_terminal`.
- `paperclip.block` remains a task/track blocker report. A blocking interaction
  is not proof of a task-wide blocker and never directly sets issue `blocked`.

### 17.4 Current issue-thread interaction inventory

This subsection records the current implementation contract as of 2026-08-07. It is an inventory, not the proposed native-runner API. The five kinds below are the complete `IssueThreadInteractionKind` union. They are durable, company- and issue-scoped thread records; they are not provider-native elicitation packets and are not direct issue-status mutations.

Every interaction row stores its kind and status, requested and effective resolver policy, continuation policy, optional idempotency key, optional source comment/run and addressed agent, title/summary, typed payload/result, creator/resolver attribution, and creation/update/resolution timestamps. The shared statuses are `pending`, `accepted`, `rejected`, `answered`, `cancelled`, `expired`, and `failed`, although each kind uses only the applicable subset.

#### 17.4.1 Kind matrix

| Kind | Purpose and request payload | Resolver operation | Durable result | Direct side effects |
| --- | --- | --- | --- | --- |
| `suggest_tasks` | Propose 1–50 issue drafts. Each draft has a stable `clientKey`, title, optional `parentClientKey` or `parentId`, description, priority, work mode, one assignee, project/goal/billing data, labels, and preview visibility. `defaultParentId` supplies the fallback parent. Client keys must be unique; parent-client references must be acyclic and selected descendants require their selected ancestors. | `POST .../accept` accepts all drafts by default or a non-empty `selectedClientKeys` subset. `POST .../reject` may include a reason. Default resolver is board-only. | Accept: status `accepted`, `createdTasks[]` mapping each client key to the new issue id/identifier/title/parent, plus `skippedClientKeys[]`. Reject: status `rejected` and `rejectionReason`. | Acceptance creates real `todo` child issues transactionally in parent-before-child order, inherits source project/goal defaults, writes normal issue/activity records, and queues assignment wakes for newly created assigned issues. It does not advance source workspace state. Rejection only resolves/touches/audits the interaction. |
| `ask_user_questions` | Ask 1–10 structured questions. Each has a stable id, prompt, optional help text, single/multi selection mode, required flag, and 1–10 options; responses can include option ids and `otherText`. The payload may set a card title, submit label, and comment-supersession behavior. | `POST .../respond` validates and normalizes answers. A board user may `POST .../cancel` with a reason. Default resolver is board-or-agents, subject to addressee, same-creator, same-run, company governance, and current-run checks. | Response: status `answered`, `answers[]`, and optional `summaryMarkdown`. Cancel: status `cancelled`, empty answers, `cancelled: true`, and `cancellationReason`. Comment supersession: status `expired`, empty answers, `expirationReason: "superseded_by_comment"`, and `commentId`. | Resolution touches the issue, writes activity/telemetry, and may queue the assignee continuation. It does not create issues or comments. |
| `request_confirmation` | Ask one accept/reject question with labels, optional details, optional/required decline reason, and optional target. An `issue_document` target binds the request to a specific document revision; a `custom` target is descriptive metadata. Server-owned `toolAction` enrichment is a special gateway-generated use and cannot be supplied through the public create route. | `POST .../accept` or `POST .../reject`; rejection enforces `rejectRequiresReason`. Default resolver is board-only. A policy-eligible agent may resolve an explicitly bound issue-review verdict, but cannot resolve its own/same-run request; tool-action confirmations are always board-only. | Status `accepted` or `rejected`; result has `outcome`, optional reason/comment, supersession/stale-target metadata, optional resume-failure metadata, and for tool actions their execution lifecycle/result. | Acceptance first requires the source run's execution-workspace finalization when applicable. A human acceptance can return an `in_review`/user-held request to its creator agent as `todo`; accepted plan confirmation forces a fresh-session workspace refresh; tool-action acceptance delegates approve-and-run to the tool gateway. All resolutions are audited and can queue continuation. |
| `request_checkbox_confirmation` | Ask the resolver to choose a subset of 1–200 known options, then accept or reject the decision as a whole. The payload carries stable option ids/labels/descriptions, defaults, `minSelected`/`maxSelected`, labels/reason policy, details, supersession behavior, and optional target. Empty acceptance is valid when `minSelected` is zero. | `POST .../accept` with optional `selectedOptionIds`, otherwise defaults are used; `POST .../reject` may or must carry a reason. Default resolver is board-only, with the same explicitly bound review-verdict exception as confirmation. | Same confirmation outcome/result contract, with `selectedOptionIds[]` on acceptance. | Same workspace-finalization, creator-return, audit, and continuation behavior as `request_confirmation`; it does not itself perform an action on selected ids. The resumed wake path additionally derives selected option labels/descriptions. |
| `request_item_verdicts` | Ask for an independent verdict on each of 1–200 items. Items have stable ids, labels, optional descriptions/previews/links/attachments. Enabled verdicts must include `approve` and `reject`; `defer` is optional. The payload controls which verdicts require reasons, bulk approve UI, details, supersession behavior, and optional target. | `POST .../verdicts` submits one or more `{id, verdict, reason}` values. Only a concrete user actor can submit. Previously resolved ids are immutable/idempotent; unresolved ids may be submitted later. Default/effective behavior is board-only. The generic accept/reject routes do not apply. | Status remains `pending` while partial, then becomes `answered`. Result is `{outcome: "resolved", complete, items[]}`; each item stores verdict, optional reason, resolver user id, resolution time, and optional comment id. Stale/superseded/administrative outcomes preserve prior item results. | Each non-empty newly resolved batch touches/audits the issue and can wake the assignee; wakes are coalesced in two-second idempotency buckets. No domain action is performed from a verdict by this service. |

#### 17.4.2 Shared lifecycle matrix

| Concern | Current authoritative behavior |
| --- | --- |
| Creation and idempotency | `POST /api/issues/:issueId/interactions` validates the discriminated union, requires a current agent run for agent creation, denies low-trust control-plane creation, rejects terminal issues, checks company ownership of source references/addressees, and inserts `pending`. An idempotency key is unique within company + issue: an actor-identical, payload-identical retry returns the existing row; different reuse conflicts. Creating an addressed interaction wakes that eligible addressee with `interaction_pending`. |
| Resolver authority | Defaults are board-only for every kind except `ask_user_questions`, which defaults to board-or-agents. Company governance can select/cap requested policy; the row stores both requested and effective policy. Agent resolution requires a run id, honors an addressed agent, and forbids the creator agent and source run. Item verdict submission additionally requires a user even if policy were configured otherwise. |
| Continuation | Legacy/direct callers keep their existing defaults: `wake_assignee` for `suggest_tasks`, `ask_user_questions`, checkbox confirmation, and item verdicts; plain confirmation defaults to `none`. The additive `wake_assignee_on_terminal` policy resumes only after a terminal status. Native blocking item verdicts default to it, while `wake_assignee` progress delivery requires explicit opt-in. `wake_assignee` otherwise resumes after accepted/rejected/answered/cancelled resolution and each eligible partial verdict batch; `wake_assignee_on_accept` resumes only for status `accepted`; `none` does not resume. Closed or unassigned issues do not wake. Normal expiry does not wake through continuation policy; if resolution consumes the only valid `in_review` path, a separate review-path-recovery wake may be queued. |
| Target/revision binding | Only confirmation, checkbox confirmation, and item verdicts accept `target`. For `type: "issue_document"`, creation atomically requires the current same-company document revision; resolution rechecks it; publishing/deleting the bound document revision expires the pending card as `stale_target` while recording the prior target. A `custom` target is stored and rendered but has no server-side freshness resolver. Suggested tasks and questions have no target/revision field. |
| User-comment supersession | Questions, confirmation, checkbox confirmation, and item verdicts normalize `supersedeOnUserComment` to `true`. A genuine later human comment (not a run-attributed comment) expires the pending interaction as `superseded_by_comment`; list-time catch-up applies the same rule to historical comments. `suggest_tasks` is not comment-supersedable. |
| Newer-request supersession | Creating a newer `request_confirmation` by the same agent on the same issue expires that agent's older pending `request_confirmation` rows as `superseded_by_newer_request`. This automatic replacement does not apply to questions, checkbox confirmations, item verdicts, or suggestions. |
| Withdrawal, closure, and addressee deletion | The creator agent, current assignee agent, or board user can withdraw any pending kind through `/withdraw`, producing status `cancelled` and outcome `withdrawn`. Moving the issue to `done`/`cancelled` expires every pending kind with outcome `issue_closed` and no closed-issue wake. Deleting an addressed agent cancels its pending cards with `addressee_deleted`. There is no generic time-to-live on an ordinary interaction; tool-action requests have their own expiry. |
| Audit and live UI | Creation and every resolution path write `issue.thread_interaction_*` activity and resolution telemetry and touch the issue. The board UI invalidates the issue-interactions query for every live activity action with that prefix. Its thread reducer orders the returned interaction records into the issue conversation, and one card component renders all five kinds and their pending/history states. |

#### 17.4.3 Resume data delivered today

The control plane queues a continuation with durable `interactionId`, `interactionKind`, `interactionStatus`, `sourceCommentId`, and `sourceRunId` in the heartbeat context snapshot. It adds specialized data for:

- plan confirmation: target revision, accepted target, and confirmation result, plus fresh-session/workspace-refresh routing on acceptance;
- checkbox confirmation: prompt, selected ids, and resolved option labels/descriptions;
- tool-action confirmation: execution state/result;
- item verdicts: newly resolved item ids and the two-second coalescing window.

The interaction row remains the authoritative full response and is retrievable through `GET /api/issues/:issueId/interactions`. Current legacy wake-envelope normalization exposes only interaction kind/status and checkbox selection generally; it does not provide a uniform resolved interaction object to the model. Therefore an agent must refetch the interaction to obtain question answers, suggested-task materialization, ordinary confirmation reasons, or complete item verdicts. The item-verdict ids placed in the heartbeat context snapshot are also dropped by the current adapter wake-payload normalizer.

#### 17.4.4 Surface coverage and discovered contract mismatches

| Surface | Current coverage | Mismatch relevant to a native semantic interaction tool |
| --- | --- | --- |
| REST/server | Lists and creates all five kinds. Accept handles suggestions and both confirmation kinds; reject handles suggestions and both confirmation kinds; respond handles questions; verdicts handles item verdicts; withdraw handles every pending kind; cancel is the board-only questions cancellation route. | Route vocabulary is intentionally kind-specific, so a runner bridge needs a typed operation-to-kind mapping rather than assuming every kind supports accept/reject. |
| CLI | Generic JSON creation validates all five kinds; list, accept, reject, cancel, and respond commands wrap the corresponding REST routes. | No `interaction:verdicts` command exists, so the CLI cannot resolve `request_item_verdicts`. No `interaction:withdraw` command exists; the command named `interaction:cancel` only cancels questions. |
| MCP server | Dedicated create tools exist for suggestions, questions, confirmation, and checkbox confirmation. | There is no create tool for `request_item_verdicts`, no interaction list/resolution/withdraw tools, and the four create schemas omit shared `resolverPolicy` and `addresseeAgentId`. MCP is therefore not a complete exposure of the shared interaction union. |
| Board UI | API wrappers and the issue-thread card support all five request/response shapes, including partial item verdicts; activity-driven live updates invalidate the interaction query. | The attention-queue inline quick action is specialized to plain confirmation; other kinds rely on their full thread card. This is a presentation difference, not a lifecycle mismatch. |
| Heartbeat/adapter resume | The server stores interaction identity/status and the special plan, checkbox, tool-action, and newly-resolved-item contexts before wake. | The skillless/legacy task envelope is not a lossless round trip for all five results: it omits the interaction id and full result, drops item-verdict delta data during adapter normalization, and supplies no inline answers or created-task references. A native runner contract must deliver the durable resolved response explicitly or require a typed fetch owned by the runner, not by the model. |
| Existing docs/instructions | Shared types and runtime support five kinds. | `doc/SPEC-implementation.md` section 10.11 still names only `suggest_tasks`, `ask_user_questions`, and `request_confirmation`. The adapter heartbeat instruction string likewise tells agents to create only those three. The Paperclip skill's headline table covers all five, but its key-endpoint summary omits `/verdicts` and the board-only `/cancel`. |

#### 17.4.5 Adjacent control-plane mechanisms that are not interaction kinds

| Mechanism | Why it is separate | Model-facing semantic-tool boundary |
| --- | --- | --- |
| Formal approvals | Company-scoped `approvals` records have approval types, governance status, linked issues, and board decision routes. They can govern hiring, strategy, budget, or an arbitrary board action and are not one response belonging only to an issue thread. | The model may report that governed approval is needed, but the native interaction primitive must not forge, resolve, or collapse a formal approval into `request_confirmation`. Paperclip policy creates and authorizes the approval. |
| Execution-stage decisions | `executionPolicy`/`executionState` route an issue through typed review/approval participants. A participant records approve/request-changes by a legal issue update, and the server advances or returns the stage. | These are finalization/workflow-policy decisions owned by the status arbiter and execution policy. They are not free-form interaction requests and must not be emitted as one of the five kinds merely to bypass a stage. |
| Issue comments | Comments are durable conversation/progress records with authorship, presentation, metadata, wake, reopen/resume, and live-update behavior. A human comment can supersede pending interaction kinds, but is not itself a typed resolution. | Steering/progress may persist as comments through the host. The semantic interaction tool should create a typed card when a typed response is required, not ask the model to parse a later comment as its result. |
| Document annotations | Annotations are anchored discussions on document content/revisions with their own routes, deltas, resolution state, and live query. They discuss a location; they do not bind a yes/no or selection response to the whole target revision. | The runner may surface annotation deltas as task context, but annotation creation/resolution is not one of the five model-facing interaction choices. A revision-wide plan decision remains target-bound `request_confirmation`. |
| Standalone decisions/decision bundles | Decisions encode cross-issue effects and bundles, with separate option/effect authorization and staleness. The routing rule is same issue -> interaction; other issues/bundles -> decision. | The proposed issue-thread semantic tool is scoped to the current issue and cannot express or execute cross-issue effect bundles. |
| Runtime permission requests | Provider/harness permission or elicitation requests gate a tool/process inside one run and have provider/run lifecycle semantics. | They stay runner/runtime events. Even when a tool gateway renders a server-owned `request_confirmation`, the model cannot forge its trusted `toolAction` payload or treat runtime permission as board governance. |

#### 17.4.6 Authoritative source trace

- Shared union, statuses, policies, and limits: `packages/shared/src/constants.ts`.
- Payload/result types: `packages/shared/src/types/issue.ts`.
- Create and resolver validators: `packages/shared/src/validators/issue.ts`.
- Durable row and idempotency index: `packages/db/src/schema/issue_thread_interactions.ts`.
- Policy, creation, resolution, materialization, stale-target, supersession, withdrawal, and terminal expiry: `server/src/services/issue-thread-interactions.ts`.
- REST authorization, activity, wake construction, and per-kind routes: `server/src/routes/issues.ts`.
- Continuation retry/context projection: `server/src/services/heartbeat.ts`.
- Legacy wake-envelope normalization/rendering: `packages/adapter-utils/src/server-utils.ts`.
- CLI exposure: `cli/src/commands/client/issue.ts`.
- MCP exposure: `packages/mcp-server/src/tools.ts`.
- Board API and five-kind cards: `ui/src/api/issues.ts` and `ui/src/components/IssueThreadInteractionCard.tsx`.
- Thread projection and live invalidation: `ui/src/lib/issue-chat-messages.ts`, `ui/src/lib/issue-thread-interactions.ts`, and `ui/src/context/LiveUpdatesProvider.tsx`.
- Adjacent approval, execution-stage, comment, annotation, and decision contracts: `server/src/routes/approvals.ts`, `server/src/routes/issues.ts`, `server/src/services/document-annotations.ts`, and `server/src/routes/decisions.ts`.

---

## 18. Structured result and terminal semantics

### 18.1 Result schema

```ts
type TurnTerminalState =
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

type RunTerminalState = "succeeded" | "failed" | "cancelled";

type ReportedWorkDisposition =
  | "done"
  | "blocked"
  | "needs_review"
  | "yielded";

type AuthoritativeIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

interface CompletionContract {
  schema: "paperclip.completion-contract.v1";
  issueId: string;
  revision: string;
  objective: string;
  criteria: Array<{
    id: string;
    description: string;
    required: boolean;
    assessmentMode?:
      | "mechanical"
      | "policy_backed_agent_claim"
      | "named_reviewer"
      | "board";
    verificationClasses?: Array<
      "test" | "build" | "lint" | "typecheck" | "review" | "external_check"
    >;
  }>;
  requiredArtifacts: Array<{
    kind: string;
    description: string;
    minimumCount?: number;
  }>;
  governedGates: Array<{
    kind: "approval" | "security_review" | "qa_review" | "board_decision";
    authority: ResolverTarget;
    requiredBeforeDone: boolean;
  }>;
  completionAuthority:
    | "mechanical"
    | "policy_backed_agent_claim"
    | "named_reviewer"
    | "board";
  incompleteCriteriaPolicy:
    | "continue"
    | "require_review"
    | "allow_low_risk_agent_claim";
  risk: "low" | "medium" | "high";
  policyVersion: string;
}

interface CriterionClaim {
  criterionId: string;
  status: "satisfied" | "not_satisfied" | "unknown";
  evidenceRefs: string[];
  explanation?: string;
}

interface RemainingWork {
  description: string;
  ownerHint?: ResolverTarget;
  blocksCompletion: boolean;
}

interface WorkEvidence {
  id: string;
  kind: "test" | "artifact" | "diff" | "observation" | "external_check";
  description: string;
  status: "passed" | "failed" | "unknown";
  ref?: string;
  producedAt: string;
}

interface ContinuationIntent {
  kind: "same_agent" | "retry" | "delegated_issue" | "response_wake" | "monitor";
  summary: string;
  idempotencyKey: string;
  waitsOnInteractionIds?: string[];
  notBefore?: string;
  target?: ResolverTarget;
}

interface ResolverTarget {
  ownerClass: "current_agent" | "agent" | "role" | "board_user" | "external_system";
  agentId?: string;
  role?: string;
  userId?: string;
  externalSystem?: string;
  companyId: string;
}

interface AttentionRequest {
  id: string;
  dedupeKey: string;
  requestedCapability:
    | "context_lookup"
    | "retry"
    | "domain_expertise"
    | "credential_grant"
    | "governed_approval"
    | "subjective_decision"
    | "external_action"
    | "review";
  requiredAuthority?: "none" | "agent" | "board" | "external";
  target: ResolverTarget;
  scope: "current_turn" | "current_track" | "task_wide";
  blockingCurrentTurn: boolean;
  summary: string;
  question?: string;
  choices?: Array<{ key: string; label: string }>;
  attempts: Array<{
    kind: "context_lookup" | "tool" | "retry" | "delegation";
    summary: string;
    evidenceRefs?: string[];
  }>;
  evidenceRefs: string[];
  urgency: "normal" | "high";
  expiresAt?: string;
  responsePolicy: "wake_current_turn" | "wake_assignee" | "resume_track" | "record_only";
}

interface StructuredRunResult {
  schema: "paperclip.run_result.v1";
  reportedWorkDisposition: ReportedWorkDisposition;
  summary: string;
  completionClaim: {
    contractRevision: string;
    objectiveSatisfied: boolean;
    criteria: CriterionClaim[];
    remainingWork: RemainingWork[];
  };
  evidence: WorkEvidence[];
  verification: Array<{
    commandOrCheck: string;
    status: "passed" | "failed" | "not_run";
    detail?: string;
    artifactRef?: string;
  }>;
  blocker?: {
    reasonCode: string;
    owner: ResolverTarget;
    unblockAction: string;
    scope: "current_track" | "task_wide";
  };
  attentionRequests: AttentionRequest[];
  artifacts: Array<{
    kind: string;
    ref: string;
    title?: string;
  }>;
  continuation?: ContinuationIntent;
}
```

The task envelope contains the exact `CompletionContract` revision used for the turn. A result that cites another revision is stale until reconciled against the current contract. Missing acceptance criteria do not silently become satisfied criteria: policy must choose continued work, review, or an explicit low-risk agent-claim path.

`assessmentMode` may narrow an individual criterion relative to the contract-wide `completionAuthority`; it may not widen it. This permits a mixed contract—for example, mechanically checking a test while requiring a named reviewer for product judgment—without pretending arbitrary semantic completion is mechanically provable. A mechanical outcome is valid only when it is derived from an authoritative persisted test, artifact, approval, or external-check record. A model-authored `status: "passed"` is a claim to classify, not mechanical proof.

`blockingCurrentTurn` is a runner-observed runtime fact. It must be `true` when the driver cannot continue the current turn without resolution. It does not widen `scope` to `task_wide`, prove that all productive tracks are stopped, or authorize issue status `blocked`.

An accepted blocking `paperclip.interact` call creates a host-authored terminal
report rather than asking the model to duplicate the result through
`paperclip.finish`:

```ts
interface InteractionYieldResultV1 {
  schema: "paperclip.interaction-yield.v1";
  reportedWorkDisposition: "yielded";
  interactionId: string;
  requestId: string;
  kind: InteractionKind;
  materialization: "created" | "replayed";
  effectiveContinuationPolicy: "wake_assignee" | "wake_assignee_on_terminal";
}
```

The finalizer converts this receipt into the same durable work-assessment path
as an explicit yielded result, while preserving that the source was a semantic
tool rather than model-authored completion prose. The interaction and the
status decision remain separate records.

`ContinuationIntent.waitsOnInteractionIds` is the only explicit declaration
that non-blocking finalization depends on pending interaction responses. Every
listed ID must be a pending same-company interaction on the current issue and
must be materialized by or visible to the current run. When present and valid,
the arbiter preserves a live path until those dependencies terminalize. When
absent, no dependency may be inferred from `summary`, remaining-work prose,
titles, or comments: policy may close an otherwise complete issue and expire
the independent pending interactions as `issue_closed`. Empty, duplicate,
stale, foreign, or unauthorized IDs fail safe validation without status or wake
side effects.

| Interaction fact | Turn/run disposition | Status-arbiter input | Forbidden inference |
|---|---|---|---|
| Request rejected before materialization | Turn stays open; no terminal report | Safe validation failure only | Rejection is not a blocker or review path. |
| Non-blocking request materialized | Turn continues | Pending interaction is durable context | Creating a card does not change issue status. |
| Blocking request materialized | Turn `completed`; reported disposition `yielded`; run finalizes normally | Pending interaction, effective continuation, and any existing live paths | `blockingCurrentTurn` does not mean issue `blocked`. |
| Progress response recorded | Source run remains terminal; server may queue a resumed run | Full current item-verdict state, new-item delta, response cursor, continuation decision | Partial verdicts do not imply completion. |
| Terminal response recorded | Server selects same/fresh resumed session or suppression | Typed response, target state, effective policy, and authoritative continuation result | Acceptance does not itself set `done`; rejection does not itself set `blocked`. |
| `paperclip.finish` while a dependency-relevant interaction remains pending | Normal completion assessment | Completion contract plus pending interaction and its live path | A model claim cannot discard the pending request or force `done`. |

Formal `approvals` and execution-policy reviews never enter this table as
interaction kinds. They retain their own authority, participant, and status
transitions. An interaction may expose a typed issue-thread decision, but it
cannot satisfy a governed approval or execution stage unless the corresponding
server policy independently records that authorized decision.

### 18.2 Validation

Validation has three distinct outcomes:

1. **Schema acceptance** confirms that Paperclip can safely persist and assess the report.
2. **Evidence assessment** classifies each claim as accepted, missing, rejected, or unverifiable.
3. **Status arbitration** decides the authoritative issue transition or no-op.

Schema acceptance validates:

- schema version;
- reported work disposition;
- size limits;
- artifact ownership;
- evidence-reference ownership and existence where mechanically checkable;
- run/session binding;
- completion-contract revision;
- company scope for every resolver target;
- blocker owner/action when `reportedWorkDisposition` is `blocked`;
- continuation intent when `reportedWorkDisposition` is `yielded`;
- stable attention IDs, dedupe keys, expiry, and response policy.

Invalid result:

- emit `run.result.rejected`;
- allow a bounded correction turn when policy permits;
- otherwise terminalize the run according to runtime facts, preserve any safely parsed claims/evidence, record `result_schema_rejected`, and create a live recovery or review path without assuming issue status `in_review`.

A valid result emits `run.result.accepted`, but acceptance grants no status authority. Evidence validation must not erase failed, unknown, stale, or rejected evidence; it records the classification and reason so later review or reconciliation can inspect the original claim.

### 18.3 Status authority and human-needed signaling

Issue status is a server-owned projection of validated work facts, not an agent speech act. The four authorities are:

| Decision surface | Authority | Inputs it may assert | Inputs it may not assert |
|---|---|---|---|
| Harness driver | Turn lifecycle authority | Accepted turn identity and terminal state | Task completion or issue status |
| Runner/finalizer | Run lifecycle authority | Process/provider outcome, runtime diagnostics, workspace finalization, run terminal state | Semantic completion or issue status |
| Agent/model | Work-report authority | Reported disposition, completion claim, evidence, remaining work, blocker and attention candidates | Authoritative issue transition, governed approval, cross-company routing |
| Status arbiter | Organizational status authority | Legal issue transition/no-op and atomic side effects | Rewriting the original agent report or fabricating evidence |

The approved operator-facing presentation of these four authorities — the
layered outcome vocabulary, components, desktop board flows, reason-code copy,
and token mapping — is maintained in
[`paperclip-runner-status-attention-ux.md`](./paperclip-runner-status-attention-ux.md)
(PAP-16712) and is normative for Operator contract UI work. Section 18.12 binds that
design to concrete read models, routes, derivation rules, and release gates.

The arbiter consumes a durable assessment rather than raw prose:

```ts
interface WorkAssessment {
  schema: "paperclip.work-assessment.v1";
  id: string;
  issueId: string;
  runId: string;
  turnId: string;
  turnTerminalState: TurnTerminalState;
  runTerminalState: RunTerminalState;
  reportedWorkDisposition: ReportedWorkDisposition | null;
  completionContractRef: string;
  completionContractRevision: string;
  criterionAssessments: Array<{
    criterionId: string;
    outcome: "accepted" | "missing" | "rejected" | "unverifiable";
    evidenceRefs: string[];
    reasonCode: string;
  }>;
  acceptedEvidenceRefs: string[];
  missingRequirements: string[];
  rejectedEvidence: Array<{ ref: string; reasonCode: string }>;
  unverifiableEvidence: Array<{ ref: string; reasonCode: string }>;
  pendingGovernedActions: string[];
  remainingWork: RemainingWork[];
  attention: Array<{
    requestId: string;
    route: "context" | "retry" | "agent" | "board" | "external" | "rejected";
    resolver?: ResolverTarget;
    reasonCode: string;
  }>;
  livePaths: Array<{
    kind: "continuation" | "retry" | "delegated_issue" | "interaction" | "review" | "monitor";
    ref: string;
  }>;
  priorIssueStatus: AuthoritativeIssueStatus;
  policyVersion: string;
  supersedesAssessmentId?: string;
}

interface StatusDecision {
  schema: "paperclip.status-decision.v1";
  id: string;
  issueId: string;
  assessmentId: string;
  authority: "paperclip_status_arbiter";
  triggerAuthority: {
    kind: "runner_finalizer" | "board_user" | "authorized_agent" | "interaction" | "dependency" | "monitor";
    actorRef?: string;
    actorCompanyId: string;
    actionCapability?: string;
    triggerRef: string;
  };
  fromStatus: AuthoritativeIssueStatus;
  toStatus: AuthoritativeIssueStatus;
  transitionApplied: boolean;
  reasonCode: StatusDecisionReasonCode;
  sideEffects: Array<{
    kind:
      | "enqueue_continuation"
      | "schedule_retry"
      | "create_delegated_issue"
      | "create_interaction"
      | "bind_reviewer"
      | "bind_blocker"
      | "notify_owner"
      | "record_finalization_error"
      | "release_checkout";
    ref?: string;
  }>;
  inputDigest: string;
  inputRefs: {
    structuredResultRef?: string;
    completionContractRevision: string;
    priorDecisionId?: string;
  };
  policyVersion: string;
  decidedAt: string;
  supersedesDecisionId?: string;
}
```

`StatusDecisionReasonCode` is a stable protocol enum. The minimum set is:

```text
completion_contract_satisfied
completion_claim_policy_accepted
completion_evidence_incomplete
completion_review_required
governed_gate_pending
live_continuation_registered
turn_waiting_other_track_live
task_wide_blocker_bound
attention_resolved_from_context
attention_routed_to_agent
attention_requires_human_authority
attention_duplicate_suppressed
attention_budget_exhausted
run_failed_partial_evidence_preserved
finalization_failed_claim_preserved
cancellation_turn_only
cancellation_run_only
cancellation_issue_authorized
prior_status_preserved_no_live_path
authorized_resume
dependency_resolved
decision_superseded_by_new_evidence
result_schema_rejected
```

The complete arbitration table is normative. “Preserve” means that the current issue status remains unchanged.

| ID | Case | Authority and required inputs | Authoritative decision | Required atomic side effects and liveness | Reason code |
|---|---|---|---|---|---|
| SD-01 | Run succeeded; contract mechanically satisfied | Arbiter; accepted current-revision evidence, required artifacts, no missing criteria, no pending gate, no remaining completion work | `done` | Persist assessment/decision, compact handoff, release checkout | `completion_contract_satisfied` |
| SD-02 | Run succeeded; low-risk agent claims done under explicit policy | Arbiter; current claim, policy permits agent authority, no contradictory evidence or pending gate | `done` | Persist policy basis and evidence classifications, release checkout | `completion_claim_policy_accepted` |
| SD-03 | Run succeeded; agent claims done but required evidence or criteria are incomplete | Arbiter; completion claim plus missing/rejected/unverifiable requirements | `in_progress` only when a live path is created; otherwise preserve | Register continuation/retry/delegated verification; if none can be created, record finalization error and preserve status | `completion_evidence_incomplete` |
| SD-04 | Run succeeded; completion requires subjective, Security, QA, CTO, board, or governed review | Arbiter; contract gate or risk policy and a real review target | `in_review` | Atomically bind reviewer, approval, interaction, delegated review issue, or monitor that wakes the assignee | `completion_review_required` or `governed_gate_pending` |
| SD-05 | Structured result is invalid, stale, cross-boundary, or remains uncorrected after the bounded correction policy | Runner/finalizer + arbiter; rejected result, binding/schema failure, runtime facts, safely parsed evidence | Preserve | Persist the rejected input and reason, terminalize the run from runtime facts, and atomically create a bounded correction/recovery path when policy permits; never infer `in_review`, `blocked`, or `done` from rejection | `result_schema_rejected` |
| SD-06 | Run succeeded; agent reports yielded and continuation is valid | Arbiter; declared continuation with valid target/idempotency and policy budget | `in_progress` | Atomically enqueue continuation, retry, delegated issue, response wake, or monitor | `live_continuation_registered` |
| SD-07 | Current turn waits for an answer, but another productive track exists | Attention resolver + arbiter; `scope: current_turn` or `current_track`, alternate track and continuation | `in_progress` | Persist/route attention and enqueue alternate productive track; do not create task-wide blocker | `turn_waiting_other_track_live` |
| SD-08 | A task-wide blocker prevents all productive progress | Arbiter; blocker `scope: task_wide`, concrete owner, unblock action, evidence, no alternate live track | `blocked` | Atomically bind blocker issue or named owner/action and wake/notify route | `task_wide_blocker_bound` |
| SD-09 | Agent asks a question answerable from durable context or policy | Attention resolver; context hit bound to request and current revision | `in_progress` only when a response wake is registered; otherwise preserve | Record answer, resolve request, wake current turn/assignee as requested | `attention_resolved_from_context` |
| SD-10 | Agent asks for expertise another in-company agent can supply | Attention resolver; capability match, company scope, delegation policy | `in_progress` only when delegation creates a live response path; otherwise preserve | Route request or create delegated issue with response binding and wake path | `attention_routed_to_agent` |
| SD-11 | Agent asks for human help and only human/board authority or intentional judgment can resolve it | Attention resolver + arbiter; authority match, company scope, dedupe/budget checks | `in_review` only for contract review; otherwise `in_progress` only with a response wake; otherwise preserve | Create board interaction/approval and required wake atomically; `scope: current_turn` alone does not set status | `attention_requires_human_authority` |
| SD-12 | Duplicate or repeated attention request has no new evidence | Attention resolver; same dedupe key or superseded request, no material evidence delta | Preserve | Link duplicate to canonical request; do not notify or create another interaction | `attention_duplicate_suppressed` |
| SD-13 | Attention retry/escalation budget is exhausted with no valid resolver | Arbiter; attempt history and failed capability routing | Preserve | Record finalization error and named recovery owner/action; never manufacture `blocked` or `in_review` | `attention_budget_exhausted` |
| SD-14 | Run fails after producing partial work or evidence | Runner/finalizer + arbiter; failed run facts and safely persisted result/evidence | Preserve | Persist claims/evidence, apply retry/recovery policy, schedule live path when allowed | `run_failed_partial_evidence_preserved` |
| SD-15 | Model reports completion but transport, workspace, or finalization later fails | Runner/finalizer + arbiter; accepted completion claim plus finalization failure | Preserve | Persist claim and evidence, mark run failed, open/schedule reconciliation; never mark done | `finalization_failed_claim_preserved` |
| SD-16 | Cancellation targets only the active turn | Cancellation authority; authenticated command with `scope: turn` | Preserve | Terminalize turn `cancelled`; continue or await replacement turn according to run policy | `cancellation_turn_only` |
| SD-17 | Cancellation targets the run, not the issue | Cancellation authority; authenticated command with `scope: run` | Preserve | Terminalize run `cancelled`, release runtime resources, keep issue available for resume | `cancellation_run_only` |
| SD-18 | Cancellation explicitly targets the issue | Board or otherwise authorized issue-status actor; authenticated command with `scope: issue` | `cancelled` | Cancel active turn/run, record issue transition, release checkout and continuations | `cancellation_issue_authorized` |
| SD-19 | Later evidence, dependency resolution, interaction response, or authorized resume changes the facts | Arbiter; new assessment, prior decision, authorized trigger | Re-evaluate to any legal status | Append superseding assessment/decision and create the required new liveness path | `decision_superseded_by_new_evidence`, `dependency_resolved`, or `authorized_resume` |

Every decision records the arbiter authority, exact input assessment, reason code, side effects, and policy version. An issue transition and its liveness side effects commit in one transaction. A failed side effect means the transition is not applied.

Human-needed is therefore an attention-routing result, not an agent-authored status. Human/board routing is valid only for human authority, governed approval, non-delegable credentials or external action, intentionally subjective judgment, or policy-required high-risk review. Context lookup, bounded self-recovery, safe retry, and qualified in-company delegation precede human escalation.

The following Security constraints are normative for the Local runner finalizer/status-arbiter design, the Durable recovery attention resolver, and their conformance tests:

1. **Server-derived company and resolver routing.** The source company comes from the authenticated run-to-issue binding. Caller-supplied company and target fields are untrusted suggestions: mismatches are rejected, agent/role/user targets resolve with company membership in the same scoped query, and external targets resolve only through a company-owned allowlisted integration. Cross-company failures have a generic, side-effect-free response.
2. **Policy-derived authority.** Requested capability, `requiredAuthority`, and target do not grant authority. Server policy derives the minimum gate from the canonical action and resource. Credential grants, governed approvals, destructive or irreversible external actions, and policy-required reviews cannot be downgraded through expertise routing. Recommendation, approval, and execution are distinct audited acts; tool approval binds exact canonical arguments and executes once.
3. **Server-canonical replay identity.** Caller IDs and dedupe keys are correlation hints, not the security boundary. The server fingerprints company, issue, run, turn, contract revision, request kind, normalized capability/action, effective target, and material payload. Identical retries return the canonical record; reused IDs with changed payload conflict; fresh-key equivalents consume the same policy budget. Responses bind to the current request version, selected resolver, company, and non-superseded state under lock, so stale responses are audit-only.
4. **Serialized arbitration.** The arbiter locks the issue/control row and compare-and-swaps current status plus prior decision/version in the same transaction that writes the assessment, decision, side effects, and outbox wake. One canonical decision exists per assessment/trigger. A conflict reloads authoritative facts and appends a superseding assessment; it never replays stale side effects. Downstream side-effect consumers remain idempotent.
5. **Tamper-evident input lineage.** Canonical serialization and a cryptographic digest cover the immutable completion-contract snapshot, structured result, criterion/evidence classifications, prior status and decision version, trigger identity/company/action capability, policy version, and planned side effects. Immutable references and supersession edges make accepted, rejected, duplicate, stale, and conflicting inputs reconstructable without retaining secrets.

#### 18.3.1 Canonical attention records

An `AttentionRequest` is an agent-authored candidate. The attention resolver first converts it to a server-owned record; no notification, delegation, interaction, retry, wake, or issue transition may be created directly from the candidate.

```ts
interface CanonicalAttentionRequest {
  schema: "paperclip.canonical-attention-request.v1";
  id: string;
  version: number;
  companyId: string;
  issueId: string;
  runId: string;
  turnId: string;
  completionContractRevision: string;

  classification:
    | "information"
    | "transient_recovery"
    | "expertise"
    | "credential"
    | "governed_action"
    | "subjective_judgment"
    | "external_action"
    | "policy_review";
  canonicalAction?: string;
  canonicalResourceRef?: string;
  requiredExpertise: string[];
  minimumAuthority:
    | "none"
    | "agent_recommendation"
    | "authorized_agent_action"
    | "board_user"
    | "governed_approval"
    | "external_system";
  effectiveTarget?: ResolverTarget;

  requestedScope: "current_turn" | "current_track" | "task_wide";
  effectiveScope: "current_turn" | "current_track" | "task_wide";
  blockingCurrentTurn: boolean;
  alternateTrackRef?: string;

  requestFingerprint: string;
  equivalenceFingerprint: string;
  callerRequestId?: string;
  callerDedupeKey?: string;
  materialEvidenceDigest: string;

  urgency: "normal" | "high";
  createdAt: string;
  expiresAt: string;
  state:
    | "pending"
    | "routed"
    | "resolved"
    | "expired"
    | "superseded"
    | "rejected"
    | "exhausted";
  selectedRoute?: "context" | "retry" | "agent" | "board" | "external" | "recovery";
  selectedResolver?: ResolverTarget;
  routeRef?: string;
  responsePolicy: AttentionRequest["responsePolicy"];
  policyVersion: string;
  supersedesRequestId?: string;
}

type AttentionResolutionReasonCode =
  | "attention_request_invalid"
  | "attention_cross_company_rejected"
  | "attention_agent_resolvable"
  | "attention_resolved_from_context"
  | "attention_retry_scheduled"
  | "attention_retry_succeeded"
  | "attention_routed_to_agent"
  | "attention_requires_human_authority"
  | "attention_duplicate_suppressed"
  | "attention_scope_narrowed"
  | "attention_budget_exhausted"
  | "attention_expired"
  | "attention_stale_response"
  | "attention_no_valid_route";

interface AttentionResolutionBudget {
  schema: "paperclip.attention-budget.v1";
  equivalenceFingerprint: string;
  contextPasses: number;
  transientRetries: number;
  distinctAgentResolvers: number;
  humanOrExternalRoutes: number;
  emittedWakes: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  policyVersion: string;
}
```

The resolver derives `companyId`, issue, run, turn, and contract revision from the authenticated run binding. It canonicalizes the requested action and resource before policy derives `minimumAuthority`. The candidate's `requiredAuthority`, target, company, and requested capability are hints for classification only. `requiredExpertise` answers _who can understand or recommend_; `minimumAuthority` answers _who may decide or act_. Expertise never satisfies an approval, credential, destructive external-action, separation-of-duties, or policy-review gate.

The source company is immutable. Agent, role, and board-user resolvers are selected by company-scoped membership queries. External systems must be company-owned, enabled, and allowlisted for the canonical action. A cross-company target, hidden resource, or mismatched run binding returns the same generic rejection, persists only security/audit telemetry permitted by policy, and creates no resolver-visible record or side effect.

#### 18.3.2 Validation and classification

Ingress runs in this order:

1. Resolve the authenticated run, issue, turn, company, and current completion-contract revision.
2. Validate schema/version, bounded text and choice sizes, timestamps, evidence ownership, and response policy. `expiresAt` must be in the future and within the policy maximum.
3. Canonicalize action, resource, material question/payload, requested capability, and target class. Reject ambiguous governed actions rather than treating them as ordinary questions.
4. Derive `classification`, `requiredExpertise`, and `minimumAuthority` from policy. A caller cannot lower the derived authority or widen resource scope.
5. Compute the exact request and equivalence fingerprints, then perform idempotency, duplicate, and budget checks under the attention-family lock.
6. Derive `effectiveScope` from runtime facts and live tracks. The candidate may be narrowed; it becomes `task_wide` only when all productive tracks are proven unavailable.
7. Persist the canonical request or return the existing canonical record before any resolution side effect runs.

Classification is deterministic for a policy version:

| Canonical need | Classification | Minimum route before any human wait |
|---|---|---|
| Fact already present in company/task state, documents, policy, prior bound responses, or tool output | `information` | Context lookup |
| Retry-safe transient provider, transport, tool, or workspace failure | `transient_recovery` | Bounded retry |
| Analysis, recommendation, or domain knowledge | `expertise` | Qualified in-company agent |
| Permission to reveal/use a credential | `credential` | Existing authorized secret/tool binding; otherwise credential owner |
| Approval, spend, security gate, irreversible action, or policy-controlled decision | `governed_action` | Exact governed approval path |
| Intentionally subjective choice assigned to a person | `subjective_judgment` | Named board/user interaction |
| Action in a third-party system | `external_action` | Authorized company integration or agent executor; human only when non-delegable |
| Completion ambiguity or risk that policy says must be reviewed | `policy_review` | Named reviewer/approval from the completion contract |

Validation failures never manufacture `blocked` or `in_review`. A schema-correct but unnecessary human request is accepted as an auditable candidate, reclassified, and resolved through context/retry/agent routing or rejected with `attention_agent_resolvable`; it is not sent to a human.

#### 18.3.3 Canonical identity, repeats, budgets, urgency, and expiry

The caller's `id` and `dedupeKey` provide correlation, not uniqueness or authority. The server computes two hashes using canonical serialization:

- `requestFingerprint` covers company, issue, run, turn, contract revision, classification, canonical action/resource, normalized capability, the company-validated effective target, scope, response policy, material question/payload, choices, and evidence digest. It identifies an exact request version.
- `equivalenceFingerprint` omits caller IDs, run/turn IDs, wording-only differences, urgency, and evidence ordering. It covers company, issue, contract revision, classification, canonical action/resource, normalized capability, material question/payload, and effective target class. It groups fresh-key or paraphrased repeats that seek the same outcome.

Exact retries return the canonical record. Reusing a caller request ID or dedupe key with a different request fingerprint returns `409 attention_identity_conflict`. An equivalent request with no material evidence or durable-state change is linked to the canonical request, emits `attention_duplicate_suppressed`, and creates no retry, notification, route, status decision, or wake. New evidence may create a new version in the same equivalence family; it does not reset the family budget. A changed completion-contract revision creates a new family but links the prior request as superseded.

V1 defaults are finite and policy-versioned per equivalence family:

| Budget | Default | Rule |
|---|---:|---|
| Context resolution | 1 pass per durable source-state fingerprint | Re-run only when a referenced document, policy, tool result, contract, or prior response version changes. |
| Transient retry | 2 retries | Exponential schedule, default 30 seconds then 2 minutes; only idempotent or compensatable actions qualify. |
| Agent resolvers | 2 distinct agents/roles | Do not cycle back to a failed resolver without material new evidence. |
| Human/external route | 1 pending route | At most one live interaction, approval, credential request, or external action for an equivalence family. |
| Resolution transitions | 6 total | Context hits do not consume a transition; every retry/delegation/escalation/fallback does. |
| Resolution wake | 1 per request version and state transition | Wake idempotency is `attention:<requestId>:<version>:<state>`. |

Equivalent fresh-key spam consumes these shared counters. Policy may lower the defaults for risk or cost, but cannot make them unbounded. Permission, validation, policy denial, cross-company, non-idempotent action, and missing-authority failures are never transient retries.

`high` urgency moves an eligible route ahead in its queue and uses shorter scheduling/expiry windows; it never skips validation, context lookup, company checks, separation of duties, budgets, or authority gates. Default expiry is 24 hours for `normal` and 4 hours for `high`, capped at 7 days by V1 policy. A policy-owned monitor may replace an expired credential/external wait with a new request version only after a durable state change or explicit authorized resume. Expiry otherwise resolves the request once, cancels its live route when safe, emits at most one fallback wake, and cannot recursively create an equivalent request.

#### 18.3.4 Ordered resolution pipeline

After canonical persistence, the resolver attempts routes in this strict order. A later stage is legal only when the prior applicable stages recorded why they could not resolve the request.

1. **Context.** Search the bound task envelope, current issue fields, ancestor/goal context, issue documents, completion contract, company policy, prior non-stale responses in the same equivalence family, and authoritative tool/runtime state. Every answer records source references and versions. Secret values are never copied into an attention response; the resolver may return only an authorized binding or a redacted instruction to use one.
2. **Self-recovery/retry.** Retry only a classified transient failure whose canonical action is idempotent or has a safe compensation. Persist attempt number, failure class, next-at, and idempotency key before dispatch. A successful retry resolves the request; exhaustion advances once to matching/delegation, not back to context unless durable state changed.
3. **Capability matching and delegation.** Select active, invokable, budget-eligible, same-company agents whose declared capabilities and durable history match `requiredExpertise`. Enforce issue/work-object access, assignment policy, workload, conflict-of-interest, separation-of-duties, and required action authority independently. Rank exact capability and authorized action match before org proximity. A recommendation-only expert may answer analysis but cannot approve or execute the action.
4. **Human/governed/external escalation.** Create a human-facing route only when `minimumAuthority` or classification proves one of: board/user authority; governed approval; non-delegable credential or external action; intentionally subjective judgment assigned to a human; or policy-required review. Use the exact existing primitive—approval for governed spend/policy/action, typed interaction for a question or judgment, named reviewer for completion review, credential owner flow, or allowlisted external action. Free-form comments are not response routes.
5. **Truthful fallback.** When every valid route is exhausted or no resolver exists, set the attention request to `exhausted`, persist attempt history and `attention_no_valid_route`, and ask the arbiter for a no-op/preserve decision. If policy can create an internal recovery action, it must atomically bind its owner and wake; otherwise record a finalization error and operational alert, release runtime resources safely, and preserve the prior issue status. Exhaustion alone never creates `blocked`, `in_review`, a human interaction, or another equivalent attention request.

Delegation chooses between a same-run response and a delegated issue. Same-run routing is allowed only when the responder can return through a durable addressed channel. Otherwise Paperclip creates/reuses one company-scoped delegated issue with the exact question, evidence refs, authority limit, response binding, and parent/goal/workspace context. If the source must wait, the dependency and response wake are part of the same transaction. Completing a delegated issue without a valid bound response does not resolve the attention request.

#### 18.3.5 Blocking scope and alternate productive tracks

The resolver and arbiter interpret scope as follows:

| Scope | What is stopped | Required status behavior |
|---|---|---|
| `current_turn` | Only the accepted provider turn cannot continue synchronously. | Persist/route the request. Resume that turn when supported or wake the assignee. Do not mark the issue blocked. |
| `current_track` | One named dependency chain or workstream cannot proceed. | Continue another declared productive track when one exists; keep `in_progress` only with its queued continuation. Do not create a task-wide blocker. |
| `task_wide` | Every completion-relevant track is unable to make productive progress. | `blocked` is legal only with evidence that no alternate track is live plus a concrete same-company owner/action or first-class blocker and its wake path. |

`blockingCurrentTurn` is observed by the runner and cannot be cleared by model assertion. Conversely, a model's `task_wide` request is only a claim. The arbiter inspects remaining work, active/queued continuations, delegated work, retryable actions, and independent acceptance criteria; if any productive track exists, it narrows effective scope and emits `turn_waiting_other_track_live`. Switching tracks must not discard the waiting request or double-run the blocked track.

#### 18.3.6 Response binding and atomic wake behavior

Every response uses a server-issued binding:

```ts
interface AttentionResponseBinding {
  requestId: string;
  requestVersion: number;
  companyId: string;
  issueId: string;
  completionContractRevision: string;
  route: "context" | "retry" | "agent" | "board" | "external" | "recovery";
  resolverRef: string;
  canonicalAction?: string;
  canonicalResourceRef?: string;
  responseNonce: string;
}
```

Response handling locks the canonical request and issue control row, then verifies company, request/version, current contract, selected route and resolver, response nonce, current pending/routed state, non-expiry, and non-supersession. It also re-authorizes the resolver for the canonical action/resource at response time. Identical response retries return the stored resolution. A response from an old resolver, old request version, old contract, another company, an expired route, or a superseded request is stored as `stale_response` audit evidence and has no status, approval, execution, or wake side effect.

A recommendation response supplies information only. An approval authorizes only the bound action/resource and does not itself perform a distinct execution unless the governed tool contract explicitly binds exact canonical arguments for execute-once semantics. Credential responses bind an authorized secret/tool reference, never secret material. External-action responses include the provider's immutable operation/result reference.

The following commit as one transaction:

1. request state/version and accepted response;
2. route/interaction/approval/delegated-issue resolution;
3. new `WorkAssessment` and `StatusDecision` or explicit preserve/no-op;
4. issue transition, dependency, reviewer, or recovery binding when applicable;
5. exactly one continuation/wake outbox row with its idempotency key; and
6. immutable activity and reason-code records.

The transaction rolls back if any required liveness side effect cannot be created. Outbox delivery is retryable and idempotent; delivery failure cannot create a second semantic wake. A current-turn resume is attempted only when the same provider session still advertises resumability. Otherwise the bound wake starts a later turn with the response and supersession context. No accepted response may wake both paths.

#### 18.3.7 Weak-agent and adversarial scenario check

This matrix is the required Durable recovery design verification. Each row has a bounded terminal routing outcome and no infinite wake edge.

| ID | Scenario | Expected resolver outcome | Status/liveness assertion |
|---|---|---|---|
| ATT-01 | Agent asks a question already answered in the current document revision | Context response with versioned source refs | No human route; one response wake at most. |
| ATT-02 | Agent repeats the same question with the same key | Return canonical request | No new attempt, notification, status decision, or wake. |
| ATT-03 | Agent paraphrases the same question with fresh IDs | Match equivalence family and consume the shared budget | Duplicate suppressed; fresh keys cannot reset escalation. |
| ATT-04 | Agent requests a human for ordinary domain expertise | Reclassify to `expertise`; match an in-company agent | No human wait by default; delegation has a bound response path. |
| ATT-05 | Agent claims `task_wide` while an independent acceptance track is runnable | Narrow to `current_turn` or `current_track` and queue the alternate track | Issue remains truthfully `in_progress`; waiting track remains durable. |
| ATT-06 | Retry-safe tool call fails transiently, then succeeds | One bounded idempotent retry resolves it | No delegation or human route. |
| ATT-07 | Retry-safe failure exhausts two retries | Advance once to qualified agent/recovery or truthful fallback | No retry loop and no automatic human escalation without human authority. |
| ATT-08 | Agent labels a governed action as `requiredAuthority: none` | Policy derives the governed minimum authority | Exact approval route; expertise cannot downgrade it. |
| ATT-09 | Candidate names an agent, user, resource, or integration in another company | Generic side-effect-free rejection | No target disclosure, route, notification, or wake. |
| ATT-10 | Selected resolver changes or replies after supersession/expiry | Record stale response only | No issue transition, execution, or wake. |
| ATT-11 | Human interaction expires unanswered | Resolve expiry once; use policy fallback only with a durable new state or authorized resume | At most one fallback wake; no equivalent interaction recreation loop. |
| ATT-12 | No eligible agent, human authority, integration, or safe retry exists | Mark request exhausted and record finalization error/recovery alert | Preserve prior issue status; do not manufacture `blocked` or `in_review`. |

The implementation test plan must turn every row into a deterministic fixture that asserts canonical/equivalence identity, counters, selected route, effective scope, status decision reason, side effects, wake count, and stale-response behavior.

### 18.4 Mapping to Paperclip

The native runtime returns runtime facts, the original structured result or
host-authored interaction-yield receipt, and typed attention requests to the
finalization pipeline. Native mode requires the additive contract in section
18.5; it must not pass a native result through the legacy exit-code heuristic.

The ordered pipeline is:

1. Persist and deduplicate all P0 terminal, result, attention, and interaction events.
2. Validate run/session/company binding and the completion-contract revision.
3. Preserve the original result, claims, evidence, verification, artifacts, remaining work, attention candidates, and any host-authored interaction-yield receipt.
4. Finalize workspace and environment. Failure changes the run terminal state to `failed` but does not delete the report.
5. Record usage, cost, session, provider, model, billing, runtime-service, and process diagnostics.
6. Validate and reconcile any native interaction bridge receipt plus current pending/resolved interaction state; materialization already occurred at tool-call time and is never repeated by finalization. Never translate an interaction into a formal approval, execution-stage decision, or runtime permission request.
7. Resolve other attention through context, bounded retry, qualified delegation, human authority, or external routing.
8. Create `WorkAssessment` from runtime facts, evidence classification, governed gates, pending/resolved interactions, remaining work, attention routes, prior issue status, and live paths.
9. Ask the status arbiter for a `StatusDecision` using the table in section 18.3.
10. Commit the issue transition or no-op with all required liveness side effects atomically.
11. Create one compact durable handoff that links the reported disposition, authoritative decision, disagreement reason, evidence, and next owner.
12. Release checkout/lock according to the authoritative decision and continuation policy.

Atomic liveness requirements:

- `in_review` commits only with a named reviewer, approval, interaction, delegated review issue, or monitor that will produce a wake;
- `blocked` commits only with a task-wide blocker and named unblock owner/action or blocker issue;
- continued `in_progress` commits only with a queued continuation, retry, delegated child, response wake, or monitor;
- comments, evidence, work products, and remaining-work text are durable context but are not liveness paths by themselves.

Attention responses bind to the attention request ID, dedupe key, contract
revision, and selected resolver. Interaction responses bind to the interaction
ID, request ID, source binding, target revision, response cursor, selected
resolver, and non-superseded state. A response to an expired or superseded
request is retained for audit and cannot wake or change status unless the
arbiter creates a new assessment.

### 18.5 Complete terminal conversion contract

Five layers participate in native finalization:

- turn terminal state from the driver;
- run terminal state from the runner/finalizer;
- reported work disposition and evidence from the model or semantic tool;
- `AdapterExecutionResult` compatibility diagnostics;
- authoritative issue status from the status arbiter.

Only the arbiter owns issue status. Runtime-owned `failed` and `cancelled` are run terminal states, not model-facing work dispositions.

`AdapterExecutionResult` needs one additive, typed discriminator before native mode can ship:

```ts
interface NativeFinalizationResult {
  schema: "paperclip.native-finalization.v1";
  turnTerminalState: TurnTerminalState;
  runTerminalState: RunTerminalState;
  reportedWorkDisposition: ReportedWorkDisposition | null;
  completionContractRevision: string;
  structuredResultRef?: string;
  cancellationScope?: "turn" | "run" | "issue";
}

interface AdapterExecutionResult {
  // Existing fields stay unchanged.
  nativeFinalization?: NativeFinalizationResult;
}
```

Native adapters must set `nativeFinalization`. The heartbeat finalizer validates it against `resultJson` and persisted terminal events, derives the heartbeat run status from `runTerminalState`, and then submits a `WorkAssessment` to the arbiter. Compatibility fields are process diagnostics only.

| ID | Native facts | Compatibility fields | Required native behavior |
|---|---|---|---|
| TC-01 | Turn `completed`; run `succeeded`; reported disposition present | Usually `exitCode: 0`, `timedOut: false`; result in `resultJson` | Persist succeeded run and assess the report. No reported disposition maps directly to issue status. |
| TC-02 | Turn `failed`; run `failed`; partial result/evidence may exist | Nonzero exit when available; error metadata populated | Persist failed run, preserve partial claims/evidence, apply retry/recovery, preserve issue status unless a separate authorized decision applies. |
| TC-03 | Turn `completed`; run `failed` because workspace/transport/finalization failed after a report | Exit code may still be zero; finalization error identifies failure | Persist failed run and preserve the completion claim for reconciliation. Never mark the issue done. |
| TC-04 | Turn `interrupted`; run remains active or a replacement turn is accepted | No terminal adapter result yet | Terminalize only the turn; continue the same run/session. |
| TC-05 | Turn `interrupted`; run `succeeded` with valid `yielded` report and continuation | Usually `exitCode: 0` | Assess yielded work and atomically register continuation; interruption alone grants no issue transition. |
| TC-06 | Turn `cancelled`; run `cancelled`; scope `turn` or `run` | `exitCode: null`; cancellation diagnostics optional | Preserve issue status. Turn scope may permit replacement work; run scope releases run resources. |
| TC-07 | Turn/run `cancelled`; scope `issue` and actor is authorized | `exitCode: null`; cancellation command reference persisted | Arbiter applies issue `cancelled` and cancels continuations atomically. |
| TC-08 | Native finalization missing, inconsistent, stale, or invalid | Any compatibility values | Fail closed as `native_finalization_missing` or `native_finalization_invalid`; never use the legacy heuristic. Preserve safe evidence and create recovery. |

All compatibility results set `signal: null` unless the harness reported a real signal. They preserve usage, cost, session, provider, model, billing, and runtime-service fields without changing their meaning. `resultJson` contains the original structured result when one exists, plus references to the assessment and status decision after arbitration.

Legacy adapters are a separate compatibility mode. They omit `nativeFinalization` and retain the current exit-code heuristic and existing integration behavior. Legacy success may continue to feed the legacy finalizer, but it must not be documented or implemented as the native authority model. Native code must never fall back to legacy inference, and legacy code must not fabricate native `CompletionContract`, `WorkAssessment`, or `StatusDecision` records unless a later migration explicitly defines that behavior.

Native-mode enablement is gated on conformance tests for every row in sections 18.3 and 18.5. Each test proves turn terminal state, persisted run status, preserved report/evidence, authoritative issue status, reason code, side effects, liveness path, cancellation scope, and supersession behavior.

### 18.6 Local runner service boundaries and ownership

Native finalization is a control-plane workflow with one status authority. It is not an adapter callback that performs a collection of best-effort issue mutations. The implementation uses the following boundaries:

| Component | Owns | May read | Must not do |
|---|---|---|---|
| `CompletionContractService` | Materializing and retrieving immutable, company-scoped contract revisions | Issue, acceptance criteria, required work products, execution/review policy, governed gates | Infer completion or edit a contract revision after a run has bound to it |
| `NativeResultIngestor` | Authenticating the runner lease, validating run/turn/issue binding, canonicalizing the report, preserving accepted and rejected claims | P0 events, runner lease, contract reference, persisted evidence records | Trust caller company IDs, accept caller fingerprints as authoritative, set run or issue status |
| `NativeRunFinalizer` | Runtime and workspace terminal facts; exactly-once workspace finalization; run terminal state | Persisted result, runtime diagnostics, workspace operations | Decide semantic completion or mutate issue status |
| `EvidenceClassifier` | Classifying each criterion/evidence reference as accepted, missing, rejected, or unverifiable from authoritative records | Immutable contract/result snapshots, tests, work products, approvals, external checks | Treat a model-authored `passed` field as mechanical proof |
| `AttentionResolver` | Producing durable routing facts and liveness proposals | Current attention request, policy, company-scoped resolver inventory | Grant status authority or lower a policy-derived authority gate; Durable recovery owns its detailed routing algorithm |
| `WorkAssessmentService` | Building one immutable assessment from canonical facts | Finalized run facts, contract/result, classifications, gates, attention routes, prior issue snapshot | Apply an issue transition |
| `StatusArbiter` | Pure, versioned decision from an assessment and policy | Immutable assessment plus legal transition policy | Perform I/O, use wall-clock time not supplied as an input, or inspect mutable state not captured in the assessment |
| `StatusDecisionCommitter` | Serialized compare-and-swap, legal transition, durable side effects, audit/outbox commit | Proposed decision and freshly locked issue/control rows | Re-decide on stale inputs or publish an effect before commit |
| `NativeFinalizationReconciler` | Lease recovery, retry, stale-CAS reload, and superseding assessment creation | Incomplete finalization rows and authoritative current state | Re-run a committed effect or overwrite an assessment/decision |

`NativeRunFinalizer` calls the classifier, assessment service, arbiter, and committer through a server-internal interface. There is no public “set arbiter result” API. The runner can submit runtime facts and an advisory report only. The status arbiter is the sole writer of native-mode issue status; existing board/user status routes remain separately authorized organizational commands and become triggers for a later assessment when they race native finalization.

The existing heartbeat service remains the orchestration entry point during migration, but native logic moves behind these services. `server/src/services/heartbeat.ts` selects the native path only when the persisted run profile and adapter result both identify native mode. It cannot select the path from a model-authored field inside `resultJson`.

### 18.7 Persistence model

Local runner adds immutable source records and a small mutable coordinator. JSON snapshots preserve the exact protocol payload; indexed scalar columns enforce company scope, ordering, idempotency, and reconciliation.

#### Completion contracts

`completion_contracts` stores one immutable contract revision:

```text
id uuid primary key
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
revision integer not null
schema_version text not null
policy_version text not null
risk text not null
completion_authority text not null
incomplete_criteria_policy text not null
contract_json jsonb not null
canonical_sha256 text not null
created_by_actor_type text not null
created_by_actor_id text null
created_at timestamptz not null
supersedes_contract_id uuid null references completion_contracts
unique (company_id, issue_id, revision)
unique (company_id, id)
```

Contract creation validates criterion IDs, criterion-level authority ceilings, gate targets, and company ownership before canonicalization. A run stores `completion_contract_id` and `completion_contract_sha256` when its task envelope is created. Updating an issue creates a new revision; it never mutates the revision used by an active or historical run. A stale result remains bound to its original contract and is reconciled against the new revision explicitly.

Criteria remain in `contract_json` for the first implementation because arbitration always reads the immutable snapshot as a unit. A later read-optimized projection may normalize them, but it cannot replace the snapshot used for digest verification.

#### Preserved structured results

`native_run_results` is the append-only boundary between caller claims and authoritative assessment:

```text
id uuid primary key
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
run_id uuid not null references heartbeat_runs on delete cascade
turn_id text not null
completion_contract_id uuid not null references completion_contracts
caller_result_id text null
caller_dedupe_key text null
server_fingerprint text not null
schema_status text not null                 -- accepted | rejected | partial
rejection_code text null
result_json jsonb not null                  -- original safe payload, never rewritten
canonical_sha256 text not null
created_at timestamptz not null
unique (company_id, run_id, turn_id, server_fingerprint)
unique (company_id, id)
```

If a caller reuses `caller_result_id` or `caller_dedupe_key` with different canonical material, ingestion records `structured_result_replay_conflict` and does not create effects. Equivalent retries with fresh caller keys resolve to the same `server_fingerprint` and return the canonical row. Safely parsed evidence and the original completion claim are retained even when `schema_status` is `rejected` or later assessment downgrades the claim.

#### Finalization coordinator

`native_run_finalizations` is one mutable, row-locked coordinator per native run:

```text
run_id uuid primary key references heartbeat_runs on delete cascade
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
phase text not null                       -- observed | workspace_finalizing |
                                           -- ready_for_assessment | arbitrating |
                                           -- committed | retryable_failure | terminal_failure
attempt integer not null default 0
lease_owner text null
lease_expires_at timestamptz null
result_id uuid null references native_run_results
assessment_id uuid null references work_assessments
decision_id uuid null references status_decisions
failure_code text null
failure_detail jsonb null                  -- redacted, non-secret diagnostics
next_attempt_at timestamptz null
created_at timestamptz not null
updated_at timestamptz not null
unique (company_id, run_id)
```

The coordinator is not the audit record. A reconciler may update its lease, phase, attempt, and error fields, but committed result, assessment, and decision rows remain immutable. A crashed worker resumes from the first missing durable phase. It never repeats workspace finalization after the existing workspace-operation idempotency record says it completed.

#### Assessments and decisions

`work_assessments` stores all decision inputs as an immutable snapshot:

```text
id uuid primary key
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
run_id uuid null references heartbeat_runs on delete set null
turn_id text null
contract_id uuid not null references completion_contracts
result_id uuid null references native_run_results
trigger_kind text not null
trigger_ref text not null
trigger_capability text null
trigger_actor_company_id uuid not null references companies
prior_issue_status text not null
prior_status_version bigint not null
prior_decision_id uuid null
policy_version text not null
assessment_json jsonb not null
input_digest text not null
supersedes_assessment_id uuid null references work_assessments
created_at timestamptz not null
unique (company_id, issue_id, input_digest)
unique (company_id, id)
```

`assessment_json` contains runtime facts, criterion classifications, accepted/missing/rejected/unverifiable evidence, pending governed gates, remaining work, attention routes, live paths, and redacted finalization diagnostics. `input_digest` is SHA-256 over the canonical serialization defined in section 18.8.

`status_decisions` records the pure arbiter output and its application state:

```text
id uuid primary key
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
assessment_id uuid not null references work_assessments
decision_version bigint not null
policy_version text not null
from_status text not null
to_status text not null
reason_code text not null
decision_json jsonb not null
decision_digest text not null
application_state text not null             -- proposed | applied | superseded | rejected
supersedes_decision_id uuid null references status_decisions
applied_at timestamptz null
created_at timestamptz not null
unique (company_id, issue_id, decision_version)
unique (company_id, assessment_id)
unique (company_id, issue_id, decision_digest)
```

`status_decision_effects` is the durable transactional outbox and effect ledger:

```text
id uuid primary key
company_id uuid not null references companies
issue_id uuid not null references issues on delete cascade
decision_id uuid not null references status_decisions on delete cascade
ordinal integer not null
effect_kind text not null
target_type text not null
target_id text null
idempotency_key text not null
payload jsonb not null
delivery_state text not null default 'pending' -- pending | delivered | failed | cancelled
attempt_count integer not null default 0
next_attempt_at timestamptz null
last_error text null
delivered_at timestamptz null
created_at timestamptz not null
updated_at timestamptz not null
unique (company_id, idempotency_key)
unique (decision_id, ordinal)
```

Effects that are themselves durable domain rows—blocker relations, interactions, approvals, recovery actions, delegated issues, monitor state, and queued `agent_wakeup_requests`—are inserted or updated in the same transaction. `status_decision_effects` records their canonical identity and carries only delivery work that must happen after commit, such as websocket publication or an external integration notification. Consumers acknowledge by `idempotency_key`; at-least-once delivery cannot duplicate the underlying domain action.

The `issues` table adds:

```text
status_version bigint not null default 0
last_status_decision_id uuid null
```

Every authoritative status mutation, including separately authorized board/user mutations, increments `status_version`. Native arbitration compares `status`, `status_version`, and `last_status_decision_id` after locking the issue. Existing `checkout_run_id`, `execution_run_id`, execution lock fields, `unblock_descriptor`, blocker relations, execution state, monitor fields, and terminal timestamps remain the operational projections; the decision record explains why they changed.

`heartbeat_runs.result_json` remains a compatibility/read projection and receives only IDs plus a compact native summary. It is not the source of truth for contracts, original reports, assessments, or decisions.

### 18.8 Canonical identity, deterministic replay, and lineage

Canonical serialization is UTF-8 JSON with recursively sorted object keys, arrays retained in protocol-defined order, timestamps normalized to UTC RFC 3339 with millisecond precision, UUIDs lower-cased, absent optional values omitted, and numbers serialized in the protocol's bounded integer/decimal form. Arbitrary prose is preserved byte-for-byte after schema normalization; no locale-sensitive or Unicode compatibility folding is applied to evidence text.

The server computes these identities:

```text
resultFingerprint = SHA256(
  companyId, issueId, runId, turnId, contractId, contractSha256,
  resultKind, normalizedMaterialResultPayload
)

assessmentInputDigest = SHA256(
  immutableContractSnapshot, immutableStructuredResultOrRejection,
  authoritativeRuntimeAndWorkspaceFacts, criterionEvidenceClassifications,
  priorIssueStatus, priorStatusVersion, priorDecisionId,
  triggerKind, triggerRef, triggerActorCompanyId, triggerCapability,
  policyVersion, plannedLivenessInputs
)

decisionDigest = SHA256(
  assessmentInputDigest, arbiterAlgorithmVersion, fromStatus, toStatus,
  reasonCode, canonicalPlannedEffects
)
```

Secrets, credentials, raw approval tokens, and unredacted tool arguments never enter a stored digest payload. Their immutable server-owned resource ID and a resource-version/content digest enter instead. Tool approvals retain the existing exact-argument signature in the tool gateway and expose only its non-secret digest to arbitration.

Determinism means that the same canonical assessment inputs and policy version produce the same `decisionDigest`, transition/no-op, reason code, and ordered effect plan. A policy version resolves an immutable policy bundle that includes the arbiter algorithm version; changing the algorithm requires a new policy version. Database-generated IDs and current time are allocated after the pure decision; they cannot influence it. Effect order is a fixed enum order, not object iteration order.

A replay first looks up `(company_id, issue_id, input_digest)` and then the decision. If it exists, the server returns the canonical assessment/decision and dispatches only undelivered effect rows. If the issue snapshot has changed, the old decision is not replayed: the reconciler captures the new facts in a new assessment with `supersedes_assessment_id`, and the new decision names `supersedes_decision_id`. Supersession never deletes or mutates the original result, assessment, decision, or delivered-effect record.

The minimum Local runner reason-code additions are:

```text
native_finalization_missing
native_finalization_invalid
structured_result_replay_conflict
contract_revision_stale
prior_status_terminal_preserved
illegal_transition_rejected
arbitration_conflict_reloaded
side_effect_planning_failed
finalization_retry_exhausted
```

`native_finalization_missing`, `native_finalization_invalid`, `structured_result_replay_conflict`, `side_effect_planning_failed`, and `finalization_retry_exhausted` are also valid `failure_code` values on the coordinator. They do not authorize an issue transition. `arbitration_conflict_reloaded` is recorded on the superseding assessment; its eventual status decision uses the reason for the newly evaluated facts. A terminal issue is preserved unless the trigger carries an explicit capability for a legal terminal transition, such as authorized issue cancellation; late runner results cannot reopen it.

### 18.9 Serialized arbitration and atomic side effects

The committer executes this algorithm in one database transaction:

1. Lock `native_run_finalizations` when the trigger is run finalization, then lock the issue row with `SELECT ... FOR UPDATE`.
2. Resolve the issue company from the locked issue and verify that the run, contract, result, assessment trigger, resolver targets, and effect targets all share it. A mismatch fails generically before any target-specific read is exposed.
3. Compare locked `status`, `status_version`, and `last_status_decision_id` with the assessment snapshot.
4. On mismatch, write no decision or domain effect. Mark the coordinator for reconciliation and return a conflict that causes a new superseding assessment from reloaded facts.
5. Run the pure arbiter and validate the proposed transition against the legal issue-state machine and terminal-state rules.
6. Materialize and validate the complete ordered effect plan. Policy derives required authority and effective resolver; caller suggestions cannot reduce it.
7. If any required liveness effect cannot be created, replace the proposal with a preserve-status finalization failure. Never commit a waiting status first and repair its liveness later.
8. Insert assessment and decision, apply the issue projection and timestamps, increment `status_version`, create/update all durable domain side effects, insert effect-ledger/outbox rows, append activity, and advance the coordinator to `committed`.
9. Commit. Only after commit may workers publish websocket events, deliver external notifications, or claim queued wakeups.

The issue transition, checkout release, and liveness path are therefore indivisible. A database rollback leaves the prior issue projection intact and exposes no wake. A post-commit delivery failure leaves `status_decision_effects.delivery_state = 'pending'` or `failed` for retry; it does not roll back or duplicate the committed decision.

The legal effect plan by outcome is:

| Decision | Required in-transaction projection and domain effects | Post-commit effects |
|---|---|---|
| `done` | Set status/completion time; clear execution lock and checkout; close or cancel obsolete continuations; persist handoff reference; record dependency-wake candidates only after workspace finalization is successful | Publish issue/run updates; dispatch idempotent dependency wakes and summary generation |
| `in_review` | Set status; create or bind exactly one named reviewer path, execution-policy stage, governed approval, interaction, delegated review issue, or monitor; store return owner/wake policy; clear completed run lock | Notify the selected resolver and publish review state |
| `blocked` | Set status/blocked time; create company-scoped blocker relation or `unblock_descriptor` with concrete owner and action; prove no alternate productive track; create owner notification/wake intent; clear completed run lock | Notify unblock owner; dependency resolution later triggers a fresh assessment |
| continued `in_progress` | Keep/set status; clear the completed run lock; create exactly one canonical queued continuation, bounded retry, delegated child, response wake, or monitor; increment the applicable attempt budget | Claim/dispatch the queued continuation and publish liveness state |
| preserve after failed finalization | Do not change issue status/version; mark run/coordinator failed; preserve result/evidence; create a company-scoped recovery action or bounded reconciliation wake when policy permits | Retry finalization/reconciliation; surface operator diagnostic after budget exhaustion |
| turn cancellation | Terminalize the turn only; preserve run/issue; record replacement-turn or wait policy if needed | Continue or accept a replacement turn |
| run cancellation | Terminalize run and release runtime/execution lock; preserve issue; create a resume path only when cancellation policy authorizes one | Tear down resources; optionally dispatch resume |
| issue cancellation | Verify board/authorized issue capability; set issue `cancelled`/timestamp; cancel active turn/run, queued continuations, pending native attention, and non-independent monitors; release checkout/lock | Publish cancellation and deliver idempotent cancellation notifications |

“Exactly one” above means one canonical liveness identity, not necessarily one physical row: a delegated issue may also enqueue the response wake that is defined as part of the same path. The ordered effect plan declares this composition, and all components use keys derived from `decision_id`, effect kind, target, and ordinal.

Status effects are fail-closed. In particular:

- failure to create a reviewer path preserves the prior status and records `side_effect_planning_failed`; it does not leave `in_review` without a reviewer;
- failure to persist a blocker relation/owner preserves the prior status; it does not use a comment as the blocker;
- failure to enqueue a continuation preserves the prior status and records a recovery action; it does not strand `in_progress`;
- failure to finalize the workspace makes the run `failed`, preserves completion claims, and prevents `done`;
- failure to publish a committed outbox effect is retryable and cannot cause a second status decision.

### 18.10 Disconnect recovery, reconciliation, and races

The server may disconnect at any point without losing the report or applying an ambiguous status:

| Last durable phase | Recovery action |
|---|---|
| Terminal event received, no result row | Resume event ingestion by server sequence; request retransmit when the runner lease is live; otherwise record missing/invalid finalization and recovery |
| Result preserved, workspace not finalized | Resume the existing idempotent workspace operation; never reassess completion first |
| Workspace finalized, no assessment | Rebuild the assessment from immutable result/contract and authoritative persisted facts |
| Assessment stored, no decision | Re-run the pure arbiter with the stored policy/algorithm version |
| Proposed decision, transaction not committed | Re-enter the CAS transaction; an absent applied decision/effects means no issue mutation occurred |
| Decision committed, delivery pending | Dispatch only pending effect-ledger rows; do not re-arbitrate |
| Issue changed concurrently | Reload, append a superseding assessment/decision, and cancel only still-pending stale effects |

The coordinator lease is time-bounded and claimed with `FOR UPDATE SKIP LOCKED`. Startup reconciliation and a periodic worker scan `retryable_failure`, expired leases, and non-committed phases by `(next_attempt_at, updated_at)`. Retry budgets are policy-owned. Exhaustion records `finalization_retry_exhausted`, retains all claims/evidence, creates a named recovery action, and preserves issue status.

Concurrency cases use the same serialization point:

- **two finalizers:** one commits; the second finds the canonical input/decision or creates no new effect;
- **finalizer versus board cancellation:** whichever locks first commits. The loser reloads; a late result is preserved but cannot reopen a cancelled issue;
- **finalizer versus dependency/interaction response:** the loser creates a superseding assessment containing the new resolved fact;
- **lost acknowledgement:** the retry returns the canonical assessment/decision and dispatches only pending effects;
- **caller ID/key mutation:** canonical fingerprinting collapses equivalent material and conflicts on changed material;
- **stale contract response:** retained for audit, assessed as stale, and never applied to the newer contract without reconciliation;
- **superseded response:** retained as audit-only; no wake or status effect is emitted from it.

### 18.11 API, shared-contract, UI, and implementation change map

Native finalization uses server-internal commands; board/agent APIs expose read models, not arbiter authority.

Read/API additions:

- `GET /api/issues/:issueId/completion-contracts/current` and `/completion-contracts` return company-authorized current/history summaries;
- `GET /api/issues/:issueId/status-decisions` returns assessment/decision summaries, disagreement reasons, supersession, and liveness references with sensitive payloads redacted;
- `GET /api/heartbeat-runs/:runId/finalization` returns turn/run facts, coordinator phase, preserved result reference, assessment, decision, and retry-safe failure details;
- `GET /api/issues/:issueId/attention-requests` and `/attention-requests/:requestId` return canonical attention records with owner, derived authority, effective scope, attempt history, expiry, duplicate state, and response binding; suppressed duplicates never appear as top-level records;
- existing issue and heartbeat-run responses gain compact `reportedWorkDisposition`, `latestStatusDecision`, and `nativeFinalization` summaries;
- runner ingestion uses the authenticated native runner/session channel and its bound run/turn. No public request body may select `companyId`, prior status, policy version, effective resolver, reason code, or authoritative transition.

Mutation/API behavior:

- existing board/user issue-status routes continue to enforce their current permissions and execution-policy rules, increment `status_version`, and enqueue reconciliation when a native finalization is active;
- agent API keys cannot call an arbiter-application endpoint;
- read routes authorize through the parent issue/run company and return generic not-found/denial behavior across companies;
- activity and websocket payloads carry decision IDs and reason codes, not unredacted evidence, secrets, or tool arguments.

Implementation-ready file map:

| Layer | Changes |
|---|---|
| DB | Add `completion_contracts.ts`, `native_run_results.ts`, `native_run_finalizations.ts`, `work_assessments.ts`, `status_decisions.ts`, and `status_decision_effects.ts` under `packages/db/src/schema/`; export them from `schema/index.ts`; add `issues.status_version`/`last_status_decision_id` and run contract/finalization references; generate a migration with company/issue/run indexes and the unique keys above. Do not overload `issue_execution_decisions`, which records participant verdicts rather than arbiter decisions. |
| Shared | Add native completion/finalization/assessment/decision types and stable enums under `packages/shared/src/types/`; add strict Zod validators under `packages/shared/src/validators/`; export canonical event/reason/failure codes from constants. Keep wire inputs separate from server-derived fields. |
| Adapter boundary | Extend `packages/adapter-utils/src/types.ts` with `nativeFinalization?: NativeFinalizationResult`. Native runner adapters populate it; existing adapters omit it and remain legacy. Validate the discriminator again at the server boundary. |
| Runner protocol | Add the result/terminal messages and canonical binding fields to `packages/native-runtime-protocol`; make P0 event sequencing persist before acknowledgement; ensure the runner never receives an agent API key or status mutation capability. |
| Server services | Add `completion-contracts.ts`, `native-result-ingestion.ts`, `native-run-finalizer.ts`, `work-assessments.ts`, `status-arbiter.ts`, `status-decision-committer.ts`, and `native-finalization-reconciler.ts`. Reuse existing workspace-operation idempotency, issue-transition helpers, interaction/approval services, recovery actions, wakeup requests, activity log, and live updates through transaction-aware entry points. |
| Heartbeat integration | In `server/src/services/heartbeat.ts`, replace the native-mode exit-code outcome branch and the later sequence of independent issue liveness handlers with the coordinator. Keep usage/cost/session/runtime diagnostics and the legacy branch intact. Workspace finalization completes before native run success and arbitration. |
| Routes/OpenAPI | Add company-authorized read routes in `server/src/routes/issues.ts` and `server/src/routes/agents.ts`; document them in `server/src/routes/openapi.ts`. Native ingestion stays on the runner transport/internal service boundary. |
| UI API | Add read types/fetchers in `ui/src/api/issues.ts` and `ui/src/api/heartbeats.ts`; invalidate issue, run, assessment, and decision queries from the existing live-update provider. |
| UI surfaces | Operator contract renders run outcome separately from issue status, the agent claim separately from the arbiter decision, reason/evidence classification, supersession history, finalization failure, and the concrete current liveness owner/path. This phase supplies data contracts only; the approved operator UX for these surfaces is [`paperclip-runner-status-attention-ux.md`](./paperclip-runner-status-attention-ux.md), and the read models above MUST carry every field that design renders (turn/run/claim/decision layers, criterion assessments, side-effect links, attention owner/authority/scope/attempts/expiry, resume consequence, supersession chain). Section 18.12 is the normative binding of those two documents: view types, read routes, derivation rules, component data contracts, and release gates. |
| CLI/MCP | Expose read-only finalization/decision inspection if operator parity requires it. Do not expose status-decision creation or arbitrary replay inputs. |

Migration and rollout sequence:

1. Add tables, columns, shared types, and read models behind a disabled native-finalization feature flag.
2. Initialize `issues.status_version = 0`; do not synthesize historical `CompletionContract`, `WorkAssessment`, or `StatusDecision` rows for legacy runs.
3. Make every existing authorized issue-status mutation increment `status_version` before enabling native arbitration.
4. Ship contract materialization and result preservation in shadow mode. Compute assessments/decisions, but compare them with existing behavior without applying status effects.
5. Run deterministic replay, race, cross-company, forged-authority, fresh-key spam, stale-contract, superseded-response, digest-mutation, and finalization-disconnect conformance fixtures.
6. Enable native application per company/adapter profile. A native-marked run fails closed if its finalization discriminator or contract binding is absent; it never falls back to the legacy heuristic.
7. Keep legacy adapters on the existing finalizer until an explicit, separately reviewed migration defines their completion contract. Native and legacy metrics remain labeled separately.

Structural consistency gate before implementation handoff:

- every persisted DB field has a shared read type and validator ownership;
- every server-derived authority/tenant/digest field is absent from caller-writable schemas;
- every non-terminal decision row names a durable liveness entity created in the same transaction;
- every public read is authorized from the source issue/run company;
- every UI state can distinguish runtime terminal state, reported work disposition, authoritative issue status, and failed/pending finalization;
- every native side effect has a server-derived idempotency key and a conformance assertion proving at-most-one domain effect under retry.

It does not create an issue comment for every tool call or token delta.

### 18.12 Operator and reviewer read models and presentation contract

Sections 18.3–18.11 define what Paperclip decides. The approved operator
design in
[`paperclip-runner-status-attention-ux.md`](./paperclip-runner-status-attention-ux.md)
defines how that decision must read on screen. This section is the binding
contract between them and is normative for the read routes, the view types, the
client derivation rules, the component data requirements, and the release gates
of section 18.3 Operator contract. Phase-numbering note: this is Operator contract of the status
authority track (PAP-16713). It is unrelated to the Operator contract driver milestone in
the implementation plan and to the interaction-bridge gates in section 27.9.1.

Two rules govern everything below.

1. **The server ships facts and codes; the UI ships language.** Every
   authoritative value crosses the wire as a stable enum, identifier, integer,
   or timestamp. Operator sentences are composed on the client from those codes.
   The server never sends a rendered status sentence, and the UI never invents a
   fact that has no field.
2. **Presentation never re-derives authority.** Eligibility to respond, resolver
   selection, minimum authority, effective scope, resumability, and duplicate
   status are computed server-side and read as booleans/enums. A client that
   loses those fields degrades to read-only (section 18.12.12); it never guesses.

#### 18.12.1 Operator presentation invariants

These are enforceable review and test criteria, referenced as `[OPX-n]`
throughout this section and in section 18.12.13.

| ID | Invariant | Failure it prevents |
|---|---|---|
| OPX-1 | Every finalized native run renders turn outcome, run outcome, agent claim, and authoritative issue status as four separately labeled values in the default (unexpanded) view. | The single-badge collapse that lets process success read as work completion. |
| OPX-2 | The agent claim is always attributed, past-tense, and visually non-authoritative (dashed outline + quote glyph, never a filled status color). The composed strings "agent succeeded", "agent failed", and "agent completed" never appear in copy constants or fixtures. | An unverified model claim reading as an organizational fact. |
| OPX-3 | Any decision whose `toStatus` is non-terminal renders at least one named live path with an owner and a link. If the server reports no live path and no finalization error, the UI renders the recovery treatment, never a silent waiting state. | Invisible dead tasks that appear to be "in progress". |
| OPX-4 | A board-routed attention card renders owner, derived authority, effective scope, attempt/budget position, expiry, duplicate state, and the resume consequence *before* the response control. | Answering blind; not knowing what the button fires. |
| OPX-5 | Suppressed duplicates never create an inbox row, a notification, or a second card. Non-board routes never render a human response affordance. | Alarm fatigue and spurious escalation, the parent issue's core complaint. |
| OPX-6 | Finalization, reconciliation, and schema-rejection errors preserve and display the original claim, keep issue status unchanged, and name a recovery owner plus retry position. | Manufactured `blocked`/`in_review`, or a silently discarded work report. |
| OPX-7 | Model-authored prose is only ever rendered quoted, attributed, length-capped, and as plain text. It never occupies a label, chip, title, tone, link target, or status position. | Copy spoofing: a model writing text that imitates an arbiter verdict. |
| OPX-8 | Every read is authorized from the source issue/run company; cross-company and hidden references produce the same generic not-found and render nothing. | Cross-tenant disclosure through an operator surface. |
| OPX-9 | Countdowns, relative times, and expiry tones derive from the response envelope's `asOf`, not the client clock. | Skewed clocks showing a live request as expired, or the reverse. |
| OPX-10 | No new raw color, spacing, or shadow values. Every tone pairs color with a distinct glyph, and no state is conveyed by color alone. | Token drift and color-only signaling. |

#### 18.12.2 Persistence prerequisites for the operator read model

Section 18.3.1 defines the canonical attention record and section 18.7 defines
the contract/result/assessment/decision tables, but no table currently persists
attention records, their attempt history, or their budgets. The operator surface
cannot render owner, attempts, expiry, or duplicate state without them, so
Operator contract requires these additions alongside the section 18.7 set.

```text
attention_requests
  id uuid primary key
  company_id uuid not null references companies
  issue_id uuid not null references issues on delete cascade
  run_id uuid null references heartbeat_runs on delete set null
  turn_id text null
  version integer not null
  completion_contract_id uuid not null references completion_contracts
  classification text not null
  canonical_action text null
  canonical_resource_ref text null
  required_expertise text[] not null default '{}'
  requested_authority text null              -- untrusted caller hint, display-only
  minimum_authority text not null            -- policy-derived
  requested_scope text not null
  effective_scope text not null
  blocking_current_turn boolean not null
  alternate_track_ref text null
  request_fingerprint text not null
  equivalence_fingerprint text not null
  material_evidence_digest text not null
  urgency text not null
  state text not null
  selected_route text null
  selected_resolver_json jsonb null          -- resolved target class + id, no secrets
  route_ref text null
  request_json jsonb not null                -- canonical record, redacted at read
  expires_at timestamptz not null
  resolved_at timestamptz null
  policy_version text not null
  supersedes_request_id uuid null references attention_requests
  canonical_request_id uuid null references attention_requests  -- set on suppressed duplicates
  created_at timestamptz not null
  updated_at timestamptz not null
  unique (company_id, id)
  unique (company_id, request_fingerprint, version)
  index (company_id, issue_id, state, selected_route)
  index (company_id, equivalence_fingerprint)

attention_request_attempts
  id uuid primary key
  company_id uuid not null references companies
  request_id uuid not null references attention_requests on delete cascade
  ordinal integer not null
  route text not null                        -- context | retry | agent | board | external | recovery
  outcome text not null                      -- resolved | failed | exhausted | skipped | routed
  reason_code text not null                  -- AttentionResolutionReasonCode
  resolver_ref text null
  occurred_at timestamptz not null
  unique (request_id, ordinal)

attention_budgets
  company_id uuid not null references companies
  equivalence_fingerprint text not null
  context_passes integer not null default 0
  transient_retries integer not null default 0
  distinct_agent_resolvers integer not null default 0
  human_or_external_routes integer not null default 0
  resolution_transitions integer not null default 0
  emitted_wakes integer not null default 0
  first_attempt_at timestamptz not null
  last_attempt_at timestamptz not null
  policy_version text not null
  primary key (company_id, equivalence_fingerprint)
```

`attention_request_attempts` is append-only and is the sole source of the
attempt history the operator sees; the UI never reconstructs history from
activity prose. `attention_budgets` is the shared counter set of section 18.3.3,
so a suppressed duplicate increments the family it joined rather than starting a
new one. Suppressed duplicates persist as rows with `canonical_request_id` set
and never appear as top-level records in any read route `[OPX-5]`.

`native_run_finalizations.failure_detail` additionally carries the redacted
recovery owner reference and the retry schedule, because section 18.12.4 renders
both `[OPX-6]`.

#### 18.12.3 Layered outcome read model

One embedded object carries the four authority layers of section 18.3. Every
surface that shows any layer embeds this whole object, which is what makes
`[OPX-1]` checkable rather than aspirational.

```ts
interface NativeOutcomeLayers {
  schema: "paperclip.native-outcome-layers.v1";
  runId: string;
  turnId: string | null;

  // Layer 1 — harness driver authority.
  turnTerminalState: TurnTerminalState | null;

  // Layer 2 — runner/finalizer authority.
  runTerminalState: RunTerminalState | null;

  // Layer 3 — model work-report authority. Never a status.
  claim: {
    reportedWorkDisposition: ReportedWorkDisposition | null;
    reportedAt: string | null;
    // Server-resolved from the run's execution agent, not from the report body.
    claimedBy: { kind: "agent" | "user"; ref: string; displayName: string } | null;
    // Optional model prose, plain text, server-truncated to 1,000 characters.
    quotedSummary: string | null;
    quotedSummaryTruncated: boolean;
    // Present when the report failed validation but was preserved (18.7).
    schemaStatus: "accepted" | "rejected" | "partial";
    preservedResultRef: string | null;
  } | null;

  // Layer 4 — arbiter authority. The only authoritative status on this object.
  status: {
    current: AuthoritativeIssueStatus;
    statusVersion: number;
    latestDecisionId: string | null;
  };

  // Compatibility marker. Legacy runs set false and render the existing path.
  native: boolean;
}
```

Rules:

- `claim.quotedSummary` is the only free-text field on this object and is
  governed by `[OPX-7]`: rendered as plain text with a quote glyph, never
  markdown, never linkified, never used as a card title.
- A null `claim` means the run produced no report. It is not a failure and must
  not render as one.
- `native: false` freezes the surface to today's rendering; no chip row, decision
  card, or attention card is added to a legacy run (section 28.2).

#### 18.12.4 Status decision and finalization read models

```ts
interface StatusDecisionView {
  schema: "paperclip.status-decision-view.v1";
  id: string;
  issueId: string;
  runId: string | null;
  outcome: NativeOutcomeLayers;

  fromStatus: AuthoritativeIssueStatus;
  toStatus: AuthoritativeIssueStatus;
  transitionApplied: boolean;
  reasonCode: StatusDecisionReasonCode;
  applicationState: "proposed" | "applied" | "superseded" | "rejected";
  decidedAt: string;

  trigger: {
    kind: "runner_finalizer" | "board_user" | "authorized_agent" | "interaction" | "dependency" | "monitor";
    actorRef: string | null;
    actorDisplayName: string | null;
  };

  // Rendered as the criterion table. Descriptions come from the immutable
  // contract snapshot, never from the model report.
  criterionAssessments: Array<{
    criterionId: string;
    description: string;
    required: boolean;
    assessmentMode: "mechanical" | "policy_backed_agent_claim" | "named_reviewer" | "board";
    claimStatus: "satisfied" | "not_satisfied" | "unknown" | null;
    outcome: "accepted" | "missing" | "rejected" | "unverifiable";
    reasonCode: string;
    evidence: EvidenceRefView[];
  }>;

  missingRequirements: string[];
  pendingGovernedActions: Array<{
    kind: "approval" | "security_review" | "qa_review" | "board_decision";
    ownerRef: string | null;
    ownerDisplayName: string | null;
    targetRef: string | null;
  }>;
  remainingWork: Array<{ description: string; blocksCompletion: boolean }>;

  // "What happens next". Required non-empty whenever the decision is
  // non-terminal and no finalizationError is present [OPX-3].
  livePaths: LivePathView[];
  sideEffects: Array<{
    kind: StatusDecisionEffectKind;
    target: TargetRefView | null;
    deliveryState: "pending" | "delivered" | "failed" | "cancelled";
  }>;

  // Truthfulness escape hatch. "missing" forces the recovery treatment.
  livePathIntegrity: "satisfied" | "not_required" | "missing";

  supersession: {
    supersedesDecisionId: string | null;
    supersededByDecisionId: string | null;
  };

  audit: {
    reasonCode: StatusDecisionReasonCode;
    decisionId: string;
    policyVersion: string;
    completionContractRevision: string;
    decisionVersion: number;
  };
}

interface LivePathView {
  kind: "continuation" | "retry" | "delegated_issue" | "interaction" | "review" | "monitor" | "blocker" | "recovery";
  ref: string;
  owner: { kind: "agent" | "user" | "system"; ref: string; displayName: string };
  target: TargetRefView | null;
  // Rendered by the client as the "who owns the next move" sentence.
  expectedBy: string | null;
}

interface TargetRefView {
  type: "issue" | "interaction" | "approval" | "run" | "work_product" | "document" | "monitor" | "agent" | "user";
  id: string;
  identifier: string | null;   // e.g. "PAP-16713"
  displayName: string | null;
}

interface EvidenceRefView {
  ref: string;
  kind: "test" | "artifact" | "diff" | "observation" | "external_check";
  description: string;         // from the authoritative evidence record
  status: "passed" | "failed" | "unknown";
  target: TargetRefView | null;
  // True when the model asserted this evidence but no authoritative record
  // backs it. Rendered with the claim treatment, never as proof [OPX-7].
  claimOnly: boolean;
}

interface RunFinalizationView {
  schema: "paperclip.run-finalization-view.v1";
  runId: string;
  issueId: string;
  outcome: NativeOutcomeLayers;
  phase:
    | "observed" | "workspace_finalizing" | "ready_for_assessment"
    | "arbitrating" | "committed" | "retryable_failure" | "terminal_failure";
  failureCode: string | null;             // stable enum, never raw exception text
  failureSummary: string | null;          // redacted, non-secret, ≤ 240 chars
  retry: {
    attempt: number;
    maxAttempts: number;
    nextAttemptAt: string | null;
    exhausted: boolean;
  } | null;
  recoveryOwner: { kind: "agent" | "user" | "system"; ref: string; displayName: string } | null;
  preservedResultRef: string | null;
  assessmentId: string | null;
  decisionId: string | null;
  // Status is unchanged by definition here; surfaced so the card can say so.
  issueStatusUnchanged: true;
}
```

`StatusDecisionEffectKind` is the section 18.3 `sideEffects[].kind` enum. The
server never returns unredacted evidence payloads, tool arguments, secrets, or
cross-company references in any of these views (section 18.11).

The `livePathIntegrity` field is what makes `[OPX-3]` enforceable at the
contract level rather than by inspection: the server itself declares whether the
"who owns the next move" answer exists. `missing` is only legal together with a
`prior_status_preserved_no_live_path`, `attention_budget_exhausted`, or
finalization-error reason code, and it renders as recovery, never as waiting.

#### 18.12.5 Attention read model

```ts
interface AttentionRequestView {
  schema: "paperclip.attention-request-view.v1";
  id: string;
  issueId: string;
  runId: string | null;
  version: number;
  state: "pending" | "routed" | "resolved" | "expired" | "superseded" | "rejected" | "exhausted";
  classification: CanonicalAttentionRequest["classification"];
  urgency: "normal" | "high";
  createdAt: string;

  // Header copy. Server-normalized, plain text, ≤ 240 chars, model-authored →
  // rendered under the claim rules [OPX-7].
  summary: string;

  // Owner — always a named resolver, never "someone" [OPX-4].
  route: "context" | "retry" | "agent" | "board" | "external" | "recovery" | null;
  resolver: { kind: "agent" | "user" | "role" | "external_system" | "system"; ref: string; displayName: string } | null;

  authority: {
    minimum: CanonicalAttentionRequest["minimumAuthority"];   // policy-derived, authoritative
    requested: CanonicalAttentionRequest["minimumAuthority"] | null;  // untrusted caller hint
    corrected: boolean;   // requested !== minimum → render the "asked → resolved as" pattern
  };

  scope: {
    requested: "current_turn" | "current_track" | "task_wide";
    effective: "current_turn" | "current_track" | "task_wide";
    narrowed: boolean;
    blockingCurrentTurn: boolean;
    alternateTrack: TargetRefView | null;
  };

  attempts: {
    used: number;              // resolution transitions consumed
    limit: number;             // policy budget for the equivalence family
    history: Array<{
      ordinal: number;
      route: "context" | "retry" | "agent" | "board" | "external" | "recovery";
      outcome: "resolved" | "failed" | "exhausted" | "skipped" | "routed";
      reasonCode: AttentionResolutionReasonCode;
      resolverDisplayName: string | null;
      occurredAt: string;
    }>;
  };

  expiry: { expiresAt: string; expired: boolean; remainingMs: number };  // remainingMs relative to envelope asOf [OPX-9]

  duplicates: {
    suppressedCount: number;
    recent: Array<{ requestId: string; createdAt: string; variant: "repeated" | "reworded" }>;
  };

  // Response affordance. Server-evaluated with the centralized addressee
  // predicate of section 17.3.1; the client never computes eligibility [OPX-5].
  response: {
    canRespondInline: boolean;
    interaction: TargetRefView | null;
    // Exact continuation consequence, derived server-side because only the
    // server knows whether the provider session still advertises resumability.
    resumeBinding:
      | "resume_current_turn"
      | "wake_assignee_next_turn"
      | "agent_route_no_action"
      | "external_route_no_action"
      | "recovery_owner_action"
      | "audit_only_superseded"
      | "expired_fallback_sent";
    resumeSubject: { kind: "agent" | "user" | "system"; ref: string; displayName: string } | null;
  };

  delegatedIssue: TargetRefView | null;
  supersedesRequestId: string | null;
  supersededByRequestId: string | null;
  policyVersion: string;
}
```

Rules:

- Suppressed duplicates are never top-level `AttentionRequestView` records. They
  appear only inside `duplicates` on their canonical request `[OPX-5]`.
- `response.canRespondInline` is `true` only when `route === "board"`, `state` is
  `pending` or `routed`, the request is unexpired and non-superseded, and the
  viewer passes the addressee predicate. Every other combination renders
  read-only, including a board-routed request owned by a different person.
- `authority.requested` is display-only and is always labeled as what the agent
  asked for. It is never used to select a route, a tone, or an affordance.
- `resumeBinding` values map one-to-one to the resume sentences in the UX
  document; adding a value requires adding its sentence in the same change.

#### 18.12.6 Compact summaries for list and board surfaces

Board rows and the properties panel need bounded, batchable data. Existing issue
and heartbeat-run responses gain:

```ts
interface IssueStatusAuthoritySummary {
  schema: "paperclip.issue-status-authority-summary.v1";
  reportedWorkDisposition: ReportedWorkDisposition | null;
  latestDecision: {
    id: string;
    reasonCode: StatusDecisionReasonCode;
    toStatus: AuthoritativeIssueStatus;
    transitionApplied: boolean;
    decidedAt: string;
    disagreesWithClaim: boolean;
  } | null;
  waitingOn: {
    kind: "attention" | "review" | "approval" | "blocker" | "monitor" | "delegated_issue";
    owner: { kind: "agent" | "user" | "system"; ref: string; displayName: string };
    since: string;
  } | null;
  boardAttention: { pending: boolean; viewerIsResolver: boolean; ownerDisplayName: string | null };
  reconciliationPending: boolean;
  native: boolean;
}

interface HeartbeatRunNativeSummary {
  schema: "paperclip.heartbeat-run-native-summary.v1";
  outcome: NativeOutcomeLayers;
  finalizationPhase: RunFinalizationView["phase"] | null;
  latestDecisionId: string | null;
}
```

The issues-board list route returns exactly the two chip conditions of the UX
document — `boardAttention` and `reconciliationPending` — plus `latestDecision`
and `waitingOn`. It adds no column and no per-row fan-out: summaries are
produced by one batched join on `issues.last_status_decision_id` and one grouped
query over `attention_requests` using the
`(company_id, issue_id, state, selected_route)` index. `boardAttention` is
viewer-scoped, which is what lets one chip slot render "Needs you" for the
resolver and "Needs {name}" for everyone else.

#### 18.12.7 Read routes, authorization, and redaction

Section 18.11 lists three read routes. The attention surface needs a fourth,
without which the approved `AttentionRequestCard` has no source.

| Route | Returns | Ordering and limits |
|---|---|---|
| `GET /api/issues/:issueId/status-decisions` | `{ asOf, decisions: StatusDecisionView[], nextCursor }` | `decision_version` descending, default limit 20, maximum 100. Supports `runId` and `includeSuperseded` filters. |
| `GET /api/issues/:issueId/completion-contracts/current` and `/completion-contracts` | Current revision summary and revision history with criteria, gates, authority, and risk | History descending by revision, default limit 20. |
| `GET /api/heartbeat-runs/:runId/finalization` | `{ asOf, finalization: RunFinalizationView }` | Single record. `404` when the run is legacy or has no coordinator row. |
| `GET /api/issues/:issueId/attention-requests` **(new)** | `{ asOf, requests: AttentionRequestView[], nextCursor }` | Pending/routed first, then `created_at` descending. Default limit 25, maximum 100. Filters: `state`, `route`, `runId`. Suppressed duplicates are excluded as top-level rows. |
| `GET /api/issues/:issueId/attention-requests/:requestId` **(new)** | `{ asOf, request: AttentionRequestView }` | Deep-link target for inbox rows and activity references. |

Envelope and authorization rules:

- Every response carries `asOf` (server RFC 3339, millisecond precision). All
  countdowns and relative times derive from it `[OPX-9]`.
- Company is derived from the parent issue/run binding. Cross-company,
  hidden-resource, and unknown-ID requests return one generic not-found with no
  timing or body differences `[OPX-8]`.
- These are read models only. No route accepts a status, reason code, policy
  version, resolver, or authority field; there is no public arbiter-application
  endpoint, and agent API keys cannot reach one (section 18.11).
- Responding to a board-routed attention request continues to use the existing
  interaction/approval mutation identified by `response.interaction`. Operator contract
  adds no new mutation surface.

Redaction is a whitelist, not a filter:

| Never returned | Returned instead |
|---|---|
| Secret material, credential values, tool arguments | An authorized binding reference and its display name |
| Raw evidence payloads, command output, file contents | `EvidenceRefView` with description, status, and a company-scoped link |
| Request/equivalence fingerprints, input digests, canonical serializations | `decisionId`, `decisionVersion`, `policyVersion`, `completionContractRevision` for the audit footer |
| Cross-company agents, users, issues, integrations | Nothing; the reference is omitted and the parent read still succeeds |
| Raw exception text and stack traces | `failureCode` plus a redacted `failureSummary` ≤ 240 characters |
| Resolver inventory, capability scores, routing internals | The selected resolver and the attempt history only |

#### 18.12.8 Live updates and cache invalidation

Native surfaces reuse the existing live-update provider (section 23.2) and add
no polling. Published payloads carry identifiers and reason codes only, never
evidence or payload bodies (section 18.11).

| Event | Carries | Invalidates |
|---|---|---|
| `status_decision.committed` | `issueId`, `decisionId`, `reasonCode`, `toStatus`, `transitionApplied` | Issue detail, issue list row, `status-decisions`, run finalization |
| `status_decision.superseded` | `issueId`, `decisionId`, `supersededByDecisionId` | `status-decisions` |
| `native_finalization.updated` | `runId`, `issueId`, `phase`, `failureCode` | Run finalization, issue list row |
| `attention_request.updated` | `issueId`, `requestId`, `state`, `route`, `version` | `attention-requests`, attention inbox, issue list row |
| `attention_request.suppressed` | `issueId`, `canonicalRequestId`, `suppressedCount` | Canonical request only. Emits no notification and creates no inbox row `[OPX-5]` |

Query keys are `["issue", issueId, "status-decisions"]`,
`["issue", issueId, "attention-requests"]`, and
`["run", runId, "finalization"]`. A resolved attention response patches the
existing shared interaction card in place (section 23.2 `[UX-5]`) rather than
appending a second card.

#### 18.12.9 Client derivation rules

These are pure functions in `ui/src/lib/native-status/`, unit-tested
independently of rendering. They are the entire licensed surface for turning
codes into language.

| Function | Rule |
|---|---|
| `decisionVerb(view)` | `transitionApplied ? "Moved to " + statusLabel(toStatus) : "Kept " + statusLabel(fromStatus)`. No other verb form is permitted. |
| `reasonCopy(reasonCode)` | Lookup in `STATUS_DECISION_REASON_COPY`, a total map over the section 18.3 enum. Unknown code returns `{ text: "Decision recorded — open details", tone: "preserved" }` and the audit footer shows the raw code. Never blank, never a guessed tone. |
| `decisionTone(reasonCode)` | Lookup in the decision tone map of the UX document §5 item 1 (`accepted`, `review`, `progress`, `downgraded`, `recovery`, `preserved`, `blocked`). Tone is a function of the reason code only — never of the model report, the run outcome, or free text. |
| `toneGlyph(tone)` | Total map to distinct lucide glyphs so no tone is color-only `[OPX-10]`. |
| `claimLabel(claim)` | `"{displayName} reported {disposition}"`, past tense, plus relative time from `asOf`. Returns null when `claim` is null. Banned-string lint applies `[OPX-2]`. |
| `livePathSentence(path)` | `"{ownerDisplayName} owns the next move"` specialized per `kind`, always with the target link. Called only when `livePathIntegrity !== "missing"` `[OPX-3]`. |
| `resumeSentence(view)` | Total map over `response.resumeBinding` to the UX document's resume lines, interpolating `resumeSubject.displayName`. A missing subject falls back to the role noun, never to "someone" `[OPX-4]`. |
| `expiryTone(expiry, totalWindowMs)` | Neutral above 25% remaining; amber below; expired renders inert text plus a clock glyph. Uses `remainingMs` from the envelope `[OPX-9]`. |
| `authorityCorrection(authority)` | Renders `asked: {requested} → resolved as: {minimum}` only when `corrected`; otherwise renders `minimum` alone. |
| `scopeCorrection(scope)` | Renders the struck requested scope and the effective scope only when `narrowed`, with the alternate track link when present. |
| `attentionChip(summary)` | `viewerIsResolver ? "Needs you" : "Needs " + ownerDisplayName`. Suppressed duplicates and non-board routes return null. |

A reason code added to the protocol enum without a `STATUS_DECISION_REASON_COPY`
row fails the totality test in section 18.12.13; this is the mechanism behind
the UX document's rule that new reason codes cannot reach a UI surface
uncaptioned.

#### 18.12.10 Component data contracts and surface map

Components live under `ui/src/components/native-status/`, refining the UX
document's `ui/src/components/` placement to match the section 23.1 convention.
Each is registered in `/design-guide`.

| Component | File | Source | Required fields | Notes |
|---|---|---|---|---|
| `OutcomeChipRow` | `native-status/OutcomeChipRow.tsx` | `NativeOutcomeLayers` | `turnTerminalState`, `runTerminalState`, `claim.reportedWorkDisposition`, `claim.claimedBy`, `status.current` | Renders all four layers unexpanded `[OPX-1]`. Run/turn failure uses red text, never a red fill. |
| `StatusDecisionCard` | `native-status/StatusDecisionCard.tsx` | `StatusDecisionView` | all of §18.12.4 | Collapsed row + expanded claim/decision strip, criterion table, live paths, audit footer. |
| `AttentionRequestCard` | `native-status/AttentionRequestCard.tsx` | `AttentionRequestView` | all of §18.12.5 | Response control renders only when `canRespondInline`. |
| `FinalizationErrorCard` | `native-status/FinalizationErrorCard.tsx` | `RunFinalizationView` | `phase`, `failureCode`, `retry`, `recoveryOwner`, `outcome.claim`, `issueStatusUnchanged` | Recovery tone; claim stays visible `[OPX-6]`. |
| `ClaimChip` | `native-status/ClaimChip.tsx` | `NativeOutcomeLayers["claim"]` | disposition, attribution, time | The named "claim chip" pattern; reused anywhere a model asserts an unverified value. |
| `IssueRunLedger` (extend) | existing | `HeartbeatRunNativeSummary` | `outcome`, `latestDecisionId` | Native runs gain the chip row and nested decision card; `native: false` renders exactly as today. |
| `AttentionQueueRow` (extend) | existing | `AttentionRequestView` | owner, authority, expiry, `canRespondInline` | New source kind for board-routed pending requests only. |
| `IssueDetail` properties panel (extend) | existing | `IssueStatusAuthoritySummary` | `latestDecision`, `waitingOn` | Two rows: "Decision" and "Waiting on". No new panel. |
| Issues board row (extend) | existing | `IssueStatusAuthoritySummary` | `boardAttention`, `reconciliationPending` | One secondary chip slot, two conditions, no new column. |

`AttentionInteractionResolver` and `DecisionTriageStrip` are reused unchanged;
Operator contract adds no second resolver implementation (section 23.2 `[UX-5]`).

#### 18.12.11 Requirement coverage matrix

Every requirement of the approved UX document maps to a field and a component.
This matrix is the structural gate for implementation handoff.

| UX requirement | Read-model field(s) | Component | Gate |
|---|---|---|---|
| Turn outcome distinct from status | `outcome.turnTerminalState` | `OutcomeChipRow` | OPX-F1 |
| Run outcome distinct from status | `outcome.runTerminalState` | `OutcomeChipRow` | OPX-F1 |
| Agent claim distinct and attributed | `outcome.claim.reportedWorkDisposition`, `claim.claimedBy`, `claim.reportedAt` | `ClaimChip` | OPX-F1, OPX-F7 |
| Authoritative status unchanged in meaning | `outcome.status.current` | existing `StatusBadge` | OPX-F1 |
| Decision verb and reason sentence | `transitionApplied`, `fromStatus`, `toStatus`, `reasonCode` | `StatusDecisionCard` | OPX-F2 |
| Claim-vs-decision strip on disagreement | `outcome.claim`, `toStatus`, `reasonCode` | `StatusDecisionCard` | OPX-F2 |
| Criterion table with classifications | `criterionAssessments[]` | `StatusDecisionCard` | OPX-F2 |
| Evidence gaps | `missingRequirements`, `criterionAssessments[].outcome`, `EvidenceRefView.claimOnly` | `StatusDecisionCard` | OPX-F2 |
| Pending governed actions | `pendingGovernedActions[]` | `StatusDecisionCard` | OPX-F2 |
| "What happens next" side effects as links | `livePaths[]`, `sideEffects[]` | `StatusDecisionCard` | OPX-F2, OPX-F6 |
| Audit footer and supersession chain | `audit`, `supersession` | `StatusDecisionCard` | OPX-F2 |
| Attention owner | `resolver`, `route` | `AttentionRequestCard` | OPX-F3 |
| Attention authority incl. correction | `authority.minimum`, `authority.requested`, `authority.corrected` | `AttentionRequestCard` | OPX-F3, OPX-F4 |
| Attention scope incl. narrowing | `scope.*` | `AttentionRequestCard` | OPX-F3 |
| Attempts and budget position | `attempts.used`, `attempts.limit`, `attempts.history[]` | `AttentionRequestCard` | OPX-F3, OPX-F4 |
| Expiry countdown and expired state | `expiry.*`, envelope `asOf` | `AttentionRequestCard` | OPX-F3, OPX-F8 |
| Deduplication state | `duplicates.suppressedCount`, `duplicates.recent[]` | `AttentionRequestCard` | OPX-F5 |
| Resolver route determines affordances | `response.canRespondInline`, `route` | `AttentionRequestCard` | OPX-F4 |
| Exact continuation action | `response.resumeBinding`, `response.resumeSubject` | `AttentionRequestCard` | OPX-F3 |
| Delegated issue link | `delegatedIssue` | `AttentionRequestCard` | OPX-F4 |
| Reconciliation/finalization error | `RunFinalizationView.*` | `FinalizationErrorCard` | OPX-F6 |
| Status unchanged during error | `issueStatusUnchanged`, `outcome.status.current` | `FinalizationErrorCard` | OPX-F6 |
| Recovery owner and retry position | `recoveryOwner`, `retry.*` | `FinalizationErrorCard` | OPX-F6 |
| Board `Needs you` chip | `boardAttention.*` | issues board row | OPX-F3, OPX-F5 |
| Board `Reconciliation` chip | `reconciliationPending` | issues board row | OPX-F6 |
| Properties "Decision" and "Waiting on" | `latestDecision`, `waitingOn` | `IssueDetail` | OPX-F2, OPX-F3 |
| Legacy runs unchanged | `native: false` | `IssueRunLedger` | OPX-F9 |
| Reason-code copy completeness | `STATUS_DECISION_REASON_COPY` | derivation layer | OPX-F7 |
| Company scoping | route authorization | all | OPX-F10 |
| Token and accessibility rules | none (styling) | all | OPX-F11 |

#### 18.12.12 Degraded, legacy, and error states

The failure mode this phase exists to prevent is a UI that invents a state. Each
row below is a required rendering, not a suggestion.

| Condition | Renders | Must not |
|---|---|---|
| Read route loading | Skeleton in the card slot; the authoritative `StatusBadge` renders immediately from the issue record | Block the status badge behind decision data |
| Read route fails | Inline "Decision details unavailable — retry" with a retry control | Imply `blocked`, `in_review`, or completion; hide the claim |
| Legacy run (`native: false`) | Today's ledger rendering, unchanged | Add chips, decision cards, or attention cards |
| Native run, no decision yet | Chip row with the layers that exist; "Decision pending finalization" | Show a decision that has not committed |
| Unknown reason code | Generic caption, `preserved` tone, raw code in the audit footer | Blank text or a guessed tone |
| `livePathIntegrity: "missing"` | Recovery treatment naming the recovery owner and the operational alert | A waiting state with no owner `[OPX-3]` |
| Attention expired | Inert card, "expired unanswered · one fallback wake sent" | Any active response control |
| Attention exhausted | Card with full attempt history and the recovery owner | A synthesized human ask or a `blocked` chip `[OPX-6]` |
| Board-routed request owned by another person | Read-only card, "Waiting on {name}" | A response control for a non-resolver `[OPX-5]` |
| Agent- or external-routed request | Read-only card with the delegated target | Any human affordance `[OPX-5]` |
| Suppressed duplicate | One collapsed link row under the canonical card | A second card, inbox row, or notification `[OPX-5]` |
| Superseded decision | Collapsed, with links in both directions of the chain | Deletion or silent replacement |
| Cross-company or hidden reference | Reference omitted; parent view still renders | A broken link or a disclosing error |
| Board user overrides status manually | New superseding decision card with `trigger.kind: "board_user"`; prior card shows the chain | Presenting the override as the arbiter's own conclusion |

#### 18.12.13 Operator contract verification gates

Fixtures are table-driven against the production components and the shared
query cache; static mockups do not satisfy any gate (section 23.10).

| Gate | Coverage | Non-negotiable assertion |
|---|---|---|
| OPX-F1 — layer separation | Every row of the section 18.5 terminal conversion table rendered through `OutcomeChipRow` | All four layers are present and separately labeled in the unexpanded DOM; the claim node never carries a status-fill class `[OPX-1] [OPX-2]` |
| OPX-F2 — decision rendering | One fixture per `StatusDecisionReasonCode` | Correct verb, caption, tone, glyph, criterion rows, audit footer; disagreement fixtures render the claim-vs-decision strip |
| OPX-F3 — attention completeness | Board-routed pending request | Owner, authority, scope, attempts, expiry, duplicates, and resume sentence all appear above the response control in DOM order `[OPX-4]` |
| OPX-F4 — route affordances | `context`, `retry`, `agent`, `board`, `external`, `recovery` routes; board request owned by another user; authority-corrected request | Only the eligible board case exposes a response control; the correction pattern renders exactly when `corrected` `[OPX-5]` |
| OPX-F5 — duplicate suppression | Canonical request plus repeated and reworded duplicates | Exactly one card, one inbox row, zero notifications, incremented visible counter `[OPX-5]` |
| OPX-F6 — error truthfulness | `finalization_failed_claim_preserved`, `result_schema_rejected`, `attention_budget_exhausted`, `prior_status_preserved_no_live_path`, `livePathIntegrity: "missing"` | Status badge value is unchanged from the fixture's prior status; claim still visible; recovery owner and retry position named; no `blocked` or `in_review` node `[OPX-6]` |
| OPX-F7 — copy law | Static scan of `ui/src/**` copy constants, fixtures, and rendered fixture DOM | Zero matches for `/agent (succeeded\|failed\|completed)/i`; `STATUS_DECISION_REASON_COPY` is total over the protocol enum; every entry ≤ 70 characters and contains no agent name `[OPX-2] [OPX-7]` |
| OPX-F8 — clock independence | Fixture with client clock skewed ±6 hours | Countdown and relative times match the envelope `asOf`, not the client clock `[OPX-9]` |
| OPX-F9 — legacy compatibility | Legacy run in the same ledger as a native run | Legacy row DOM is byte-identical to the pre-change snapshot |
| OPX-F10 — company scoping | Cross-company issue, run, decision, and attention IDs | One generic not-found for each; no identifier, name, or timing disclosure `[OPX-8]` |
| OPX-F11 — token and accessibility gate | `pnpm check:tokens`, `pnpm check:token-gates`, axe pass over all new components at 1440×900 | No new raw color/spacing/shadow values; every tone has a distinct glyph; AA contrast in light and dark; reduced-motion has no pulse `[OPX-10]` |

Ahead of any implementation, `pnpm check:runner-operator_contract-spec` is the standing
structural gate over the two documents themselves. It proves reason-code copy
totality, read-model coverage of every operator field, gate reachability from
the coverage matrix, invariant enforcement, route agreement between sections
18.11 and 18.12, backing persistence for the attention read model, and the
copy law of `[OPX-2]`. A new reason code, component field, or gate that breaks
any of those relationships fails the check before it can reach a UI surface.

Screenshot matrix (adds to section 23.10, all at 1440×900 desktop; mobile is
deferred by the source ticket): the accepted happy path
(`completion_contract_satisfied` applied, issue moved to Done, all four layers
in agreement — the state where a claim chip sits next to a green badge and the
layers must still read separately), flows A–E of the UX document, the board row
with each chip, the properties panel rows, the legacy-run ledger, the expired
and exhausted attention states, and the superseded-decision chain. The artifact
index names the fixture, the flow, the reason code, the route, and the gate it
satisfies.

Section 27.6 gains these UI cases: layered outcome rendering, decision card per
reason code, criterion table classification, attention card completeness, route
affordance matrix, duplicate suppression, finalization error truthfulness,
unknown reason code fallback, clock-skew countdown, legacy fallback, and
keyboard operation of the response control.

### 18.13 Status-authority conformance, migration, and rollback contract

Status-authority conformance turns the authority, resolver, finalizer, and operator contracts into an
independently executable scenario matrix. The checked-in source of truth is
[`fixtures/status-authority-status_authority.json`](./fixtures/status-authority-status_authority.json),
and `pnpm check:runner-status_authority-spec` is the standing spec-level conformance gate.
The corpus is language-neutral: TypeScript server tests, Rust protocol tests,
the deterministic driver, migration tests, and QA harnesses consume the same
fixture IDs and expected facts. An implementation may add transport-specific
setup, but it must not rewrite an expected status, reason code, effect, count,
or compatibility mode.

Each fixture names the exact normative rows it covers:

- `SD-01`–`SD-19`: every row of the section 18.3 status-decision table;
- `TC-01`–`TC-08`: every row of the section 18.5 terminal conversion table;
- `ATT-01`–`ATT-12`: every row of the section 18.3.7 adversarial-attention table;
- `LIVE-01`–`LIVE-06`: atomic liveness success and rollback paths below;
- `REC-01`–`REC-08`: deterministic replay and reconciliation paths below;
- `COMP-01`–`COMP-08`: native/legacy and existing-state compatibility below;
- `MIG-01`–`MIG-09`: rollout, migration, rollback, and reconciliation stages below.

The fixture schema separates input facts from assertions:

```ts
interface StatusAuthorityConformanceFixtureV1 {
  id: string;
  mode: "native" | "legacy";
  covers: {
    decisionRows: string[];
    terminalRows: string[];
    attentionRows: string[];
    livenessRows: string[];
    reconciliationRows: string[];
    compatibilityRows: string[];
    migrationRows: string[];
  };
  tags: string[];
  given: {
    priorIssueStatus: AuthoritativeIssueStatus;
    turnTerminalState: TurnTerminalState | "active" | null;
    runTerminalState: RunTerminalState | "active" | null;
    reportedWorkDisposition: ReportedWorkDisposition | null;
    nativeFinalization: "present" | "missing" | "invalid" | "not_applicable";
    completionState: string;
    reviewGate?: "completion" | "mid_work";
    trigger: string;
    fault?: string;
  };
  expected: {
    runStatus: "succeeded" | "failed" | "cancelled" | "running" | "legacy_derived";
    statusAction:
      | AuthoritativeIssueStatus
      | "preserve"
      | "legacy_finalizer";
    reasonCode: StatusDecisionReasonCode | string | null;
    requiredEffects: string[];
    forbiddenEffects: string[];
    livePathKind: LivePathView["kind"] | null;
    preserveClaim: boolean;
    nativeRecords: boolean;
    decisionCount: number;
    maxWakeCount: number;
    maxNotificationCount: number;
  };
  replay: {
    attempts: number;
    sameDecisionDigest: boolean;
    maxSemanticDecisions: number;
    maxDomainEffectsPerKey: number;
  };
}
```

`reviewGate` disambiguates an intentional human-judgment interaction that gates
completion from one raised while productive work remains. A completion gate may
resolve to `in_review` under SD-11; a mid-work interaction still requires the
response-wake or preserve branches from that row. `decisionCount` counts status
decisions newly persisted for the fixture stimulus. Linking an equivalent
request to a pre-existing canonical family does not count that family's earlier
decision.

Fixture assertions are database assertions, not only response assertions. Every
case records the terminal turn/run facts, original result/evidence retention,
issue `status` and `status_version`, contract/policy version, assessment and
decision lineage, effect-ledger rows, domain liveness rows, outbox counts,
notifications, wakes, activity, and the coordinator phase. A failure response
with a leaked row or a correct row with an extra wake both fail conformance.
Timestamps and allocated UUIDs may differ; canonical input and decision digests,
ordered effect kinds, reason codes, and semantic counts may not.

#### 18.13.1 Required adversarial scenario inventory

The corpus must keep at least one fixture carrying each tag below. Tags are
stable QA selectors; renaming or removing one is a protocol change.

| Tag | Required behavior |
|---|---|
| `premature_done_claim` | A `done` claim with missing proof cannot set `done`; accepted claim/evidence remains inspectable. |
| `incomplete_evidence` | Missing, rejected, and unverifiable evidence stay distinct and choose continuation or truthful preservation. |
| `required_review` | Subjective/governed completion reaches `in_review` only with the matching reviewer/approval path. |
| `continuation` | A valid yielded result creates one canonical continuation and keeps the issue `in_progress`. |
| `partial_progress` | Useful partial work survives a non-terminal result and remains attached to the next run. |
| `real_blocker` | Only a task-wide stop with an owner/action and no alternate track can set `blocked`. |
| `excessive_human_request` | Agent-resolvable requests route through context, retry, or another agent before a human route. |
| `repeated_question` | Same-key and fresh-key equivalents share one canonical family and bounded counters. |
| `false_blocker` | Claimed task-wide scope is narrowed while another productive track is queued. |
| `partial_evidence_before_failure` | Failed execution preserves safely parsed evidence and never upgrades the issue from that evidence alone. |
| `finalization_failure` | A completion claim followed by workspace/transport/finalizer failure remains preserved but unapplied. |
| `cancellation_scope` | Turn, run, and issue cancellation have three intentionally different issue effects. |
| `authorized_resume` | Only an authorized trigger can supersede a terminal/waiting decision and it creates a new liveness path. |
| `supersession` | New evidence produces append-only assessment/decision lineage; stale effects do not replay. |
| `native_legacy_distinction` | Native rows use contracts/assessments/decisions; legacy rows remain on the existing finalizer and create none. |
| `existing_issue_state` | Upgrade does not synthesize history or silently rewrite open or terminal issue status. |
| `atomic_liveness` | A non-terminal status and its durable next-action path commit or roll back together. |
| `deterministic_replay` | Same canonical input/policy returns one digest and at-most-one semantic effect. |
| `reconciliation` | Crash/race recovery resumes from durable phase and appends supersession when facts changed. |
| `rollback` | Disabling native application stops new native dispatch without converting an active native run to legacy. |

#### 18.13.2 Atomic liveness fixtures

| ID | Injection | Required result |
|---|---|---|
| LIVE-01 | Valid completion-review target | `in_review`, reviewer/approval/interaction domain row, return owner, and wake outbox commit in one transaction. |
| LIVE-02 | Reviewer/interaction insert fails | Prior status/version preserved; no reviewer, notification, or wake leaks; `side_effect_planning_failed` recovery is recorded. |
| LIVE-03 | Valid task-wide blocker | `blocked`, company-scoped blocker relation or unblock descriptor, owner notification intent, and dependency wake identity commit together. |
| LIVE-04 | Blocker relation/owner binding fails | Prior status/version preserved; no `blocked` projection or owner notification leaks. |
| LIVE-05 | Valid continuation | Continued `in_progress`, cleared completed-run lock, one canonical queued continuation/response wake/monitor, and attempt budget increment commit together. |
| LIVE-06 | Continuation/outbox insert fails | Prior status/version preserved; no orphan continuation, wake, or `in_progress` transition; recovery names an owner. |

The failpoint is after validation but before transaction commit. Each failure is
replayed after the failpoint is removed to prove that rollback did not consume
the canonical idempotency key. A post-commit websocket or external-notification
failure is different: the authoritative transition stays committed and only
the existing effect-ledger row is retried.

#### 18.13.3 Deterministic replay and reconciliation fixtures

| ID | Scenario | Required result |
|---|---|---|
| REC-01 | Identical result is ingested twice before acknowledgement | One result fingerprint, assessment, decision digest, status transition, and domain effect per idempotency key. |
| REC-02 | Equivalent material arrives with fresh caller IDs/dedupe keys | Resolve to the canonical result and shared attention budget; caller keys cannot mint another semantic action. |
| REC-03 | Caller reuses an ID with changed material | `structured_result_replay_conflict`; no decision, status change, route, notification, or wake. |
| REC-04 | Finalizer crashes after result preservation and before workspace finalization | Reconciler resumes the existing workspace operation, then assesses once. |
| REC-05 | Finalizer crashes after decision commit and before outbox acknowledgement | Replay dispatches only pending effect rows; it does not re-arbitrate or duplicate a domain row. |
| REC-06 | Board update wins the status-row race | Finalizer reloads and appends a superseding assessment; stale effects remain cancelled/preserved and cannot reopen a terminal issue. |
| REC-07 | Dependency or interaction response wins the race | Superseding assessment includes the resolved fact and emits at most one newly legal continuation. |
| REC-08 | Contract or policy version changes before replay | Old inputs remain bound to their immutable versions; a new assessment uses the new versions and links, rather than mutating, the old decision. |

Every replay fixture runs once in original order, once with duplicate delivery,
and once after a simulated control-plane restart. The final database projection
and ordered semantic-effect identities must be equal. When the authoritative
facts intentionally change, only the append-only supersession chain may differ.

#### 18.13.4 Native, legacy, and existing-state compatibility

| ID | Starting condition | Compatibility behavior |
|---|---|---|
| COMP-01 | Existing adapter omits `nativeFinalization` | Select the legacy finalizer exactly as before; create no contract, result, coordinator, assessment, decision, or attention row. |
| COMP-02 | Persisted run profile is native and the discriminator is missing/invalid | Fail closed with native finalization failure and recovery; never select the legacy heuristic. |
| COMP-03 | Adapter result contains a native-looking model-authored field only inside `resultJson` | Ignore it for mode selection; the persisted run profile plus typed adapter boundary are authoritative. |
| COMP-04 | Existing issue upgraded in `todo`, `in_progress`, `in_review`, or `blocked` | Initialize `status_version = 0` without changing status, owner, blocker, review path, monitor, checkout, or timestamps; create no synthetic history. |
| COMP-05 | Existing issue upgraded in `done` or `cancelled` | Preserve terminal status/timestamps; late native evidence is audit-only unless an authorized resume/cancellation capability permits a legal new decision. |
| COMP-06 | Native application flag disabled after shadow records exist | Shadow rows remain inspectable and unapplied; legacy runs keep existing behavior; no shadow decision may dispatch an effect. |
| COMP-07 | One ledger contains native and legacy runs | Native rows expose four authority layers and decision lineage; legacy rows render the byte-identical pre-change path with `native: false`. |
| COMP-08 | Existing authorized status route races or runs during rollout | It increments `status_version` in every mode and triggers native reconciliation only when a native coordinator is active. |

There is no implicit “upgrade legacy history” job. A later migration that wants
native contracts for a legacy adapter must define how the contract is sourced,
how historical evidence is classified, and who authorizes semantic backfill.
Until then, native and legacy metrics, UI summaries, audit exports, and QA
reports carry an explicit `mode` dimension and are never aggregated as though
their completion semantics were identical.

#### 18.13.5 Rollout and migration sequence

| ID | Stage | Entry gate | Action and exit evidence |
|---|---|---|---|
| MIG-01 | Expand schema | Migration dry-run and rollback rehearsal pass on production-shaped data | Add nullable references/new tables plus `status_version default 0`; no behavior or issue-state change. |
| MIG-02 | Version all writers | Every issue-status mutation test asserts one `status_version` increment | Deploy writer compatibility before any native arbiter can apply decisions. |
| MIG-03 | Read-only compatibility | Legacy UI/API snapshots and cross-company read tests pass | Ship read types/routes behind flags; missing native rows are an intentional `native: false`/`404`, not an error. |
| MIG-04 | Shadow materialization | Contract/result redaction, digest, and storage tests pass | Materialize native contracts/results and compute assessments/decisions with effect dispatch disabled. |
| MIG-05 | Shadow comparison | Complete Status-authority conformance corpus passes and divergence dashboard labels expected legacy/native differences | Compare proposed native decisions with existing behavior; reconcile or classify every unexplained divergence. |
| MIG-06 | Internal canary | QA accepts the complete matrix; Security/CTO gates remain satisfied | Enable application for allowlisted company + adapter profile + policy version; keep per-run mode immutable. |
| MIG-07 | Cohort rollout | Canary has no unreconciled coordinator, liveness-integrity, cross-company, or duplicate-effect failures | Increase cohorts by company/adapter profile; pin policy/algorithm versions for in-flight runs. |
| MIG-08 | Disable/rollback | Kill-switch drill and active-run inventory are available | Stop new native dispatch/application, retain read visibility, let active native runs finish/reconcile as native, and send later attempts to legacy only when their profile is newly selected as legacy. |
| MIG-09 | Contract migration or cleanup | Explicit reviewed migration exists for each adapter family | Only then migrate a legacy adapter or remove compatibility columns/flags; never infer contracts from exit codes or delete audit lineage. |

Schema rollback is expand/contract, never destructive in the incident window.
The application can roll back while the expanded schema remains. New binaries
must tolerate old rows with no native references, and the immediately previous
binary must tolerate the added nullable columns/tables. A destructive contract
phase is forbidden until retention, export, audit, and downgrade compatibility
are reviewed separately.

Policy compatibility is exact-version, not “latest wins.” A run binds the
immutable completion-contract, resolver-policy, and arbiter-algorithm versions
at envelope creation. Replay uses those versions. A policy rollout affects new
runs and explicit authorized re-assessments only. Emergency policy revocation
may prevent an undelivered effect from executing, but it records a new
superseding assessment/reason; it never silently edits the committed decision.
Unknown contract, fixture, result, or policy schema versions fail closed and
remain recoverable/readable as preserved input.

Rollback reconciliation is complete only when every native coordinator is in
`committed` or `terminal_failure` with a named recovery owner, every committed
effect is delivered or durably retryable, no active native run was converted
mid-session, and the native/legacy/shadow counts reconcile to the dispatch
ledger. Re-enablement resumes from coordinator state; it does not bulk replay
all historical reports.

#### 18.13.6 Independent QA acceptance package

QA receives the fixture corpus, this specification, the Operator contract operator
contract, the conformance command output, implementation test output grouped by
fixture ID, migration rehearsal output, and a failure-injection ledger. The
matrix is accepted only when:

1. every `SD`, `TC`, `ATT`, `LIVE`, `REC`, `COMP`, and `MIG` ID has at least one
   passing implementation result;
2. every required adversarial tag has a passing fixture and no unclassified
   divergence;
3. native and legacy results are reported in separate columns and the legacy
   baseline snapshot is unchanged;
4. duplicate/replay runs prove bounded wakes, notifications, decisions, and
   domain effects;
5. the three non-terminal status families pass both success and transaction
   rollback failpoints;
6. a production-shaped upgrade, kill-switch rollback, and re-enable rehearsal
   reconcile without status loss, synthetic history, or mode conversion; and
7. Operator contract rendering fixtures consume the same decision/attention outcomes and
   preserve OPX-1–OPX-10.

QA records acceptance against the corpus schema version and git revision.
Changing an expected semantic assertion after acceptance requires a new corpus
schema or fixture revision and a fresh independent acceptance run.

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

Runner bootstrap is separate from workspace realization. Installing or starting `paperclip-runnerd` must not replace, precede, or bypass the existing `realizeWorkspace` result. The bootstrap target receives the already-realized working directory and must preserve the existing sync-in/sync-out and finalization behavior.

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
MCP App HTML/scripts/resources: untrusted active content
```

### 20.2 Credential rules

- Runner connection credential never enters harness environment.
- Model never receives a Paperclip API credential.
- Provider-management API keys stay in the control plane.
- PRP carries credential binding references and short-lived capabilities, never long-term secret values in commands, events, snapshots, or replay buffers.
- Environment materialization remains available for compatibility, but the exposure scope, target process, secret version, and audit event are explicit.
- Model-provider and tool credentials should use a run-scoped HTTP broker/proxy when the client and protocol support it; placeholder values may preserve compatibility without revealing the real credential.
- The broker runs outside the untrusted workload, authenticates the run/session, enforces service and destination policy, injects credentials only on approved outbound requests, and records access events.
- Broker session tokens are not the underlying secrets, but they are still sensitive capabilities: keep them short-lived, scoped, revocable, redacted, and unavailable to unrelated child processes.
- Provider-managed runtimes use provider-native workload identity or secret bindings when available; Paperclip stores the binding provenance and never represents it as local runner injection.
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
- support for a run-scoped credential broker configuration and fail-closed launch when policy requires brokered egress.
- sandboxed MCP App iframes with no same-origin access to the Paperclip application, allowlisted `postMessage` channels, enforced resource CSP, least-privilege permission policy, and explicit teardown.

Optional later:

- mTLS runner identity;
- provider-attested runner claims;
- deeper transparent egress enforcement for protocols and clients that cannot use the initial HTTP/HTTPS broker path.

---

## 21. Persistence and database changes

### 21.1 Event reliability problem to fix

A reconnectable remote runner cannot rely on `MAX(seq) + 1` allocation or merely an index on `(run_id, seq)`. Concurrent server events, replayed runner events, and lost ACKs can produce duplicates or sequence races.

#### 21.1.1 What “authoritative” means

“The database is authoritative” does **not** mean “put every byte from every agent in PostgreSQL forever.” It means:

- every legal run/session/turn state can be reconstructed from durable records without asking the currently connected producer;
- every accepted control intent, approval, terminal result, cost fact, and consequential artifact reference survives producer and control-plane restarts;
- replay and browser snapshots have a durable cursor and cannot depend on an in-memory socket buffer;
- provider or runner claims are normalized, deduplicated, and accepted by Paperclip before they become control-plane truth;
- large or high-rate payloads can live outside PostgreSQL as long as PostgreSQL durably stores their identity, integrity, ownership, retention, and retrieval metadata.

The authoritative record should use three storage tiers:

| Tier | Examples | Storage rule |
| --- | --- | --- |
| Canonical control events | lifecycle transitions, normalized messages/items, tool/request boundaries, approvals, steering, cancellation, usage totals, results, provider reconciliation | PostgreSQL rows with stable IDs, ordering, schema version, company/run scope, and retention class. |
| Bulk trace payloads | verbose raw provider envelopes, large stdout/stderr chunks, screenshots, patches, audio/video, model snapshots | artifact/blob storage with content hash, byte length, media type, encryption/retention metadata, and a PostgreSQL reference. Small bounded payloads may remain inline. |
| Transient delivery data | token deltas already compacted into a message, terminal repaint frames, audio packets, presence/typing, duplicate heartbeats | bounded relay/buffer only unless promoted into a durable semantic event. |

This model permits full-fidelity debugging where required without making the primary relational tables an unbounded packet capture.

#### 21.1.2 Centaur storage finding

Centaur does persist its durable session trail in PostgreSQL, but the format is compact and structured rather than a database row for every raw terminal byte. Its current open-source core schema uses:

- `sessions` for durable thread/harness/sandbox identity and status;
- `session_messages` for role plus JSONB parts;
- `session_executions` for queued/running/terminal execution state, including a unique partial index allowing one active execution per thread;
- `session_events` with an identity `event_id`, `thread_key`, optional `execution_id`, `event_type`, JSONB payload, and creation time;
- an index on `(thread_key, event_id)` for cursor replay;
- PostgreSQL `NOTIFY` after insert as a wake-up hint, while the row remains the durable event source.

The lesson is not “copy every trace forever.” The lesson is “persist a cursor-addressable semantic event trail and use notifications/streams as acceleration, never as the only copy.” Centaur also separates its Postgres-backed control plane from Kubernetes sandbox execution and credential-safe egress.

#### 21.1.3 ActiveGraph storage finding

The ActiveGraph repository was cloned and inspected for this revision. Its core design is an append-only per-run `EventStore`; the event log is the source of truth and the graph is a rebuildable projection. The SQLite schema stores `seq`, logical event ID, type, actor, JSON payload, frame/causal linkage, timestamp, and run ID, with WAL enabled and sequence—not wall-clock time—as ordering authority. The PostgreSQL backend implements the same event-store contract. Run rows store fork lineage and metadata.

Useful durability properties for Paperclip are:

- a minimal append/iterate/get/count contract that can be conformance-tested across stores;
- stable per-run ordering independent of clocks;
- explicit causal links such as `caused_by` and frame/sub-context identity;
- projections that are disposable and rebuildable from the log;
- deterministic replay plus divergence detection;
- fork lineage, structural diff, and promotion recorded as auditable events;
- content-hashed LLM/tool replay caches;
- structured corruption, duplicate-event, schema-version, and replay-divergence errors;
- retention as a policy over durable events, not accidental deletion from an in-memory transcript.

Paperclip should adopt the ordering, causality, replay, conformance, and rebuildable-projection properties. It should **not** copy ActiveGraph's assumption that all application state is one graph log: Paperclip already has normalized operational tables and business entities whose constraints remain authoritative in their own tables.

#### 21.1.4 Volume controls

The implementation must define measurable limits before production:

- maximum inline event payload and mandatory blob offload threshold;
- per-run and per-company retained bytes by retention class;
- compaction from token/terminal deltas into canonical completed items;
- raw-envelope sampling or expiry independent of canonical control retention;
- artifact lifecycle and deletion propagation;
- partition/index strategy for the high-volume event table;
- export/archive path for compliance or deep debugging;
- metrics for events/sec, bytes/sec, replay depth, compaction lag, and storage cost.

The default should retain enough normalized history to explain and reconstruct the run while expiring replaceable transport detail.

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

Issue-thread interactions remain authoritative in
`issue_thread_interactions`. Native mode adds binding and delivery receipts
rather than copying their lifecycle into a runner-only table:

```sql
CREATE TABLE native_interaction_bindings (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  issue_id UUID NOT NULL,
  interaction_id UUID NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_run_id UUID NOT NULL,
  native_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  requested_policy JSONB NOT NULL,
  effective_policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(company_id, issue_id, idempotency_key)
);

CREATE TABLE native_interaction_deliveries (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  issue_id UUID NOT NULL,
  interaction_id UUID NOT NULL,
  response_cursor TEXT NOT NULL,
  response_phase TEXT NOT NULL,
  response_recorded_at TIMESTAMPTZ NOT NULL,
  destination_run_id UUID,
  destination_session_id TEXT,
  destination_turn_id TEXT,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  response JSONB NOT NULL,
  UNIQUE(interaction_id, response_cursor)
);
```

The materialization transaction writes the interaction row, binding receipt,
business activity, and protocol event atomically. Resolution writes the
authoritative interaction result, response event, continuation decision, and
delivery receipt atomically. Suggested-task materialization keeps its existing
transactional at-most-once domain effects. Delivery acknowledgement advances a
cursor only; it never deletes the interaction or its audit history.

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
- Keep accepted control intents, approvals, reconciliation decisions, and terminal-state evidence durably.
- Compact token, terminal, and progress deltas after their canonical item/message projection is durable.
- Raw provider envelopes and diagnostic chunks have a configurable shorter retention window or move to blob/archive storage.
- Never delete a blob without updating or tombstoning its durable reference and retention reason.
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
  interactions: NativeInteractionView[];
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

The runtime-request resolver is not an interaction resolver. Formal approvals,
execution-stage decisions, issue-thread interactions, and provider permission
requests keep distinct routes, authorization, and audit records.

### 22.4 Native interaction bridge and response routing

The trusted runner boundary may submit a bound proposal through the negotiated
PRP channel or the equivalent narrowly scoped runner endpoint:

```text
POST /api/runtime/v1/heartbeat-runs/:runId/interactions
POST /api/runtime/v1/heartbeat-runs/:runId/interactions/:interactionId/deliveries/:responseCursor/ack
```

The first route accepts only `BoundInteractionProposalV1` authenticated by the
runner connection/lease identity. It verifies the route run against every
host-owned binding field, validates the strict union, derives the idempotency
key, and returns either the materialized/replayed receipt or
`InteractionRequestFailureV1`. It cannot accept a general agent bearer token or
model-supplied company/issue identity. The acknowledgement route can advance
only a delivery already assigned to that destination run/session/turn. Its
lookup identity is exactly `(companyId, interactionId, responseCursor)` plus
the authenticated destination binding; `recordedAt` is never accepted as a
cursor or conditional.

Resolution continues to use the existing issue-scoped, kind-specific
interaction routes and policy service. The bridge does not invent a generic
accept/reject operation: suggestions and confirmation kinds use accept/reject,
questions use respond/cancel, item verdicts use partial verdict submission, and
all pending kinds may use authorized withdrawal. Every resolution path invokes
one shared native response projector that:

1. reloads and authorizes the current company/issue/interaction under lock;
2. validates target freshness and supersession;
3. stores the complete normalized `InteractionResponseV1` and P0 event;
4. derives continuation and same/fresh-session routing from server policy;
5. atomically allocates/reuses one immutable response cursor, destination-bound
   delivery, and at most one idempotent wake; and
6. includes the response in the next task envelope until acknowledged.

Closed or unassigned issues suppress wakes without losing the durable response.
Plan acceptance may force a fresh session/workspace refresh. Partial item
verdict submissions produce progress delivery; the final submission produces a
terminal response. Blocking item verdicts default to terminal-only resume;
partial progress wakes require an explicit policy-approved opt-in. A duplicate
webhook, resolver retry, bridge reconnect, or
lost delivery acknowledgement cannot repeat domain effects or queue an
equivalent second continuation.

### 22.5 Human message durability

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
    InteractionItem.tsx
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

1. Initial REST snapshot, including pending and delivered interaction context.
2. Existing Paperclip live-event subscription filtered by run.
3. Ordered reducer for runner- and control-plane-originated events.
4. Gap detection.
5. REST replay.
6. Same reducer.
7. Issue-thread interaction query invalidation after business interaction activity.
8. Polling only as a degraded fallback.

The thread and console MUST mount the existing shared interaction-card
component against the same normalized interaction query/cache and mutation
state source; a console-only copy of the card or lifecycle reducer is not
permitted. Resolution updates the existing card in place and atomically
invalidates or patches both surfaces. Live events, snapshot hydration, REST
replay, and mutation responses all enter that shared reducer. **[UX-5]**

For interaction responses the reducer orders and deduplicates only by
`responseCursor`, scoped by company and interaction. It ignores `recordedAt`
for identity, persists the destination ACK boundary, and attaches a linked
resume-provenance marker (interaction, cursor, source run/turn, resumed
run/turn) to the card and resumed timeline. Item-verdict progress updates that
one card/envelope; it never appends a card per batch. **[UX-6]**

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

When the last yielded turn has any pending `blockingCurrentTurn` interaction,
the primary run chrome reads **Waiting for response** and uses a pending state,
even if the provider turn itself is `completed`. It MUST NOT show the green
completed treatment until the interaction dependency is terminal and the
authoritative run/issue projection is complete. **[UX-3]**

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
- Issue-thread interaction cards render all five kinds, partial item-verdict
  progress, stale/superseded outcomes, materialized tasks, and delivered
  response state without masquerading as provider permission cards.
- All five kinds are first-class needs-input items in v1. Every pending card
  displays its kind label and a deep link to the authoritative issue-thread
  interaction, even when inline resolution for that kind is not yet offered.
  **[UX-2]**
- The shared header is `InteractVariant.title` and supporting copy is
  `summary`; question prompt text stays inside the body and never competes as a
  second card title. **[UX-1]**
- Terminal cards explicitly render `withdrawn`, question `cancelled`,
  `issue_closed`, `addressee_deleted`, `failed`, and rejected materialization.
  They retain reason/error copy safe for the viewer, remove every resolver
  affordance, and remain in replay/history rather than appearing successful or
  disappearing. **[UX-4]**
- Formal approval and execution-review cards retain distinct labels, routes,
  authority copy, and actions; the console never presents them as
  `paperclip.interact` results.
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
| yielded on issue-thread interaction | Show pending card; resume is server-routed |
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
16. Each of the five interaction kinds renders from snapshot, live resolution,
    and replay with the same stable card identity.
17. Question answers, created task references, confirmation outcomes/reasons,
    checkbox selections, and item-verdict progress are visible after resume.
18. Stale-target and superseded-by-comment outcomes remain visible and cannot
    expose active resolver actions.
19. Runtime permission, formal approval, execution review, and issue-thread
    interaction cards are visually and behaviorally distinct.

### 23.10 Interaction screenshot and mockup matrix

The implementation handoff MUST include inspectable desktop and mobile
screenshots or deterministic Storybook/Playwright mockups for every required
cell below. Fixtures use the production shared card and reducer; bespoke static
HTML is not acceptable. **[UX-7] [UX-8] [UX-9]**

| Matrix axis | Required captures/assertions |
| --- | --- |
| Five kinds | One recognizable pending needs-input card for each kind, each with kind label and deep link; a mixed all-kind attention view proves no kind is demoted. |
| Lifecycle | Proposed/materialized, pending, progress where applicable, accepted/answered/resolved, rejected, withdrawn, cancelled question, expired `issue_closed`, `addressee_deleted`, `failed`, stale/superseded, and rejected materialization. |
| Waiting chrome | Last yielded turn plus pending blocking card shows `Waiting for response`, then transitions only after terminal response/resume. |
| Provenance and delivery | Linked source-to-resume marker; partial verdict cursor advance on one card; lost-ACK reconnect and byte-equivalent replay without a duplicate card or animation. |
| Authority distinctness | Issue-thread interaction beside runtime permission, formal approval, and execution-review cards, with visibly different labels, copy, actions, and route families. |
| Scale edges | 1 and maximum practical visible entries for tasks/questions/options/verdict items, long safe title/summary/reason, wrapping deep link, empty legal checkbox selection, and partial verdict completion. |
| Responsive surfaces | Thread and Live Run Console at desktop and narrow mobile widths, including actionable, read-only terminal, reconnect, and overflow/keyboard-focus states. |

The artifact index names the fixture, viewport, interaction kind, lifecycle
state, cursor, expected action family, and corresponding conformance test. A
single happy-path desktop capture does not satisfy this matrix.

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
| Runtime permission while disconnected | Persist request; UI can resolve; command delivers after reconnect unless expired. |
| Interaction materialized, receipt lost | Replay the identical bound proposal; return the stored interaction and receipt without a second row or side effect. |
| Interaction resolves before a resumed run starts | Persist the full response and delivery cursor; include it in the next eligible envelope until acknowledged. |
| Interaction response delivery ACK lost | Redeliver the same response identity; do not queue an equivalent second continuation. |
| Interaction target becomes stale or a user comment supersedes it | Store and deliver the typed terminal outcome; stale resolver attempts are audit-only. |
| Interrupt races with completion | First terminal state committed wins; other operation returns `already_terminal`. |
| Driver lacks steer | UI offers interrupt-and-send, not fake steer. |
| Driver cannot resume session | Explicit `session_lost`; policy creates a real review/recovery path or a new Paperclip attempt without assuming issue status. |
| Outbox exceeds limit | Coalesce P2; reject new turns; preserve P0; expose backpressure. |
| Bad runner digest/version | Reject connection and fail bootstrap visibly. |
| Expired runner credential | Re-authenticate through lease flow or drain; never pass token to harness. |
| Workspace path invalid | Reject `run.prepare` before harness launch. |
| Structured result invalid | Reject result, optionally request correction, then record recovery/assessment without assuming `in_review`. |
| Process exits zero without result | Treat as missing native finalization/result and enter server-owned assessment/recovery; never infer `done`. |
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
14. duplicate command idempotency;
15. strict `paperclip.interact` union or generated per-kind aliases;
16. blocking interaction yield and non-blocking continuation behavior.

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
- token expiry and rotation;
- all five interaction request/response JSON Schemas and cross-language fixtures;
- interaction proposal/materialization/response/delivery event ordering;
- replay of a proposal before and after materialization;
- replay of progress and terminal response deliveries after lost acknowledgement.

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
- semantic tool cannot mutate another run;
- model-supplied company/issue/run/session/idempotency/resolver/audit fields are rejected;
- model-supplied trusted tool-action fields are rejected and cannot obtain trusted rendering;
- cross-company target, addressee, attachment, link, parent, project, goal, and assignee references fail closed;
- same-creator, same-source-run, ineligible addressee, low-trust, terminal-issue, and unauthorized resolver paths are denied;
- formal approval and execution-review authority cannot be obtained through an interaction request or runtime request.

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
- all five issue-thread interaction cards and their history states;
- partial item-verdict progress followed by terminal completion;
- stale-target and superseded-by-comment rendering;
- resumed-run response rendering after refresh/replay;
- distinct runtime permission, interaction, formal approval, and execution-review presentation;
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

### 27.8 Existing workspace compatibility tests

Run the same deterministic file-mutation fixture through the legacy adapter path and Native Runner Mode for each supported realization shape, then assert equivalent observable results:

- local in-place workspace uses the existing realized cwd and performs no redundant copy;
- isolated or operator-branch execution uses the existing `execution_workspace` identity and branch/worktree selected by Paperclip;
- copied sandbox workspace receives the anchor workspace before harness launch and synchronizes allowed mutations back during existing finalization;
- plugin-native file sync uses the existing `environmentSyncIn` and `environmentSyncOut` operations rather than a runner-specific transport;
- `authoritativeRoot` is the harness cwd and an unapproved cwd or symlink escape is rejected before launch;
- `pathAliases` permit only the recorded equivalent paths and do not create additional writable roots;
- referenced workspace hints remain available exactly as they are today, and a remote run does not claim that referenced trees were transferred when only the anchor source was realized;
- `outboundRestorePaths` and existing workspace-operation policy constrain copy-back;
- workspace-finalization failure prevents a clean native success and enters the existing recovery path;
- lease release or retention occurs only after native execution and workspace finalization reach a consistent state.

The initial sandbox spike is compatible only when these assertions pass without changing the current project-workspace, execution-workspace, environment-lease, realization, or sync contracts.

### 27.9 Interaction bridge conformance

One table-driven suite runs against the TypeScript server bridge, Rust runner
schema implementation, deterministic driver, and browser reducer. It must prove:

1. every current kind validates as strict model input and materializes one
   authoritative company/issue-scoped interaction;
2. `suggest_tasks` accept/reject round-trips created/skipped client keys and a
   replayed acceptance cannot create duplicate issues;
3. `ask_user_questions` response/cancel/comment-supersession round-trips full
   normalized answers or terminal outcome;
4. `request_confirmation` accept/reject/stale-target/newer-request/comment
   supersession round-trips the target and reason while trusted tool-action
   enrichment remains output/internal-only;
5. `request_checkbox_confirmation` validates defaults/min/max, round-trips an
   empty legal selection and non-empty selection, and never executes selected
   IDs as actions;
6. `request_item_verdicts` supports idempotent partial batches, immutable prior
   verdicts, progress delivery with full state and new-item delta, and one
   terminal delivery;
7. same bound invocation plus same payload replays the materialization receipt,
   while the same invocation plus changed payload returns
   `idempotency_conflict` and creates no row;
8. proposal replay, duplicate resolver webhook, lost ACK, control-plane restart,
   runner reconnect, and browser replay preserve one interaction, one domain
   effect, one canonical continuation per response cursor, and one UI card;
9. latest-revision checks at creation and resolution produce `stale_target`, and
   a later genuine user comment produces `superseded_by_comment` without an
   unauthorized wake or status change;
10. forged binding, stale run/session/turn, cross-company references,
    unauthorized resolver, low-trust creator, same-creator/source-run resolver,
    closed issue, and reserved trusted-action fields fail closed with safe
    errors and detailed company-scoped audit;
11. blocking creation auto-yields exactly once only after durable
    materialization; rejection leaves the turn open; non-blocking creation can
    coexist with one later `paperclip.finish` or `paperclip.block`;
12. resolved and progress responses arrive inline in the resumed skillless task
    envelope, survive same/fresh-session routing, and remain until the delivery
    cursor is acknowledged; and
13. status arbitration preserves the original interaction/result facts and
    never derives `blocked`, `in_review`, `done`, a formal approval, or an
    execution-stage decision solely from the model's request.

#### 27.9.1 Required Operator contract fixture gates

These are release gates, not illustrative examples. Each fixture records the
exact response body, safe sorted JSON Pointer paths (maximum 20), database row
counts before/after, event/outbox counts, effective policy, and cursor/ACK
state. **[QA G1] [QA G2] [QA G3] [QA G4] [QA G5] [QA G6]**

| Gate | Required table-driven coverage | Non-negotiable assertion |
| --- | --- | --- |
| QA G1 — strict validation | For each of the five kinds, exercise `invalid_schema`, `reserved_field`, `limit_exceeded`, `invalid_combination`, `invalid_target`, `stale_target`, `run_binding_invalid`, `interaction_not_allowed`, `issue_not_open`, `idempotency_conflict`, and the retryable `transient_control_plane_failure`. Boundary rows cover 0/51 tasks, 0/11 questions, 0/11 options per question, 0/201 checkbox options, 0/201 verdict items, and one-over-limit title (240), summary (1,000), reason/free text (4,000), details/preview/markdown (20,000), href (2,000), validation paths (20), and `maxEventBytes`. Nested question `request.title` is a reserved safe-path row. | Every deterministic denial asserts the exact public code and safe paths and produces zero interaction, binding, delivery, event, activity, notification, wake, materialized issue, and target-visible audit rows. The transient fixture proves rollback before its retryable error. |
| QA G2 — withdrawal and expiry | For every kind: creator-authorized, current-assignee-authorized, board-authorized, unauthorized, and idempotent repeated withdrawal. Separately cover `issue_closed`, `addressee_deleted`, trusted-tool expiry, generic `failed`, and a resolver response arriving after each expiry. | Authorized withdrawal has one terminal result/cursor and no duplicate wake; unauthorized is generic and side-effect-free; stale post-expiry response is audit-only. All terminal affordances are absent in reducer output. |
| QA G3 — finalization and turn lock | Non-blocking finish with valid `waitsOnInteractionIds`; finish with the field absent; invalid/foreign/stale IDs; policy-governed closure causing `issue_closed`; pending dependency preserving a live path; blocking yield followed by model output, finish, and block attempts. | Prose never implies dependency. The explicit dependency branch stays live, independent work may close, and every post-yield terminal attempt returns `turn_already_terminal` with no second assessment, turn terminalization, or side effect. |
| QA G4 — item verdict policy | User-only resolution; agent, creator, same-run, low-trust, and unauthorized-user denials; partial batches under default `wake_assignee_on_terminal`; explicit policy-approved progress-wake opt-in; repeated/overlapping batches; `cancelled` after prior results. | One card/envelope advances by cursor, prior verdicts remain immutable and present after cancellation, default partial batches create no wake, terminalization creates at most one wake, and agent attempts create zero result rows. |
| QA G5 — credentialless resume | One resumed native run receives, inline and without an agent API key, full question answers, suggested-task `createdTasks`/skips, confirmation/checkbox outcome, complete verdict state/new-item delta, target/continuation data, and immutable response cursors. | The runner-scoped destination binding is sufficient; no Paperclip/API credential enters the model environment. Every response remains byte-equivalent and redeliverable until its destination ACK commits. |
| QA G6 — crash/replay exactly once | Resolve progress and terminal responses, lose the ACK, restart the server and runner, reconnect the browser, replay, then ACK from the assigned destination; also attempt an ACK from a different run/session/turn. | For each `(companyId, interactionId, responseCursor)`, replay bytes are identical and there is exactly one domain effect, continuation wake, reducer effect, provenance link, and UI card. Foreign ACK is rejected and does not advance the cursor. |

The same suite also proves the centralized addressee predicate at creation and
resolution, including a resolver who loses eligibility between those points.
Every kind has pending-equivalence fixtures: same source agent + kind +
canonical payload/target replays the receipt, while different payloads remain
distinct within the rate limit. Hidden/missing/cross-company targets share one
generic denial and one non-disclosing audit-rate-limit family.

#### 27.9.2 Review-finding traceability

| Finding | Normative contract | Conformance evidence |
| --- | --- | --- |
| Security S1 | Sections 17.1, 17.3.2, and 22.4: immutable server cursor, tuple identity, atomic allocation, destination-bound ACK, consumer dedupe; timestamp is metadata. | QA G5–G6 and Section 27.9 cases 8 and 12. |
| Security S2 | Section 17.3.1: centralized creation/resolution eligibility, hints only narrow, generic side-effect-free denial, company audit family limits. | QA G1–G2 plus the predicate/equivalence paragraph after the gate table. |
| UX-1 | Sections 17.3 and 23.5: one common card title and supporting summary; nested runner question title denied, legacy REST normalized. | QA G1 nested-title row and screenshot lifecycle/scale fixtures. |
| UX-2 | Section 23.5: all five first-class needs-input kinds with labels and deep links. | Section 23.10 five-kind and all-kind attention captures. |
| UX-3 | Section 23.3: `Waiting for response` overrides green completed chrome after blocking yield. | Section 23.10 waiting-chrome capture and QA G3. |
| UX-4 | Section 23.5: explicit terminal/failure rendering with all affordances removed. | QA G2 and Section 23.10 lifecycle captures. |
| UX-5 | Section 23.2: shared production card/cache/reducer in thread and console with in-place dual-surface updates. | QA G6 and responsive thread/console captures. |
| UX-6 | Section 23.2: cursor-only reducer order/dedupe, linked resume provenance, one progress card. | QA G4–G6 and provenance/replay captures. |
| UX-7 | Section 23.10: five-kind lifecycle and waiting-chrome artifact matrix. | Artifact index cross-linked to the UI suite. |
| UX-8 | Section 23.10: provenance, reconnect/replay, scale-edge, desktop/mobile captures. | Artifact metadata and reducer assertions for every required viewport/fixture. |
| UX-9 | Sections 23.5 and 23.10: authority-card distinctness and mixed all-kind attention. | Authority-distinctness and all-kind captures plus route-family UI tests. |
| QA G1 | Section 27.9.1 strict-validator gate. | Exact code/path and zero-row table assertions across five kinds/all limits. |
| QA G2 | Section 27.9.1 withdrawal/expiry gate. | Authorized/unauthorized/idempotent fixtures and stale post-expiry responses. |
| QA G3 | Section 27.9.1 finalization/turn-lock gate. | Dependency-present/absent/invalid closure branches and terminal lockout. |
| QA G4 | Section 27.9.1 item-verdict gate. | User-only, prior-results cancellation, default terminal wake, explicit progress opt-in. |
| QA G5 | Section 27.9.1 credentialless-resume gate. | Full five-kind response envelope, no agent key, until-ACK replay. |
| QA G6 | Section 27.9.1 crash/replay gate. | Lost ACK/restart byte identity and one wake/effect/card per cursor. |

Across every mapped finding, company scope is derived from the authenticated
run binding; resolver authorization is rechecked at mutation time; formal
approval and execution-policy gates remain on their existing authority paths;
and interaction, run, and issue statuses remain server-only fields. Neither a
model hint, runner lease, response payload, continuation intent, nor replay/ACK
can bypass those invariants.

### 27.10 Status-authority Status-authority conformance conformance

Section 18.13 and
[`fixtures/status-authority-status_authority.json`](./fixtures/status-authority-status_authority.json)
are the sole scenario inventory for status-authority implementation and QA.
`pnpm check:runner-status_authority-spec` must pass before a runtime suite starts. Runtime
suites then execute the same fixture IDs at these layers:

| Consumer | Required assertions |
|---|---|
| Shared/validator | Input schema, enum, contract/policy version, server-owned field rejection, and safe error code. |
| Status arbiter | Pure decision digest, status/no-op, reason code, ordered effect plan, and supersession lineage. |
| Server/database | Transactional status version, domain liveness rows, coordinator phase, effect ledger, activity, notification, and wake counts. |
| Runner/finalizer | Turn/run terminal conversion, claim/evidence preservation, workspace-finalization order, and native discriminator fail-closed behavior. |
| Legacy regression | Existing finalizer behavior and byte-identical legacy read/UI snapshots with zero native history rows. |
| Migration harness | Production-shaped expand migration, writer versioning, shadow comparison, canary, kill-switch rollback, reconciliation, and re-enable. |
| Operator contract UI | Four authority layers, decision/attention truthfulness, liveness owner, finalization recovery, and native/legacy distinction from the same outcomes. |

Each test result is emitted as `{ corpusRevision, gitRevision, fixtureId,
consumer, outcome, observedDigests, semanticCounts }`. QA rejects aggregate
“suite passed” evidence that cannot be joined back to every required fixture
ID. Failure injection runs record the failpoint and pre/post database counts;
replay runs record all attempt IDs and the one canonical semantic identity.

---

## 28. Rollout and compatibility

### 28.1 Feature flags

```text
native_runner_enabled
native_runner_codex_app_server_enabled
native_runner_acp_enabled
native_run_ui_enabled
native_runner_remote_sandboxes_enabled
native_runner_interactions_enabled
```

Enable per instance, company, agent, and run profile.

### 28.2 Compatibility modes

```text
legacy
  Existing adapter.execute and Paperclip skill behavior.

managed
  Existing process adapter with small semantic tools and host-owned lifecycle.

native
  PRP runner, typed session driver, no Paperclip skill, canonical
  paperclip.interact union with durable resumed-run delivery.
```

`paperclip.ask` is deprecated. A compatibility adapter may translate only
`{question, choices, blocking}` that maps losslessly to one
`ask_user_questions` request. It rejects confirmation, task creation,
item-verdict, or untyped-payload semantics. Existing REST, CLI, MCP, and board
routes remain dedicated control-plane surfaces; native mode does not require
them to collapse into one public endpoint.

### 28.3 Rollout gates

1. Fake driver local loopback.
2. Direct Codex local execution target.
3. Direct Codex in one cold sandbox provider with legacy/native workspace-equivalence tests passing.
4. Standalone Live console live Codex Web UI with steering, interruption,
   requests, goal capability detection, subagent lineage, reconnect, and replay.
5. Reconnect/replay fault suite.
6. Second provider.
7. ACP/acpx driver.
8. Warm runner.
9. Warm harness/session.
10. Five-kind interaction bridge, response replay, and resumed-run gates.
11. Additional drivers.

Native status application additionally follows the ordered `MIG-01`–`MIG-09`
sequence in section 18.13.5. The generic runner gates above cannot skip shadow
comparison, complete Status-authority conformance fixture acceptance, internal canary, or the
kill-switch reconciliation drill. A driver may reach a later runner gate while
its status application remains shadow-only; mode is persisted per run and never
changes mid-session.

### 28.4 Kill switch

The control plane can:

- stop dispatching new native runs;
- drain runners;
- fall back new attempts to the legacy adapter;
- leave active native runs visible and recoverable.

Never change an active run from native to legacy mid-session.

---

## 29. Supported package model

The native runner is one package with responsibility-based Rust modules, PRP v1 protocol contracts, durable transport, Codex and fake harness drivers, TypeScript reference clients, scenario and live-session surfaces, and package-local conformance evidence. Production Paperclip integration remains behind the public control-plane and session interfaces documented above.

## 30. Acceptance criteria

The spike is successful only if all of the following are demonstrated.

### Model/runtime boundary

- [ ] No Paperclip skill is loaded.
- [ ] No Paperclip API route manual is included in the prompt.
- [ ] No Paperclip or runner connection credential is available to the model/harness process.
- [ ] Task instructions remain sufficient to complete the work.
- [ ] Completion is structured.
- [ ] A strict canonical `paperclip.interact` union covers all five current
      issue-thread kinds; provider aliases normalize to it before persistence.
- [ ] Pending and resolved interaction context is complete in the task envelope,
      and the model needs no Paperclip API fetch to consume a response.

### Control plane

- [ ] Checkout occurs before expensive sandbox/model execution.
- [ ] Existing budgets and workspace policy still apply.
- [ ] Existing workspace finalization still runs, and the additive native finalizer applies the complete section 18 arbitration contract.
- [ ] Agent-reported dispositions remain advisory; the server records the proposal and authoritative status decision separately.
- [ ] `blocked` requires a blocker owner/action, and `in_review` requires a real reviewer, approval, interaction, delegated review, or monitor path.
- [ ] A human-needed request can wake or notify the correct owner without granting the model arbitrary status-transition authority.
- [ ] Legacy adapters are unchanged.
- [ ] Runtime permission and governance approval are separate.
- [ ] Issue-thread interactions, runtime permissions, formal approvals, and
      execution-stage decisions retain separate authority, routes, and audit.
- [ ] Every interaction request is bound by the host to the current
      company/issue/agent/run/session/turn/tool call and materialized once.
- [ ] A blocking interaction yields the turn only after durable materialization
      and does not directly set issue status.
- [ ] Suggested-task side effects and every response continuation/delivery are
      idempotent across retry, reconnect, restart, and lost acknowledgement.
- [ ] Database state remains authoritative when the active producer disconnects.
- [ ] Runner and fake remote backends expose the same normalized session contract.
- [ ] Fleet remains a future projection and does not require a separate first-spike protocol.

### Sandbox/network

- [ ] Runner initiates outbound WSS.
- [ ] Cold sandbox can bootstrap.
- [ ] Warm runner can be reused.
- [ ] Runner reconnects after control-plane restart.
- [ ] No inbound sandbox port is required.
- [ ] A compatibility secret can be process-scoped through environment materialization without appearing in PRP or logs.
- [ ] A supported HTTP client can use a short-lived broker session without possessing the underlying long-term credential.

### Session

- [ ] Stable normalized, driver, and provider identities are stored separately.
- [ ] Turn events are typed.
- [ ] Steering is supported or explicitly degraded.
- [ ] Interruption preserves session.
- [ ] Accepted turns terminalize exactly once.
- [ ] No silent replacement session.
- [ ] Driver MCP capabilities are negotiated and resolved bindings are injected without exposing long-term credentials.
- [ ] MCP Apps support is negotiated through `io.modelcontextprotocol/ui`; unsupported clients receive an honest text/structured fallback.
- [ ] Tool-to-`ui://` resource linkage, app lifecycle, tool input/results, and security-relevant app actions survive replay without persisting every iframe message.
- [ ] Unsupported remote-backend capabilities degrade explicitly.
- [ ] All five interaction kinds deliver full typed progress/terminal responses
      into a resumed run with server-selected same/fresh-session routing.

### UI

- [ ] Task page shows launch phases.
- [ ] Messages, tools, commands, file changes, plan, diff, usage, and requests stream live.
- [ ] Composer remains usable.
- [ ] Browser refresh reconstructs the same view.
- [ ] No duplicate items after replay.
- [ ] No healthy-state polling is required.
- [ ] Final result is unambiguous.
- [ ] Supported MCP Apps render in a sandboxed Paperclip browser host and reconstruct after refresh with the same stable view/item identity.
- [ ] Provider-rendered or text-only MCP App fallbacks are labeled accurately and never presented as Paperclip-hosted interactive views.
- [ ] All five issue-thread interaction cards reconstruct from snapshot and
      replay, including partial verdicts, stale targets, supersession, answers,
      selected options, created tasks, and terminal reasons.
- [ ] Runtime permission, interaction, formal approval, and execution-review
      cards are visually distinct and call only their authorized route family.
- [ ] The run subscription behaves as a logical per-run stream over a shared company connection.
- [ ] A simulated channel/voice interrupt uses the same durable command and event state.
- [ ] Slack, email, voice, webhook, and provider-owned channel ingress cannot bypass Paperclip core authorization, durable acceptance, or audit.

### Reliability and performance

- [ ] Event sequence allocation is transactional.
- [ ] Source events are idempotent.
- [ ] Lost ACK does not duplicate state.
- [ ] Interaction proposal and response-delivery replay do not duplicate
      materialization, domain effects, continuations, or UI cards.
- [ ] Stale-target, supersession, authorization, idempotency-conflict, and
      resumed-run conformance cases pass for every applicable kind.
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
13. The durable control record is authoritative; PostgreSQL is not an unbounded byte-level trace archive.
14. MCP policy and credentials remain in Paperclip core; PRP only carries resolved binding configuration and canonical events.
15. JSON Schema and fixtures are language-neutral protocol authority.
16. Hosted agent platforms use `NativeSessionBackend` rather than being modeled as fake sandboxes.
17. Transient media may use a side channel, but control, audit, transcript, and terminal state remain durable.
18. Fleet is a future control-plane projection, not a first-spike protocol feature.
19. MCP Apps rendering is a Paperclip core/browser responsibility; neither a runner nor a hosted provider can bypass host authorization and iframe security policy.
20. Remote providers adopt the normalized runner semantics through either a PRP gateway or Contract B2; they are not forced into a fake local-`runnerd` topology.
21. `paperclip.interact` is the canonical native issue-thread interaction
    primitive; `paperclip.ask` is only a lossless legacy question translator.
22. Resolver policy, continuation, target freshness, status projection,
    suggested-task materialization, trusted tool actions, and audit remain
    server-owned.

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
> Preserve the existing environment-run orchestrator, execution workspace realization, issue checkout, budgets, governance, run records, workspace finalization, and legacy adapters. Branch after the execution target is realized. Internally use a session-oriented Native Session Runtime; at terminal completion convert the native facts and reported work disposition to the additive native-aware adapter-result boundary. Extend run/issue finalization to create a work assessment and authoritative status decision, and retain the legacy exit-code heuristic only for adapters that omit the native discriminator.
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

A third test is:

> Could Paperclip operate a provider-managed Cursor, Devin, Jules, or Copilot task through the same normalized session state machine while clearly showing which controls and environment guarantees the provider actually exposes?

If yes, `RemoteAgentBackend` is a real integration boundary rather than a generic abstraction that assumes Paperclip owns every sandbox.

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
- **Centaur:** compact PostgreSQL session/message/execution/event tables, durable event cursor, isolated execution, and credential-safe egress; `NOTIFY` accelerates delivery but the stored event row is the replay source.
- **ActiveGraph:** append-only per-run event-store contract, sequence-based ordering, causal linkage, rebuildable projections, deterministic replay, explicit divergence/corruption errors, and auditable fork/diff/promote behavior.
- **Conductor OSS:** real PTY, worktree/diff surfaces, Rust runtime, and paired remote bridge.
- **Rivet sandbox-agent:** small static sandbox daemon and universal harness adapter; possible southbound implementation, not Paperclip's northbound authority.
- **Daytona:** outbound worker connection and snapshot/warm-sandbox pattern.
- **exe.dev:** persistent VM and system service pattern.

## Appendix C — Sources reviewed

Source review date: 2026-08-07.

- Centaur source: `https://github.com/paradigmxyz/centaur`, especially `services/api-rs/crates/centaur-session-sqlx/migrations/0001_session_control_plane.sql` and `0002_session_event_notifications.sql`.
- Centaur production architecture: `https://centaur.run/architecture` and `https://centaur.run/deploying-in-production`.
- ActiveGraph source: `https://github.com/yoheinakajima/activegraph`, especially `activegraph/store/base.py`, `activegraph/store/sqlite.py`, `activegraph/store/postgres.py`, store conformance tests, and replay/fork documentation.
- ActiveGraph product and documentation: `https://activegraph.ai/` and `https://docs.activegraph.ai/`.
- Cursor Cloud Agents API overview and background-agent environment/security documentation: `https://docs.cursor.com/background-agent/api/overview` and `https://docs.cursor.com/background-agent`.
- Devin v3 API overview, common flows, session detail, session messages, create/send/terminate/archive endpoints, and RBAC documentation: `https://docs.devin.ai/api-reference/overview`.
- Jules REST API quickstart and reference: `https://jules.google/docs/api/reference/` and `https://developers.google.com/jules/api/reference/rest`.
- GitHub Copilot cloud agent task API: `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api`.
- OpenAI Codex cloud/SDK distinction: `https://openai.com/index/codex-now-generally-available/`.
- AWS Bedrock AgentCore overview, runtime service contract, invocation API, runtime lifecycle/versioning, session isolation, async work, and identity behavior: `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/`, `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html`, `https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html`, and `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html`.
- Cloudflare Agents runtime, API, WebSockets, durable state, and durable execution: `https://developers.cloudflare.com/agents/`, `https://developers.cloudflare.com/agents/runtime/agents-api/`, `https://developers.cloudflare.com/agents/runtime/communication/websockets/`, and `https://developers.cloudflare.com/agents/runtime/execution/durable-execution/`.
- Google Vertex AI Agent Engine managed runtime, custom query/stream operations, sessions, and bidirectional streaming: `https://cloud.google.com/vertex-ai/generative-ai/docs/reasoning-engine/overview`, `https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/develop/custom`, `https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/sessions/manage-sessions-api`, and `https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/bidirectional-streaming`.
- Microsoft Agent Framework hosting, self-hosting, durable extension, and Foundry Hosted Agents: `https://learn.microsoft.com/en-us/agent-framework/get-started/hosting`, `https://learn.microsoft.com/en-us/agent-framework/hosting/self-hosting`, `https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension`, and `https://learn.microsoft.com/en-us/agent-framework/hosting/foundry-hosted-agent`.
- Infisical Agent Vault credential-broker and HTTP/HTTPS proxy model: `https://github.com/Infisical/agent-vault` and `https://docs.agent-vault.dev/reference/cli`.
- MCP Apps overview and host behavior: `https://modelcontextprotocol.io/extensions/apps/overview`.
- Stable MCP Apps extension specification (SEP-1865, dated 2026-01-26), including `io.modelcontextprotocol/ui` capability negotiation, `ui://` resources, `text/html;profile=mcp-app`, sandboxing, lifecycle messages, tool input/results, and app-to-host JSON-RPC: `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx`.
- MCP Apps App Bridge API for host-side iframe rendering, message routing, tool proxying, and policy enforcement: `https://apps.extensions.modelcontextprotocol.io/api/modules/app-bridge.html`.
