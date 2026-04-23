# Paperclip hybrid control plane Autoplan

Date: 2026-04-23
Repo: `/Users/nathanskene/Projects/paperclip`
Related NEU repo: `/Users/nathanskene/Projects/CellxGene-Census`

## Autoplan verdict

Nathan's objection is right: a fully deterministic controller is too brittle if it tries to encode project judgment, ambiguous recovery, scientific interpretation, or prioritisation. But using cheap models for polling, dependency checks, file checks, or queue control would recreate the current failure mode with lower-cost tokens.

The right design is a hybrid control plane:

1. Deterministic gates for facts, invariants, idempotency, and "do nothing" decisions.
2. Cheap model triage only for ambiguous interpretation.
3. Strong agents only when there is real implementation/review/science work to do.
4. Project Lead for exception/stage-transition decisions, not generic CEO cosplay.

This means: do not build a deterministic "CEO". Build deterministic safety rails plus model-assisted exception handling.

## Facts observed during Autoplan

Paperclip core already has useful pieces:

- `doc/execution-semantics.md` distinguishes hierarchy from dependency semantics and says blocked issues should stay idle until blockers resolve.
- `packages/db/src/schema/issue_relations.ts` stores explicit blocker edges with `type = "blocks"`.
- `server/src/services/heartbeat.ts` has a dependency gate in `enqueueWakeup`: it calls `issuesSvc.listDependencyReadiness` and skips with `issue_dependencies_blocked` when unresolved blockers exist.
- `server/src/services/heartbeat.ts` also coalesces/defer wakes when an issue already has an active execution run.
- The heartbeat run schema already has liveness fields that can support run-health classification.

But the live NEU company state previously showed the actual control-plane gap:

- Many issues are visually/status-wise blocked, but explicit blocker metadata is absent or not exposed consistently.
- Queued Founding Engineer runs exist against blocked issues.
- D-07's final artifact is missing while HPC jobs are/were running, so downstream LLM wakes are wasteful.

So the problem is not "no deterministic logic exists". It is that the authoritative graph, wake gates, stale queued-run hygiene, and external-state monitoring are not yet coherent end-to-end.

## Principle: deterministic first, not deterministic only

Use deterministic code for:

- issue status checks
- dependency readiness
- wake eligibility
- queued/running run hygiene
- artifact existence
- HPC/buildctl status parsing
- parquet shape/readability checks
- idempotency keys and cooldown windows
- safe transitions and "do nothing" decisions
- budget caps

Use cheap models for:

- interpreting ambiguous issue text when blocker graph is missing
- proposing graph repair when charter and board disagree
- classifying run logs/transcripts as useful progress vs stall/waiting/handoff-needed
- summarising project health for humans
- triaging failure logs into likely infra/code/data/science classes
- breaking ties between several ready frontier tickets

Use strong agents for:

- code changes
- technical review
- biological/scientific review
- exception handling when the cheap triage is low confidence
- charter/scope changes

Do not use models for:

- polling
- checking whether a file exists
- waiting for jobs
- deciding whether an issue with unresolved blockers should run
- repeated heartbeat nudging
- queue hygiene

Cheap model output should be advisory structured JSON. It should not directly mutate Paperclip state. Deterministic checks must validate every recommended action before apply mode.

## Target architecture

```text
Paperclip API / DB
  |
  | issues, blocker relations, runs, wakeups, comments
  v
Deterministic controller
  |-- wake eligibility
  |-- graph health
  |-- run health
  |-- artifact/HPC checks for project plugins
  |
  | emits:
  | no_change | safe_transition | ambiguous_exception | hard_failure
  v
Decision router
  |-- no_change: do nothing
  |-- safe_transition: apply idempotent mutation if apply mode enabled
  |-- ambiguous_exception: cheap Project Lead triage
  |-- hard_failure: Project Lead/human escalation
  v
Agents
  |-- Founding Engineer: implementation/finalisation
  |-- Code Reviewer: technical review
  |-- Bioinformatics Scientist: biological validation
  |-- Project Lead: exception/stage transition
  |-- Nathan: real scientific/product decision only
```

## Component A: Paperclip wake eligibility service

Create one central `wakeEligibility` service in Paperclip core.

Inputs:

- companyId
- issueId if present
- agentId
- wake source/reason/context
- requester actor

Output:

- `allowed | skipped | deferred | interaction_allowed`
- machine reason
- human-readable reason
- unresolved blockers
- issue status
- active/queued run summary
- wake class

Rules:

- `done`/`cancelled`: no executor wake except explicit human reopen/comment interaction.
- `blocked` with unresolved blockers: no executor wake.
- `blocked` with no explicit blockers: do not run executor; classify as `blocked_no_blocker_edges` and surface graph repair.
- `in_review`: reviewer wakes allowed; executor wakes only on explicit reopen/assignment.
- `in_progress`: continuation allowed only when dependency-ready and no active execution run.
- `todo`: start/assignment allowed only when dependency-ready and no duplicate active/queued run.
- human comment/mention can allow bounded interaction mode, but not full implementation on blocked work.

Call this service from every wake path:

- issue assignment/status updates
- issue comments/mentions
- manual wake endpoints
- `enqueueWakeup`
- queued-run claim path
- startup/periodic reconciliation

Why this matters: Paperclip already has partial gating inside `enqueueWakeup`, but all wake sources need one policy, and already-queued bad runs need cleanup.

## Component B: queued-run hygiene

Add periodic/read-only-then-apply hygiene for pending runs.

Classifications:

- queued_healthy
- queued_stale
- queued_ineligible_blocked
- queued_ineligible_terminal_issue
- queued_missing_issue
- duplicate_queued
- running_active
- running_quiet
- running_stalled
- running_external_wait
- terminal_success
- terminal_failed
- terminal_inconclusive

Apply policy:

- queued run on blocked/done/cancelled issue: cancel/skip with visible reason.
- queued run whose issue has no explicit blockers but is status `blocked`: quarantine/cancel; ask Project Lead/graph repair rather than run.
- duplicate queued run for same agent+issue: coalesce/cancel duplicate.
- running quiet: do not immediately kill; classify and surface evidence.
- running stalled beyond threshold: retry once if safe, otherwise block issue with evidence.
- repeated recovery failure: block/comment; do not infinite-wake.

This specifically closes the observed failure mode of queued Founding Engineer runs against blocked downstream work.

## Component C: blocker graph health

Paperclip should treat explicit blocker graph as the source of truth for autonomous execution.

Add a graph-health diagnostic service/endpoint returning:

- blocked issues with no explicit blockers
- blockers all done but issue still blocked
- unresolved blockers
- cycles/impossible edges
- parent/child structures that look like implicit dependencies but have no blocker edges
- downstream ready frontier
- queued/running runs against blocked issues

Required API/product behaviour:

- list/get issue APIs should expose blocker summaries consistently.
- Board/UI should show `blocked but no blockers` as invalid/incomplete, not normal.
- status=`blocked` alone must not be treated as an executable dependency graph.

## Component D: NEU project controller/plugin

Keep NEU-specific logic out of generic Paperclip core initially.

In `/Users/nathanskene/Projects/CellxGene-Census`, build/finish `tools/neu_control.py` with dry-run first:

Commands:

- `status`
- `queue-audit`
- `graph-audit`
- `reconcile-blockers --dry-run/--apply`
- `monitor-d07 --dry-run/--apply`
- `route-reviews --dry-run/--apply`
- `unlock-frontier --dry-run/--apply`
- `summary --json`

D-07 state machine:

- jobs queued/running + final artifact missing: no Paperclip mutation; no LLM wake.
- jobs failed + final artifact missing: comment evidence, set NEU-18 blocked, wake Project Lead.
- jobs complete + final artifact missing: wake Founding Engineer to merge/finalise.
- final artifact exists + shape passes: comment evidence and route to review.
- final artifact exists + shape fails: block NEU-18 with evidence; wake Project Lead or Founding Engineer depending on error class.
- NEU-18 in review: wake Code Reviewer; then Bioinformatics Scientist if biological signoff needed.

Artifact checks for D-07:

- `builds/shards/human-2025-11-08-log1p/manifest.json`
- `data/full-human-2025-11-08-raw-merged/census_pseudobulk_log1p_mean.parquet`
- shard output counts
- failed job logs if available
- final parquet readability and expected metadata/shape where cheap enough

Current interpretation from the earlier live state: if HPC jobs are running and final artifact is missing, the correct action is wait/no wake.

## Component E: cheap model triage

Add a narrow optional model triage command/service after deterministic classification.

Input JSON:

- issue summary
- blocker graph summary
- recent comments/activity
- run log excerpts
- artifact/HPC state
- deterministic classification

Output JSON:

- `classification`: `useful_progress | waiting_external | needs_human | likely_looping | likely_done_no_handoff | graph_repair_needed | failure_triage`
- confidence
- evidence lines
- recommended next action
- whether strong Project Lead escalation is needed

Guardrails:

- no mutation authority
- deterministic verifier checks recommendation before apply
- confidence threshold
- cooldown: at most one triage per issue/run per window
- store the triage as evidence/activity when useful
- fallback is Project Lead/human escalation, not waking a Founding Engineer loop

## Phased implementation plan

### Phase 1: Paperclip core diagnostics and hygiene

1. Add central wake eligibility service.
2. Refactor existing wake paths to use it.
3. Add queued-run hygiene in read-only mode first.
4. Expose blocker summaries consistently in issue list/get API.
5. Add graph/run health diagnostic endpoint.
6. Add tests:
   - blocked issue with unresolved blocker does not enqueue executor run.
   - blocked issue with no blocker edges is classified invalid and does not run executor.
   - queued run on blocked issue is cancelled/skipped by hygiene.
   - done/cancelled issue wake is skipped.
   - human comment/mention interaction exception still works.
   - blocker completion wakes only direct dependents whose blockers are all done.

### Phase 2: NEU controller dry-run

1. Implement/read-only `tools/neu_control.py` in CellxGene-Census.
2. Report queue health, graph health, and D-07 state.
3. Verify it says no wake when jobs are running and final artifact is missing.
4. No Paperclip mutations.

### Phase 3: NEU safe apply mode

1. Apply only idempotent, evidence-backed mutations.
2. Reconcile blockers only when D-ticket mapping is unambiguous.
3. Unlock only direct dependents of completed blockers.
4. Route reviews with dedupe/cooldown.
5. Keep all ambiguous cases as cheap model triage or Project Lead escalation.

### Phase 4: cheap model triage

1. Implement structured triage as advisory only.
2. Add deterministic verifier for suggested actions.
3. Add cooldowns and evidence persistence.
4. Use it for ambiguity, not polling.

### Phase 5: productise from NEU learnings

Promote generic pieces into Paperclip core/UI:

- wake eligibility preview
- graph health panel
- run health dashboard
- queued-run hygiene actions
- suppressed wake logs
- frontier-ready view
- project controller/plugin interface

Keep project-specific artifact/HPC/parquet checks in NEU plugin/controller.

## Immediate recommendation

Do not manually wake more agents while D-07 jobs are running and the final artifact is missing.

Next engineering issue should be:

`Paperclip wake eligibility + queued-run hygiene + graph health diagnostics`

Separate NEU issue should be:

`NEU controller dry-run: queue audit, blocker graph audit, D-07 monitor`

This resolves the objection by not pretending everything can be deterministic, while still keeping models away from the parts where they are most wasteful and unsafe.
