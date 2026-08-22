# Paperclip Native Runner Implementation Plan

## Purpose and relationship to the spike specification

This document is the implementation-phase plan for [`paperclip-native-runner-spike-spec.md`](./paperclip-native-runner-spike-spec.md). The specification remains the normative product, architecture, protocol, security, persistence, API, UI, performance, and acceptance contract. This plan defines how to build and validate that contract through independently runnable tracer bullets.

All implementation starts inside `packages/paperclip-runner/` with protocol and mock-control-plane layers. These standalone phases do not modify Paperclip control-plane semantics. A real Paperclip bridge is a late, separately reviewed phase after the standalone contract passes conformance tests.

Phases 0 through 3 are complete and accepted. The authorized Phase 4 tracer is
implemented and awaits Security, CTO, QA, and human acceptance. Keep Phase 5
and later issues uncreated until the Phase 4 human checkpoint is complete.

## Non-negotiable delivery rules

1. **One branch:** all work remains on `PAP-16679-paperclip-runner`. Do not switch, rename, re-point, merge upstream, or open parallel feature branches.
2. **Standalone first:** new runtime behavior, documentation, tutorials, examples, journals, fixtures, and devtools live under `packages/paperclip-runner/`. The default development and test path uses a mock Paperclip core adapter.
3. **Core is a port, not a dependency:** package code depends on a small `ControlPlanePort`/`NativeSessionBackend` contract. Mock implementations own tests and tutorials. Paperclip-specific integration implements that port later.
4. **No hidden control-plane coupling:** standalone tests must not import `server/`, `ui/`, or production database modules. Contract tests may consume shared generated schemas or fixtures through explicit package exports.
5. **Rust production boundary:** the production runner direction is Rust. TypeScript may provide control-plane/client contracts and a test oracle, but each runner phase must establish or extend the Rust workspace and prove shared-fixture parity rather than deferring Rust implicitly.
6. **Tracer bullet in every phase:** each phase ends with a useful executable path, even if it is intentionally narrow.
7. **Evidence in every phase:** record the exact commands run, versions used, results, known gaps, and links to artifacts/screenshots.
8. **Documentation in every phase:** add reference documentation plus a hand-run tutorial. Add each tutorial to a Native Runner tutorial index and to a cumulative end-to-end tutorial.
   Start each tutorial with short sections that explain what the phase is and what its runnable proof establishes. Use Simplified English for these sections and for the procedure.
9. **OKF engineering journal:** maintain a Google Open Knowledge Format journal using current OKF v0.2 conventions: Markdown files, YAML frontmatter, typed entries, timestamps, links, and index pages. Add a journal usage guide before implementation begins.
10. **Human checkpoint in every phase:** the board/user can run the tutorial and accept or request changes before the next dependent phase starts.
11. **Commit by phase:** create small, reviewable commits during each phase. Each phase ends with a named checkpoint commit after QA and human acceptance.
12. **No invented UI primitives:** evaluate and selectively adapt shadcn/ui and Vercel AI Elements components. Keep Paperclip design tokens and accessibility requirements authoritative.
13. **Production integration is additive:** legacy adapters and existing run finalization remain unchanged unless the separate integration phase explicitly proves a minimal feature-flagged bridge.

## Proposed package and documentation boundaries

```text
packages/paperclip-runner/
  protocol/                 language-neutral schemas and fixtures
  sdk/typescript/           TypeScript protocol/reducer/client SDK
  runner/                   Rust workspace; runner-core first, daemon/local state later
  drivers/api/              harness driver contract
  drivers/fake/             scripted deterministic harness
  drivers/codex/            reference Codex app-server driver
  backends/fake-remote/     hosted-provider simulator
  mock-core/                mock ControlPlanePort and WSS server
  conformance/              protocol, driver, backend, replay, security suites
  devtools/browser/         standalone browser reference application
  examples/                 smallest runnable examples by phase
  benchmarks/               phase and end-to-end measurements
  knowledge/                OKF bundle and engineering journal
  README.md                 package entry point and current capabilities

  docs/
    index.md                  tutorial and phase index
    architecture.md           package boundaries and contracts
    tutorials/phase-00-*.md   hand-run tutorial for each accepted phase
    tutorials/end-to-end.md   cumulative tutorial updated each phase
    journal.md                how to read and maintain the OKF journal
```

Exact directories may be adjusted during Phase 0, but the standalone/core boundary must not weaken.

## Research conclusions to carry into implementation

- The user reference to “Google KF/open knowledge format” is interpreted as **Google Open Knowledge Format (OKF)**. Use the current v0.2 specification, published July 24, 2026, rather than inventing a Paperclip-specific journal schema.
- The repository already uses React 19, Tailwind CSS 4, shadcn conventions, CSS variables, and Lucide. This makes shadcn components a direct fit.
- Vercel AI Elements is built on shadcn/ui and includes useful AI-interface primitives such as Conversation, Message, PromptInput, Tool, Plan, Queue, CodeBlock, and Terminal. Its documented setup targets Next.js, while Paperclip uses Vite. Therefore, do a source-compatibility spike and selectively adapt components instead of adding an unnecessary Next.js or AI SDK runtime dependency.
- UI acceptance must include `pnpm check:token-gates`, Storybook/browser screenshots, keyboard operation, replay determinism, and legacy fallback behavior.

Primary references:

- OKF v0.2 specification: `https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md`
- Google OKF announcement and rationale: `https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/`
- Vercel AI Elements: `https://elements.ai-sdk.dev/docs`
- shadcn/ui: `https://ui.shadcn.com/docs`

## Phase completion contract

Every phase child issue uses the same completion checklist:

- [ ] Runnable tracer command or browser flow exists.
- [ ] The assignee ran it locally and attached the command/result evidence.
- [ ] Unit tests pass for the new lowest-level behavior.
- [ ] Integration/conformance tests pass against the mock core.
- [ ] Reference documentation is current.
- [ ] A step-by-step human tutorial is published and linked from the index.
- [ ] The cumulative end-to-end tutorial is updated.
- [ ] An OKF journal entry records decisions, evidence, failures, and next questions.
- [ ] QA independently follows the tutorial and records pass/fail evidence.
- [ ] Required UX or security review is complete.
- [ ] Human checkpoint is accepted before dependent work begins.

## Phase 0 — Boundary, journal, and runnable skeleton

**Purpose:** establish the lowest possible layer and make the project navigable before runtime code grows.

**Tracer bullet:** a package-owned command starts the mock core, loads a minimal protocol fixture, prints a validated run identity/result, and exits without importing or starting the Paperclip app.

**Deliverables:**

- package workspace skeleton and build/test commands;
- Rust Cargo workspace with the initial `runner-core` crate and default Phase 0 tracer;
- architecture boundary document with forbidden imports and dependency direction;
- initial `ControlPlanePort`, `HarnessDriver`, and `NativeSessionBackend` interface sketches;
- mock core adapter shell;
- tutorial index and cumulative tutorial shell;
- OKF v0.2 bundle, journal entry template, index pages, and “how to use the journal” instructions;
- CI/static boundary check that rejects TypeScript imports and Cargo path dependencies from production core packages;
- shared-fixture parity check between the Rust tracer and TypeScript reference;
- a dated compatibility note for shadcn/ui and AI Elements.

**Tests/evidence:** Rust and TypeScript package builds, shared-fixture validation smoke, byte-identical tracer output, forbidden-import/path-dependency tests, docs link check, and OKF frontmatter/index validation.

**Owners/review:** CodexCoder implementation; DevRel documentation review; SecurityEngineer boundary/secret review; CTO architecture approval; QA tutorial execution.

**Human checkpoint:** clone/use the existing branch, run the Phase 0 tutorial, inspect the generated journal/index, and confirm that the package works without Paperclip core.

## Phase 1 — Protocol, fixtures, reducer, and static replay

**Purpose:** make the language-neutral session contract executable before networking or real harnesses.

**Tracer bullet:** validate a scripted run fixture, reduce its ordered events into a final session snapshot, and render that same snapshot in a standalone browser page.

**Deliverables:**

- PRP schemas for identities, capabilities, commands, events, requests, results, and terminal states;
- TypeScript types generated or checked against JSON Schema;
- fixture corpus for happy path, failure, interruption, duplicates, gaps, unknown optional fields, and unsupported required versions;
- deterministic reducer shared by CLI tests and browser devtools;
- first useful browser reference page using existing shadcn primitives;
- protocol compatibility/versioning policy.

**Tests/evidence:** schema validation, golden fixture tests, reducer idempotency, gap detection, forward-compatibility tests, browser screenshot.

**Owners/review:** CodexCoder protocol/reducer; ClaudeCoder may implement the isolated browser page after schemas stabilize; UXDesigner reviews component selection and screenshot; QA runs CLI and browser tutorials.

**Depends on:** Phase 0.

**Human checkpoint:** edit or choose a fixture, run validation, open the browser replay page, and verify the final snapshot and event timeline.

## Phase 2 — Local runner plus fake harness end to end

**Purpose:** prove a full native session without network access, a real model, or Paperclip core.

**Tracer bullet:** the mock core starts the local runner, the scripted fake driver emits live lifecycle/tool/file/result events, the browser displays them, and a structured result closes the run exactly once.

**Deliverables:**

- deterministic runner process and process supervisor;
- local harness protocol over stdio, Unix socket, or loopback transport;
- scripted fake driver with configurable timing, errors, permission requests, and terminal outcomes;
- bounded logs and separation of process exit from semantic result;
- mock core command/event loop;
- browser live mode using the same reducer as replay.

**Tests/evidence:** driver conformance, process-group cleanup, duplicate command behavior, exactly-one terminal state, fake permission/input flows, browser live/replay parity.

**Owners/review:** CodexCoder implementation; SecurityEngineer process/credential boundary review; UXDesigner live-state review; QA runs the tutorial and captures screenshots.

**Depends on:** Phase 1.

**Human checkpoint:** start the mock core and runner, trigger scripted scenarios from the browser, interrupt one run, and replay it after completion.

## Phase 3 — Durable outbound transport and recovery

**Purpose:** prove the runner/network reliability model while still using only the mock core.

**Tracer bullet:** run over outbound WebSocket, intentionally disconnect or restart one side, reconnect, replay unacknowledged events, and finish without duplicates or a false new session.

**Deliverables:**

- outbound WSS hello/welcome/auth contract;
- bootstrap ticket and connection lease in the mock core;
- local durable outbox, cumulative ACKs, processed-command cache, backpressure, and diagnostics;
- reconnect, replay, reconciliation, drain, and revoke behavior;
- fault-injection commands for lost ACK, socket drop, runner restart, harness restart, and malformed input.

The Phase 3 implementation remains package-local. The mock core acts as the
remote control-plane peer and owns only test bootstrap tickets, leases,
commands, acknowledgements, and diagnostics. Phase 3 must not modify or import
`server/`, `ui/`, `packages/db/`, or production control-plane behavior.

The runnable proof must establish these recovery invariants:

- one stable runner, session, turn, item, command, and event identity survives reconnect;
- replay starts from durable acknowledgement and source-cursor state rather than creating a replacement session;
- a lost acknowledgement may repeat transport delivery but not the logical event or command effect;
- P0 lifecycle, request, artifact, verification, and terminal events are never dropped by backpressure;
- restart recovery either resumes the same durable session or reports an explicit recoverable failure;
- drain and revoke stop new work without silently discarding durable events;
- diagnostics explain connection, lease, outbox, acknowledgement, replay, and storage state without exposing secrets.

**Tests/evidence:** reconnect matrix, lost-ACK idempotency, command deduplication, source cursor continuity, P0 event preservation, bounded storage, secret-redaction tests.

The evidence bundle must include exact command output for each fault, a browser
screenshot of recovery diagnostics, a package verification record, and an OKF
journal entry that links decisions, failures, and fixes. The Phase 3 tutorial
must start with Simplified English sections that explain what the phase is and
what the runnable proof establishes. It must guide a human through at least a
socket drop, a lost acknowledgement, and one restart scenario. Add the tutorial
to the package index and cumulative end-to-end tutorial.

**Owners/review:** CodexCoder implementation; SecurityEngineer mandatory auth, secret, filesystem, and network review; QA executes the failure tutorial.

**Depends on:** Phase 2.

**Human checkpoint:** follow a “break it on purpose” tutorial and verify recovery status in both CLI diagnostics and browser UI. Do not create Phase 4 tasks until the human accepts this checkpoint.

## Phase 4 — Skillless Codex reference driver

**Purpose:** connect a real harness only after the runner contract is deterministic and recoverable.

**Tracer bullet:** the mock core launches a Codex app-server session with a compact task envelope, streams canonical events, accepts one human steer or interrupt, and returns a validated structured result without exposing Paperclip API instructions or credentials to the model.

**Deliverables:**

- direct Codex app-server driver;
- thread/session create, resume, read, turn, steer, interrupt, usage, and reconciliation mappings;
- skillless task envelope and semantic completion tools;
- model-context and environment inspection tests;
- capability-based degradation for unsupported functions;
- example application and tutorial using a safe local task.

**Tests/evidence:** common driver conformance, model-context snapshot, credential absence test, interruption without session loss, duplicate completion idempotency, resume/reconciliation test.

**Implementation evidence (2026-08-08):** the package now contains the direct
app-server v2 driver, compact envelope, separate finish/block tools, safe real
Codex example, canonical reducer/replay trace, capability degradation, focused
conformance suite, reference documentation, Simplified English tutorial, and
OKF evidence. The exact context snapshot proves automatic skill, app, and
collaboration instructions are disabled and the allowlisted child environment
contains no Paperclip or OpenAI bearer credential. Browser screenshots are not
applicable because Phase 4 changes no browser surface.

**Owners/review:** CodexCoder implementation; SecurityEngineer credential/context review; QA real-harness tutorial; CTO reviews semantic completion and status-authority boundary.

**Depends on:** Phase 3.

**Human checkpoint:** run a small Codex task, inspect the exact model envelope, steer or interrupt it, and verify the structured result and replay.

**Authorization and execution state (2026-08-08):** the human checkpoint for
Phase 3 is accepted, and the board has authorized Phase 4. Create one Phase 4
checkpoint issue with ordered implementation, security review, CTO contract
review, and QA tutorial children. Implementation remains entirely inside
`packages/paperclip-runner/` and uses the mock core; it must not modify or
import `server/`, `ui/`, `packages/db/`, or production control-plane behavior.
Security and CTO review start only after the runnable driver tracer is complete.
QA starts only after implementation and both reviews pass. Keep Phase 5 tasks
uncreated until the Phase 4 runnable demo, tests, package-local documentation,
tutorial, OKF journal entry, review gates, QA evidence, and human checkpoint are
complete.

## Phase 4b — Live Codex protocol Web UI

**Purpose:** prove that the Phase 4 Codex driver can power a useful live browser
experience before the package freezes a reusable browser SDK or touches the
Paperclip control plane.

**Ordering decision:** this is the correct next standalone test after Phase 4.
Phases 0–3 already provide the canonical protocol, reducer, mock core, and
recovery behavior. Phase 4 provides the real Codex thread/turn driver, steering,
interruption, reconciliation, and skillless result path. Phase 4b must not begin
until Phase 4 implementation, reviews, QA, and the human checkpoint are complete.
It does not depend on Phase 5 or Phase 6. Instead, it extracts the real-driver
browser tracer from the former Phase 5 scope; Phase 5 will generalize the proven
client and components into a stable SDK.

**Tracer bullet:** a standalone package-local Vite page connects to the mock
core and a real Codex app-server session, starts or resumes a chat, renders the
canonical event stream, steers an active turn, interrupts it gracefully, answers
or rejects runtime requests, shows parent/child agent activity, exercises Codex
goal operations when the installed app-server advertises them, and preserves a
replayable session after refresh or reconnect.

**Lowest-layer slices:**

1. extend the Phase 4 driver and canonical protocol only where the browser proof
   exposes a real gap: bidirectional app-server requests and responses,
   approval/permission/user-input lifecycles, goal capability discovery and
   operations, and parent/child thread lineage;
2. add a package-local browser transport and reducer adapter against the mock
   core, with no `server/`, `ui/`, `packages/db/`, or production API imports;
3. build the minimal live chat shell, then add protocol inspector and debugging
   controls without inventing a second event model;
4. add deterministic demo-chat manifests that exercise normal completion,
   mid-turn steering, graceful interruption and resume, command/file approval,
   user input, subagent visibility, goal set/view/pause/resume/clear when
   supported, reconnect, and replay;
5. run the real Codex path end to end, retain screenshots and exact command
   evidence, then run the service on this execution machine and report the
   reachable `paperclip-dev:PORT` in the checkpoint comment.

**Deliverables:**

- standalone browser demo under `packages/paperclip-runner/` with a package-local
  dev server and live connection to the mock core plus Phase 4 Codex driver;
- chat transcript, streaming assistant/reasoning/tool items, composer, explicit
  steer action, graceful stop/interrupt action, resume/reconnect state, and
  connection/session status;
- inline command, file-change, permission, tool, and user-input request cards
  with approve, approve-for-session when offered, reject, cancel, and resolved
  states derived from the upstream request contract;
- visible parent/child thread or subagent lineage, activity, terminal state, and
  unsupported-capability explanations instead of fabricated controls;
- goal command palette and durable goal banner for set/view/pause/resume/clear,
  gated by app-server capability/version detection; unsupported goal operations
  must be disabled with an exact diagnostic;
- protocol inspector showing canonical events, raw upstream method/event names,
  identities, sequence/cursor state, pending requests, capability negotiation,
  and redacted diagnostics;
- preloaded demo-chat manifests with expected observations and reset controls;
- selective source adaptation of compatible shadcn/ui and Vercel AI Elements
  primitives after UX review, with a component decision record and no dependency
  on the Paperclip application UI;
- package-local reference documentation, Simplified English hand-run tutorial,
  cumulative tutorial update, tutorial-index entry, screenshots, and OKF journal
  entry.

**Tests/evidence:** driver conformance for every newly exposed request/response
or capability; reducer live/replay parity; stale-turn steering rejection;
interrupt-before-start and interrupt-during-tool races; approval accept/reject,
request cleanup, and no double response; goal capability present/absent fixtures;
parent/child lineage and unsupported child-steering fixtures; reconnect and page
refresh recovery; secret-redaction and browser-boundary tests; component,
keyboard, and accessibility checks; deterministic demo-chat tests; a real Codex
end-to-end recording; screenshots; exact startup command; bound host and port;
and the final `paperclip-dev:PORT` handoff.

**Security and credential rule:** use the execution environment's existing Codex
authentication through the same Phase 4 allowlisted driver path. Never serialize
credentials to browser state, fixtures, screenshots, diagnostics, protocol
events, or documentation. The browser talks only to the package-local demo
server/mock core; it does not receive provider credentials or Paperclip API
credentials.

**Owners/review:** UXDesigner reviews the interaction map and adapted component
choices before UI implementation; CodexCoder owns driver/protocol/server work;
ClaudeCoder or CodexCoder owns the package-local React UI after UX review;
SecurityEngineer reviews credentials, approvals, browser transport, filesystem,
and debug output; CTO reviews the protocol boundary and goal/subagent capability
semantics; QA executes every demo chat, the clean-start tutorial, reconnect, and
the reported machine port. Require screenshots for UX and QA review.

**Depends on:** completed and human-accepted Phase 4. Phase 4b blocks Phase 5.

**Human checkpoint:** open the reported `paperclip-dev:PORT`, run the preloaded
demo chats, steer and interrupt a live Codex turn, resolve at least one real
request, inspect subagent/goal state when supported, refresh and replay the same
session, and approve or revise the interaction contract. Do not create Phase 5
tasks until this checkpoint records acceptance and every Phase 4b gate passes.

**Authorization and execution state (2026-08-08):** Phase 4 implementation,
security review, CTO contract review, QA validation, and the isolation-evidence
follow-up are complete. The board accepted the Phase 4 result and explicitly
authorized Phase 4b execution. Create one Phase 4b checkpoint issue with
parallel lowest-layer protocol/server and UX decision work, followed by the
browser implementation, Security and CTO reviews, QA tutorial execution, and a
human checkpoint. Keep every change and all evidence inside
`packages/paperclip-runner/` on the existing branch. The board also authorized
Phase 5 conditionally: do not create or start Phase 5 until the complete Phase
4b tracer, targeted and package acceptance tests, package-local documentation,
tutorial, screenshots, OKF journal entry, review gates, QA evidence, live
service handoff, and human checkpoint are complete.

**Lowest-layer implementation evidence (2026-08-08):** the driver/protocol and
demo-server slice is implemented under `packages/paperclip-runner/`. It adds a
Codex 0.132.0 deterministic conformance fixture, typed browser resolution for
command/file/permission/user-input/elicitation requests, same-turn steering
acknowledgement and stale rejection, queued pre-start interruption and terminal
race semantics, capability-probed goals, upstream-derived parent/child lineage,
exact resume/replay identity, bounded redaction, and an HTTP/SSE demo server
with a fixed server-owned workspace and server-only Codex authentication. The
real server evidence records one exact file result, one semantic result, one
terminal, continuous source sequence, stable reconnect identity, and explicit
runtime goal unavailability. Browser rendering, screenshots, reviews, QA, live
service handoff, and the human checkpoint remain later Phase 4b gates.

## Phase 5 — Browser reference console and reusable SDK surface

**Purpose:** generalize the Phase 4b browser proof into a stable reference
implementation and reusable SDK surface that package users can adopt without the
Paperclip app.

**Tracer bullet:** a second small example app consumes the extracted TypeScript
client/reducer/component APIs, runs against fake and real drivers, and reproduces
the accepted Phase 4b lifecycle without importing demo internals.

**Deliverables:**

- extracted and versioned browser transport, TypeScript client/reducer, and
  reusable component contracts based on the accepted Phase 4b behavior;
- standalone browser devtools/reference app plus a separate minimal SDK consumer;
- phase strip, timeline, connection health, composer, tool/file/plan/terminal
  views, request adapters, inspector, replay controls, and extension points;
- selective adaptation of compatible shadcn/ui and AI Elements source components;
- accessibility and design-token compliance;
- screenshots and component decision record explaining reused, adapted, and rejected components.

**Tests/evidence:** reducer parity, browser component tests, keyboard/a11y checks, screenshot set, reconnect/gap recovery, `pnpm check:token-gates` for any Paperclip UI files touched.

**Owners/review:** UXDesigner creates/reviews the component plan first; ClaudeCoder or CodexCoder implements after UX approval; QA performs browser validation and screenshot review.

**Depends on:** completed and human-accepted Phase 4b. Do not run it in parallel
with Phase 4b because it freezes APIs from the live proof. Phase 5 is
conditionally authorized, but its issue graph remains uncreated until the Phase
4b checkpoint records all required passing evidence.

**Human checkpoint:** use the browser tutorial as a small SDK consumer, run fake and real-driver sessions, and give UI feedback before Paperclip integration starts.

## Phase 6 — Thin Paperclip integration adapter

**Purpose:** prove integration with the product without moving runner responsibilities into the core or changing legacy behavior.

**Tracer bullet:** behind a feature flag, one Paperclip task uses the same package contract and reducer already proven against the mock core; legacy tasks continue on the current adapter path.

**Precondition:** explicit board acceptance of Phases 0–5 and CTO approval of the integration design. No production integration issue starts before this gate.

**Gate status (2026-08-09):** the board accepted Phase 5 and authorized Phase 6
to start. Create the Phase 6 issue graph now, but keep implementation blocked on
the integration design and keep QA blocked on implementation plus the mandatory
Security and CTO reviews.

**Design gate record:** the proposed narrow port, feature flag, runtime mode,
kill switch, company/auth/governance boundary, persistence/replay mapping,
implementation sequence, exact file allowlist, test matrix, and tutorial
commands are in
[`docs/design/phase-6-thin-paperclip-adapter.md`](../docs/design/phase-6-thin-paperclip-adapter.md).
No Phase 6 implementation code starts until the CTO gate accepts that record.

**Deliverables:**

- a package-owned `NativeSessionBackend`, a server-bound Paperclip
  `ControlPlanePort`, and a narrow core seam that only composes them;
- feature-flagged runtime selection;
- mapping to existing workspace preparation/finalization, cancellation, budgets, approvals, audit, and issue status authority;
- native event persistence/replay adapter using the proven schema;
- legacy compatibility tests and kill switch;
- integration tutorial that starts with mock mode, then enables one local Paperclip native run.

**Tests/evidence:** contract suite runs against mock and real Paperclip adapters, legacy regression suite is unchanged, company scoping, cancellation, finalization, approval, audit, budget, and workspace tests pass.

**Owners/review:** CodexCoder implementation; SecurityEngineer mandatory company/auth/governance review; CTO mandatory architecture review; QA validates both native and legacy paths.

**Depends on:** Phases 4 and 5.

**Human checkpoint:** enable the feature flag for one test task, compare mock and product behavior, inspect replay and finalization, then disable it and confirm legacy behavior remains intact.

## Phase 7 — Portability, provider simulation, and release-quality reference kit

**Purpose:** prove that the package is an SDK/reference implementation rather than a Codex-only product feature.

**Tracer bullet:** run the same conformance scenario through a second driver or fake hosted-provider backend without changing protocol, reducer, browser, or tutorial structure.

**Deliverables:**

- ACP/acpx driver proof or another approved second driver;
- fake remote backend and provider capability matrix;
- standalone MCP binding and credential-plan fixtures;
- channel/media boundary fixtures that terminate at the mock core;
- chaos suite and benchmark matrix;
- complete tutorial index, cumulative end-to-end tutorial, architecture/reference docs, and OKF knowledge graph/journal;
- release readiness report with remaining production gaps.

**Tests/evidence:** cross-driver conformance, fake-provider dedupe/reconciliation/cancellation, MCP/credential isolation, channel authorization boundary, chaos results, cold/warm performance report, clean-start tutorial run by QA.

**Owners/review:** CodexCoder implementation; EvalsEngineer/Performance Analyst for conformance and benchmarks when available; SecurityEngineer review; DevRel documentation review; QA full clean-room validation; CTO final review.

**Depends on:** Phase 6 for product integration evidence, while standalone provider fixtures may begin after Phase 5.

**Human checkpoint:** follow the cumulative tutorial from a clean checkout, compare two backend/driver paths, browse the journal and screenshots, and decide whether to proceed from spike/reference kit to production rollout.

## Phase dependency graph and task-creation policy

```text
PAP-16717 Plan and phase governance
  ├─ Phase 0 Boundary/journal/skeleton            create now
  ├─ Phase 1 Protocol/fixtures/replay             create now; blocks on Phase 0
  ├─ Phase 2 Local runner/fake harness             deferred; blocks on Phase 1
  ├─ Phase 3 Durable transport/recovery            complete
  ├─ Phase 4 Skillless Codex driver                 implemented; review pending
  ├─ Phase 5 Browser SDK/reference console         deferred; blocks on Phase 3
  ├─ Phase 6 Paperclip integration adapter          deferred; blocks on Phases 4 and 5 + board gate
  └─ Phase 7 Portability/release reference kit     deferred; blocks on Phase 6 for final closure
```

Create child issues for Phase 0 and Phase 1 only. Do not create Phase 2 through Phase 7 issues until the Phase 0–1 human checkpoint is complete and this plan and the spike specification have been revised with measured findings.

An active phase can contain these grandchildren when needed:

1. implementation issue assigned to CodexCoder or ClaudeCoder;
2. documentation/tutorial/journal issue assigned to the implementer with DevRel review;
3. UX review issue for browser-visible work, requiring screenshots;
4. SecurityEngineer review issue for auth, credentials, network, filesystem, MCP, company scope, governance, or provider work;
5. QA validation issue with exact acceptance criteria and tutorial commands;
6. CTO review interaction for architecture gates rather than an unowned comment request.

To honor the one-branch requirement, do not run multiple code-writing grandchildren concurrently against overlapping files. Parallel work is limited to review, research, documentation planning, fixtures, or disjoint paths. The phase parent remains open until all required grandchildren and the human checkpoint are complete.

## Risks and controls

- **Risk: standalone code quietly imports core internals.** Control: forbidden-import test and dependency review in Phase 0.
- **Risk: mock behavior diverges from Paperclip.** Control: one shared port contract and the same conformance suite against mock and real adapters in Phase 6.
- **Risk: UI library assumptions conflict with Vite/design tokens.** Control: source-level compatibility spike, selective adoption, UX review, token gates, no Next.js migration.
- **Risk: journal becomes write-only ceremony.** Control: OKF index pages, backlinks, decision/evidence fields, tutorial for querying it, and phase acceptance requiring retrieval of prior decisions.
- **Risk: real model work obscures runner defects.** Control: fake driver remains the primary deterministic suite; real Codex begins only in Phase 4.
- **Risk: one branch creates merge conflicts.** Control: dependency-ordered writers, disjoint scopes only, phase checkpoint commits, and no parallel overlapping implementation.
- **Risk: core integration expands into a rewrite.** Control: explicit Phase 6 gate, thin adapter, feature flag, kill switch, legacy regression tests, CTO review.
- **Risk: humans cannot exercise early layers.** Control: every phase includes a small executable tutorial and browser/CLI evidence, starting at Phase 0.

## Plan maintenance

Keep this plan and the spike specification current as implementation produces new evidence. At each human checkpoint:

1. record exact commands, results, screenshots, benchmarks, and known gaps in the package-local documentation and OKF journal;
2. update the normative spike specification when a contract, invariant, or acceptance criterion changes;
3. update this plan when sequencing, ownership, dependencies, or tutorial scope changes; and
4. create later phase issues only after the board has reviewed the preceding tracer bullets.

## Future work retained from the original implementation breakdown

The eight tracer phases above are the active sequencing model. The following issue-sized backlog is retained from the original spike specification so that detailed implementation scope is not lost. Treat these items as future work and planning input, not as authorization to create Phase 2–7 tasks before the Phase 0–1 checkpoint.


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
- `CredentialPlan`, work-signal, attention-request, five-kind interaction
  request/response, host-binding, failure, and delivery schemas;
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
- credential plans contain only opaque references/capabilities, never secret values.

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
- native interaction binding and response-delivery receipts;
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
- credential-plan materialization for environment and HTTP-broker modes.

**Acceptance:**

- restart runner with unacknowledged events and replay them;
- duplicate command produces one process effect;
- TERM/interrupt precedes KILL;
- outbox limit preserves P0 events;
- runner reports process exit separately from run result.
- secret values never enter the local outbox, diagnostics, or canonical events.

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
- typed `nativeFinalization` validation and complete terminal/arbitration handling;
- server-owned status arbiter for completion, blocker, review, attention, and continuation signals;
- the shared Section 18.13 status-authority corpus consumed without changing
  fixture expectations by arbiter, database, finalizer, migration, legacy, and
  UI tests;
- native interaction bridge binding, materialization, continuation projection,
  and response-delivery integration;
- native finalizer conformance tests for run status, issue status, continuation/review effects, and cancellation scope;
- cancellation hook;
- no behavior change for legacy adapters.

**Acceptance:**

- fake driver run completes through native-aware run/issue finalization and existing workspace finalization;
- native run can be cancelled through existing board controls;
- a missing or invalid native finalization discriminator fails closed instead of using the legacy success heuristic;
- an agent signal cannot move an issue to `blocked` or `in_review` without the required blocker or review path;
- human-needed requests persist and wake the correct owner without requiring an invalid issue status;
- `pnpm check:runner-phase5-spec` passes and implementation output reports a
  result for every `SD`, `TC`, `ATT`, `LIVE`, `REC`, `COMP`, and `MIG` fixture;
- a blocking semantic interaction yields only after durable materialization and
  resumes with a typed response without model-visible Paperclip credentials;
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
- `paperclip.finish`, `paperclip.block`, and the strict five-kind
  `paperclip.interact` union;
- provider-generated per-kind aliases that normalize to the canonical union;
- pending/resolved interaction task-envelope context and response cursors;
- structured result validator;
- no Paperclip API credential in harness;
- model-context test.

**Acceptance:**

- native prompt contains no Paperclip REST routes or heartbeat manual;
- harness environment contains no runner or broad Paperclip credential;
- duplicate finish tool call applies once;
- interaction replay and changed-payload idempotency conflict are deterministic;
- all five kinds resume with their complete typed response;
- exit zero without result enters server-owned assessment/recovery rather than
  granting an issue transition.

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
- five-kind interaction cards backed by snapshot/live/replay state;
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
- pending, progress, stale/superseded, and terminal interaction states render
  without being confused with runtime permissions or formal approvals;
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
- kind-specific issue-interaction response routing and delivery-cursor acknowledgement;
- optimistic command UI;
- race handling.

**Acceptance:**

- every operation has command ID and eventual terminal command result;
- duplicate clicks do not duplicate effects;
- interrupt/completion race is deterministic;
- runtime permissions remain separate from governance approvals;
- runtime permissions, issue-thread interactions, formal approvals, and
  execution review remain separate authority paths.

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
- interaction proposal/response/delivery replay and lost-ACK tests;
- runner/harness kill tests;
- explicit session-lost behavior.

**Acceptance:**

- reliability targets in Section 24.3;
- live and replay use the same reducer;
- no silent new session;
- terminal state remains exactly once;
- suggested-task materialization and resumed-run wakes remain at-most-once.

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
- environment, HTTP-broker, and provider-native credential-plan fixtures;
- channel and media side-channel fixtures;
- direct Codex and ACP/acpx standalone examples;
- phase-level benchmark commands and reports.

**Acceptance:**

- standalone and production integration use the same protocol schemas, fixtures, and reducer behavior;
- replay and reconnect tests pass without the full Paperclip application;
- MCP credentials remain outside model-visible configuration;
- broker fixtures prove that proxy capabilities are short-lived and long-term secret values never enter PRP;
- simulated voice interruption preserves normalized identities and durable audit events;
- simulated Slack/email/voice ingress terminates at the mock core gateway and cannot address the fake runner directly;
- the fake remote backend passes the common native-session conformance suite;
- benchmarks isolate runner and harness overhead from unrelated application startup.

**Dependencies:** NR-001, NR-004, NR-005; integrates with NR-007, NR-009, NR-010, and NR-012.

---

### NR-016 — Hosted-provider API qualification and first connector

**Goal:** Ground `RemoteAgentBackend` in real provider APIs and prove one production connector without changing the normalized session contract.

**Primary files:**

```text
server/src/services/native-runtime/backends/remote/
packages/paperclip-runner/backends/fake-remote/
packages/paperclip-runner/backends/provider-conformance/
```

**Deliverables:**

- dated, priority-sorted provider capability matrix covering AWS Bedrock AgentCore Runtime, Cloudflare Agents, Google Vertex AI Agent Engine, Microsoft Agent Framework/Foundry Hosted Agents, Cursor, Devin, GitHub Copilot cloud agent, and Jules;
- source links and captured API schemas/examples for every claimed capability;
- connector descriptor schema from Section 7.2.2;
- fake-provider fixtures for polling, webhook duplication, cursor gaps, ambiguous cancellation, and provider retention expiry;
- AWS AgentCore qualification spike covering runtime creation/versioning, endpoint invocation, HTTP/SSE/WebSocket behavior, session identity, async work, identity/secret binding, restart reconciliation, and cancellation gaps;
- first managed-runtime connector targeting AWS AgentCore unless access validation identifies a concrete blocker;
- second connector attempt targeting Cursor Cloud Agents after credential/access validation;
- reconciliation and terminal-state mapping report;
- explicit Paperclip-managed versus provider-managed execution ownership tests.

**Acceptance:**

- connector passes the same normalized session/event/result conformance suite as `RunnerBackend` where capabilities overlap;
- unsupported steering, approval, interrupt, cancel, resume, artifact, MCP, or usage features are declared and visible;
- provider event/message/activity IDs are preserved for deduplication;
- Paperclip restart can reconstruct the session from PostgreSQL plus provider reconciliation without relying on an old process or socket;
- Paperclip cancellation is durable even when provider cancellation is unavailable or unconfirmed;
- no provider-managed runtime is represented as a Paperclip environment lease or sandbox;
- Microsoft Agent Framework self-hosting is classified as a driver/host integration while Foundry Hosted Agents is classified as provider-managed execution;
- Cloudflare's channel primitives cannot bypass Paperclip core authorization, durable input, governance, or audit;
- provider-native workload identity and secret bindings use opaque `CredentialPlan` references rather than secret values in PRP;
- raw provider payload retention is bounded independently from canonical control-event retention.

**Dependencies:** NR-001, NR-002, NR-005, NR-006, NR-011, and NR-015.

---

### NR-017 — Native issue-thread interaction bridge

**Goal:** Complete the lossless skillless round trip for every current
issue-thread interaction kind without widening model or runner authority.

**Primary files:**

```text
packages/native-runtime-protocol/
packages/paperclip-runner/
server/src/services/native-runtime/native-interaction-bridge.ts
server/src/services/issue-thread-interactions.ts
server/src/services/heartbeat.ts
server/src/routes/native-runs.ts
ui/src/components/native-run/
```

**Deliverables:**

- canonical strict `paperclip.interact.v1` union and generated alias schemas;
- runner-side strict validation, host binding, payload hashing, and blocking-turn
  auto-yield;
- server bridge with current-run/session/turn/tool-call authorization and
  deterministic idempotency;
- additive binding and response-delivery persistence;
- P0 proposed/materialized/rejected/progressed/resolved/delivered events;
- normalized five-kind response projector and response-cursor acknowledgement;
- same/fresh-session continuation routing and inline resumed-run envelope data;
- Live Run Console rendering for all kinds and explicit separation from runtime
  permission, formal approval, and execution-review cards;
- cross-language schema, server integration, replay/chaos, security, resumed-run,
  and UI conformance fixtures from Section 27.9.

**Acceptance:**

- all five kinds complete request -> durable interaction -> authorized response
  -> resumed skillless run with no model-visible control-plane credential;
- duplicate proposal, resolver retry, reconnect, restart, or delivery replay
  causes no duplicate interaction, suggested task, verdict, wake, or UI card;
- stale target, user-comment/newer-request supersession, partial item verdicts,
  withdrawal, closure, and addressee deletion produce the typed durable outcome;
- changed-payload idempotency reuse, forged binding, cross-company references,
  unauthorized resolution, same-source self-resolution, low-trust creation, and
  model-authored trusted tool-action fields fail closed and are audited;
- blocking interaction yield and later resume preserve exactly-once turn
  terminalization while issue status remains server-owned;
- formal approvals and execution review keep their existing tables, routes,
  participants, governance checks, and audit semantics; and
- legacy adapters and existing dedicated REST/CLI/MCP/UI interaction surfaces
  remain compatible.

**Dependencies:** NR-001, NR-002, NR-005, NR-006, NR-008, NR-009, NR-010, and NR-011.

---

### Legacy suggested issue dependency graph

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
       NR-017 Interaction bridge
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
- interaction schemas, server response projection, and UI cards against the
  fake driver while provider drivers are built.

---
