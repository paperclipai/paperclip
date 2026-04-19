# 2026-04-06 Smart Model Routing

Status: Proposed
Date: 2026-04-06
Audience: Product and engineering
Related:
- `doc/SPEC-implementation.md`
- `doc/PRODUCT.md`
- `doc/plans/2026-03-14-adapter-skill-sync-rollout.md`

## 1. Purpose

This document defines a V1 plan for "smart model routing" in Paperclip.

The goal is not to build a generic cross-provider router in the server. The goal is:

- let supported adapters use a cheaper model for lightweight heartbeat orchestration work
- keep the main task execution on the adapter's normal primary model
- preserve Paperclip's existing task, session, and audit invariants
- report cost and model usage truthfully when more than one model participates in a single heartbeat

The motivating use case is a local coding adapter where a cheap model can handle the first fast pass:

- read the wake context
- orient to the task and workspace
- leave an immediate progress comment when appropriate
- perform bounded lightweight triage

Then the primary model does the substantive work.

## 2. Hermes Findings

Hermes does have a real "smart model routing" feature, but it is narrower than the name suggests.

Observed behavior:

- `agent/smart_model_routing.py` implements a conservative classifier for "simple" turns
- the cheap path only triggers for short, single-line, non-code, non-URL, non-tool-heavy messages
- complexity is detected with hardcoded thresholds plus a keyword denylist like `debug`, `implement`, `test`, `plan`, `tool`, `docker`, and similar terms
- if the cheap route cannot be resolved, Hermes silently falls back to the primary model

Important architectural detail:

- Hermes applies this routing before constructing the agent for that turn
- the route is resolved in `cron/scheduler.py` and passed into agent creation as the active provider/model/runtime

More useful than the routing heuristic itself is Hermes' broader model-slot design:

- main conversational model
- fallback model for failover
- auxiliary model slots for side tasks like compression and classification

That separation is a better fit for Paperclip than copying Hermes' exact keyword heuristic.

## 3. Current Paperclip State

Paperclip already has the right execution shape for adapter-specific routing, but it currently assumes one model per heartbeat run.

Current implementation facts:

- `server/src/services/heartbeat.ts` builds rich run context, including `paperclipWake`, workspace metadata, and session handoff context
- each adapter receives a single resolved `config` object and executes once
- built-in local adapters read one `config.model` and pass it directly to the underlying CLI
- UI config today exposes one main `model` field plus adapter-specific thinking-effort controls
- cost accounting currently records one provider/model tuple per run via `AdapterExecutionResult`

What this means:

- there is no shared routing layer in the server today
- model choice already lives at the adapter boundary, which is good
- multi-model execution in a single heartbeat needs explicit contract work or cost reporting will become misleading

## 4. Product Decision

Paperclip should implement smart model routing as an adapter-local, opt-in execution pattern.

V1 decision:

1. Do not add a global server-side router that tries to understand every adapter.
2. Do not copy Hermes' prompt-keyword classifier as Paperclip's default routing policy.
3. Add an adapter-specific "cheap preflight" phase for supported adapters.
4. Keep the primary model as the canonical work model.
5. Persist only the primary session unless an adapter can prove that cross-model session resume is safe.

Rationale:

- Paperclip heartbeats are structured, issue-scoped, and already include wake metadata
- routing by execution phase is more reliable than routing by free-text prompt complexity
- session semantics differ by adapter, so resume behavior must stay adapter-owned

## 5. Proposed V1 Behavior

## 5.1 Config shape

Supported adapters should add an optional routing block to `adapterConfig`.

Proposed shape:

```ts
smartModelRouting?: {
  enabled: boolean;
  cheapModel: string;
  cheapThinkingEffort?: string;
  maxPreflightTurns?: number;
  allowInitialProgressComment?: boolean;
}
```

Notes:

- keep existing `model` as the primary model
- `cheapModel` is adapter-specific, not global
- adapters that cannot safely support this block simply ignore it

For adapters with provider-specific model fields later, the shape can expand to include provider/base-url overrides. V1 should start simple.

## 5.2 Routing policy

Supported adapters should run cheap preflight only when all are true:

- `smartModelRouting.enabled` is true
- `cheapModel` is configured
- the run is issue-scoped
- the adapter is starting a fresh session, not resuming a persisted one
- the run is expected to do real task work rather than just resume an existing thread

Supported adapters should skip cheap preflight when any are true:

- a persisted task session already exists
- the adapter cannot safely isolate preflight from the primary session
- the issue or wake type implies the task is already mid-flight and continuity matters more than first-response speed

This is intentionally phase-based, not text-heuristic-based.

## 5.3 Cheap preflight responsibilities

The cheap phase should be narrow and bounded.

Allowed responsibilities:

- ingest wake context and issue summary
- inspect the workspace at a shallow level
- leave a short "starting investigation" style comment when appropriate
- collect a compact handoff summary for the primary phase

Not allowed in V1:

- long tool loops
- risky file mutations
- being the canonical persisted task session
- deciding final completion without either explicit adapter support or a trivial success case

Implementation detail:

- the adapter should inject an explicit preflight prompt telling the model this is a bounded orchestration pass
- preflight should use a very small turn budget, for example 1-2 turns

## 5.4 Primary execution responsibilities

After preflight, the adapter launches the normal primary execution using the existing prompt and primary model.

The primary phase should receive:

- the normal Paperclip prompt
- any preflight-generated handoff summary
- normal workspace and wake context

The primary phase remains the source of truth for:

- persisted session state
- final task completion
- most file changes
- most cost

## 6. Required Contract Changes

The current `AdapterExecutionResult` is too narrow for truthful multi-model accounting.

Add an optional segmented execution report, for example:

```ts
executionSegments?: Array<{
  phase: "cheap_preflight" | "primary";
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  usage?: UsageSummary;
  costUsd?: number | null;
  summary?: string | null;
}>
```

V1 server behavior:

- if `executionSegments` is absent, keep current single-result behavior unchanged
- if present, write one `cost_events` row per segment that has cost or token usage
- store the segment array in run usage/result metadata for later UI inspection
- keep the existing top-level `provider` / `model` fields as a summary, preferably the primary phase when present

This avoids breaking existing adapters while giving routed adapters truthful reporting.

## 7. Adapter Rollout Plan

## 7.1 Phase 1: contract and server plumbing

Work:

1. Extend adapter result types with segmented execution metadata.
2. Update heartbeat cost recording to emit multiple cost events when segments are present.
3. Include segment summaries in run metadata for transcript/debug views.

Success criteria:

- existing adapters behave exactly as before
- a routed adapter can report cheap plus primary usage without collapsing them into one fake model

## 7.2 Phase 2: `codex_local`

Why first:

- Codex already has rich prompt/handoff handling
- the adapter already injects Paperclip skills and workspace metadata cleanly
- the current implementation already distinguishes bootstrap, wake delta, and handoff prompt sections

Implementation work:

1. Add config support for `smartModelRouting`.
2. Add a cheap-preflight prompt builder.
3. Run cheap preflight only on fresh sessions.
4. Pass a compact preflight handoff note into the primary prompt.
5. Report segmented usage and model metadata.

Important guardrail:

- do not resume the cheap-model session as the primary session in V1

## 7.3 Phase 3: `claude_local`

Implementation work is similar, but the session model-switch risk is even less attractive.

Same rule:

- cheap preflight is ephemeral
- primary Claude session remains canonical

## 7.4 Phase 4: other adapters

Candidates:

- `cursor`
- `gemini_local`
- `opencode_local`
- external plugin adapters through `createServerAdapter()`

These should come later because each runtime has different session and model-switch semantics.

## 8. UI and Config Changes

For supported built-in adapters, the agent config UI should expose:

- `model` as the primary model
- `smart model routing` toggle
- `cheap model`
- optional cheap thinking effort
- optional `allow initial progress comment` toggle

The run detail UI should also show when routing occurred, for example:

- cheap preflight model
- primary model
- token/cost split

This matters because Paperclip's board UI is supposed to make cost and behavior legible.

## 9. Why Not Copy Hermes Exactly

Hermes' cheap-route heuristic is useful precedent, but Paperclip should not start there.

Reasons:

- Hermes is optimizing free-form conversational turns
- Paperclip agents run structured, issue-scoped heartbeats with explicit task and workspace context
- Paperclip already knows whether a run is fresh vs resumed, issue-scoped vs approval follow-up, and what workspace/session exists
- those execution facts are stronger routing signals than prompt keyword matching

If Paperclip later wants a cheap-only completion path for trivial runs, that can be a second-stage feature built on observed run data, not the first implementation.

## 10. Risks

## 10.1 Duplicate or noisy comments

If the cheap phase posts an update and the primary phase posts another near-identical update, the issue thread gets worse.

Mitigation:

- keep cheap comments optional
- make the preflight prompt explicitly avoid repeating status if a useful comment was already posted

## 10.2 Misleading cost reporting

If we only record the primary model, the board loses visibility into the routing cost tradeoff.

Mitigation:

- add segmented execution reporting before shipping adapter behavior

## 10.3 Session corruption

Cross-model session reuse may fail or degrade context quality.

Mitigation:

- V1 does not persist or resume cheap preflight sessions

## 10.4 Cheap model overreach

A cheap model with full tools and permissions may do too much low-quality work.

Mitigation:

- hard cap preflight turns
- use an explicit orchestration-only prompt
- start with supported adapters where we can test the behavior well

## 11. Verification Plan

Required tests:

- adapter unit tests for route eligibility
- adapter unit tests for "fresh session -> cheap preflight + primary"
- adapter unit tests for "resumed session -> primary only"
- heartbeat tests for segmented cost-event creation
- UI tests for config save/load of cheap-model fields

Manual checks:

- create a fresh issue for a routed Codex or Claude agent
- verify the run metadata shows both phases
- verify only the primary session is persisted
- verify cost rows reflect both models
- verify the issue thread does not get duplicate kickoff comments

## 12. Recommended Sequence

1. Add segmented execution reporting to the adapter/server contract.
2. Implement `codex_local` cheap preflight.
3. Validate cost visibility and transcript UX.
4. Implement `claude_local` cheap preflight.
5. Decide later whether any adapters need Hermes-style text heuristics in addition to phase-based routing.

## 13. Recommendation

Paperclip should ship smart model routing as:

- adapter-specific
- opt-in
- phase-based
- session-safe
- cost-truthful

The right V1 is not "choose the cheapest model for simple prompts." The right V1 is "use a cheap model for bounded orchestration work on fresh runs, then hand off to the primary model for the real task."
