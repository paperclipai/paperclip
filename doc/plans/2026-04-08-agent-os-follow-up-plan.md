# PAP-1229 Agent OS Follow-up Plan

Date: 2026-04-08
Related issue: `PAP-1229`
Companion analysis: `doc/plans/2026-04-08-agent-os-technical-report.md`

## Goal

Turn the `agent-os` research into a low-risk Paperclip execution plan that preserves Paperclip's control-plane model while testing the few runtime ideas that appear worth adopting.

## Decision summary

Paperclip should not absorb `agent-os` as a product model or orchestration layer.

Paperclip should evaluate `agent-os` in three narrow areas:

1. optional agent runtime for selected local adapters
2. capability-based runtime permission vocabulary
3. snapshot-backed disposable execution roots

Everything else should stay out of scope unless those three experiments produce strong evidence.

## Success condition

This work is successful when Paperclip has:

- a clear yes/no answer on whether `agent-os` is worth supporting as an execution substrate
- a concrete adapter/runtime experiment with measurable results
- a proposed runtime capability model that fits current Paperclip adapters
- a clear decision on whether snapshot-backed execution roots are worth integrating

## Non-goals

Do not:

- replace Paperclip heartbeats, issues, comments, approvals, or budgets with `agent-os` primitives
- introduce Rust/sidecar requirements for all local execution paths
- migrate all adapters at once
- add runtime workflow/queue abstractions to Paperclip core

## Existing Paperclip integration points

The plan should stay anchored to these existing surfaces:

- `packages/adapter-utils/src/types.ts`
  - adapter contract, runtime service reporting, session metadata, and capability normalization targets
- `server/src/services/heartbeat.ts`
  - execution entry point, log capture, issue comment summaries, and cost reporting
- `server/src/services/execution-workspaces.ts`
  - current workspace lifecycle and git-oriented cleanup/readiness model
- `server/src/services/plugin-loader.ts`
  - typed host capability boundary and extension loading patterns
- local adapter implementations in `packages/adapters/*/src/server/`
  - current execution behavior to compare against an `agent-os`-backed path

## Phase plan

### Phase 0: constraints and experiment design

Objective:

- make the evaluation falsifiable before writing integration code

Deliverables:

- short experiment brief added to this document or a child issue
- chosen first runtime target: `pi_local` or `opencode_local`
- baseline metrics definition

Questions to lock down:

- what exact developer experience should improve
- what security/isolation property we expect to gain
- what failure modes are unacceptable
- whether the prototype is adapter-only or a deeper internal runtime abstraction spike

Exit criteria:

- a single first target chosen
- measurable comparison criteria agreed on

Recommended metrics:

- cold start latency
- session resume reliability across heartbeats
- transcript/log quality
- implementation complexity
- operational complexity on local dev machines

### Phase 1: `agentos_local` spike

Objective:

- prove that Paperclip can drive one local agent through an `agent-os` runtime without breaking heartbeat semantics

Suggested scope:

- implement a new experimental adapter, `agentos_local`, or a feature-flagged runtime path under one existing adapter
- start with `pi_local` or `opencode_local`
- keep Paperclip's existing heartbeat, issue, workspace, and comment flow authoritative

Minimum implementation shape:

- adapter accepts model/runtime config
- `server/src/services/heartbeat.ts` still owns run lifecycle
- execution result still maps into existing `AdapterExecutionResult`
- session state still fits current `sessionParams` / `sessionDisplayId` flow

What to verify:

- checkout and heartbeat flow still work end to end
- resume across multiple heartbeats works
- logs/transcripts remain readable in the UI
- failure paths surface cleanly in issue comments and run logs

Exit criteria:

- one agent type can run reliably through the new path
- documented comparison against the existing local adapter path
- explicit recommendation: continue, pause, or abandon

### Phase 2: capability-based runtime permissions

Objective:

- introduce a Paperclip-native capability vocabulary without coupling the product to `agent-os`

Suggested scope:

- extend adapter config schema vocabulary for runtime permissions
- prototype normalized capabilities such as:
  - `fs.read`
  - `fs.write`
  - `network.fetch`
  - `network.listen`
  - `process.spawn`
  - `env.read`

Integration targets:

- `packages/adapter-utils/src/types.ts`
- adapter config-schema support
- server-side runtime config validation
- future board-facing UI for permissions, if needed

What to avoid:

- building a full human policy UI before the vocabulary is proven useful
- forcing every adapter to implement capability enforcement immediately

Exit criteria:

- documented capability schema
- one adapter path using it meaningfully
- clear compatibility story for non-`agent-os` adapters

### Phase 3: snapshot-backed execution root experiment

Objective:

- determine whether a layered/snapshotted root model improves some Paperclip workloads

Suggested scope:

- evaluate it only for disposable or non-repo-heavy tasks first
- keep git worktree-based repo editing as the default for codebase tasks

Promising use cases:

- routine-style runs
- ephemeral preview/test environments
- isolated document/artifact generation
- tasks that do not need full git history or branch semantics

Integration targets:

- `server/src/services/execution-workspaces.ts`
- workspace realization paths called from `server/src/services/heartbeat.ts`

Exit criteria:

- clear statement on which workload classes benefit
- clear statement on which workloads should stay on worktrees
- go/no-go decision for broader implementation

### Phase 4: typed host tool evaluation

Objective:

- identify where Paperclip should prefer explicit typed tools over ambient shell access

Suggested scope:

- compare `agent-os` host-toolkit ideas with existing plugin and runtime-service surfaces
- choose 1-2 sensitive operations that should become typed tools

Good candidates:

- git metadata/status inspection
- runtime service inspection
- deployment/preview status retrieval
- generated artifact publishing

Exit criteria:

- one concrete proposal for typed-tool adoption in Paperclip
- clear statement on whether this belongs in plugins, adapters, or core services

## Recommended sequencing

Recommended order:

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4

Reasoning:

- Phase 1 is the fastest way to invalidate or validate the entire `agent-os` direction
- Phase 2 is valuable even if Phase 1 is abandoned
- Phase 3 should wait until there is confidence that the runtime approach is operationally worthwhile
- Phase 4 is useful independently but should be informed by what Phase 1 and Phase 2 expose

## Risks

### Technical risk

- `agent-os` introduces Rust sidecar and packaging complexity that may outweigh runtime benefits

### Product risk

- runtime experimentation could blur the boundary between Paperclip as control plane and Paperclip as execution platform

### Integration risk

- session semantics, log formatting, and failure behavior may degrade relative to current local adapters

### Scope risk

- a small runtime spike could expand into an adapter-system rewrite if not kept tightly bounded

## Guardrails

To keep this effort controlled:

- keep all experiments behind a clearly experimental adapter or feature flag
- do not change issue/comment/approval/budget semantics to suit the runtime
- measure against current local adapters instead of judging in isolation
- stop after Phase 1 if the operational burden is already clearly too high

## Proposed next action

The next concrete action should be a small implementation spike issue:

- title: `Prototype experimental agentos_local runtime for one local adapter`
- target adapter: `opencode_local` unless `pi_local` is materially easier
- expected output: code spike, short verification notes, and a continue/stop recommendation

If leadership wants planning only and no spike yet, this document is the handoff artifact for that decision.
