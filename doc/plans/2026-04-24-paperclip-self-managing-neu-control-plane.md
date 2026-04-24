# Paperclip self-managing NEU control plane

Date: 2026-04-24
Repo: `/Users/nathanskene/Projects/paperclip`
Related project repo: `/Users/nathanskene/Projects/CellxGene-Census`

## Real question

Why did the Paperclip company not work out the right next step itself, and what architecture would let it keep a NEU-style project moving without Nathan manually heartbeating agents, re-planning the frontier, or restating the execution strategy?

## Live evidence

Observed from the live localhost company on 2026-04-24:

- Paperclip is reachable at `http://127.0.0.1:3100`.
- Company `NeurogenomicsLab` has 51 issues total.
- 31 issues are open and all 31 are `blocked`.
- The issue list/API currently exposes zero explicit `blockedByIssueIds` across those 31 blocked issues.
- `NEU-50` is blocked after repeated process-loss / operational-failure comments.
- `NEU-50` currently has no explicit blocker edge in the API, no live execution run, and no checkout run.
- The Founding Engineer previously looped on `NEU-50`, and the diagnostic script still flags a possible loop on that issue.

Observed from Paperclip core/docs:

- `doc/execution-semantics.md` says blocked issues should stay idle until blockers resolve.
- `server/src/services/heartbeat.ts` already checks dependency readiness during wake enqueue and queued-run claim.
- `server/src/services/heartbeat.ts` also skips wakes for `issue.status === "blocked"` when there is no allowed interaction wake.
- Release `v2026.416.0` already advertises first-class blocker dependencies with automatic wake-on-dependency-resolved.

## Verdict

Paperclip did not fail because the agents were too dumb.
It failed because the control plane still has an authority gap between:

1. issue status labels,
2. explicit dependency graph,
3. queued-run hygiene,
4. external-state monitoring, and
5. project-level execution-mode pivots.

In short: the company cannot reliably self-manage because Paperclip still knows how to wake agents, but it does not yet know enough to decide when not to wake them, when a blocked board is malformed, or when a project should pivot from one execution strategy to another.

## Why it did not work itself out

### 1. `blocked` is present, but the graph is not authoritative

The NEU board is visually/status-wise blocked, but the live issue API exposes no explicit blocker edges for the blocked frontier.

That means Paperclip cannot safely infer:

- which issue should unlock next,
- which blocked issue is malformed versus legitimately waiting,
- whether a blocked issue should be automatically unblocked,
- whether a parent/meta issue should be decomposed before waking an executor.

Status alone is not enough for autonomous execution.

### 2. Wake gating exists, but only protects against obviously bad wakes

Paperclip already has useful protections:

- skip blocked issues with unresolved blockers,
- skip blocked issues without allowed interaction wakes,
- coalesce duplicate same-agent runs,
- avoid some duplicated execution on an already-running issue.

But those are defensive gates, not a full project controller.
They stop some waste; they do not decide the next correct frontier.

### 3. No deterministic project watcher is monitoring the real external state

For NEU, the real frontier depends on facts outside the issue thread:

- release artifacts on disk,
- HPC/build status,
- whether `atlas/combined` exists,
- whether a monolithic build has failed enough times to be declared unfit,
- whether shard outputs are complete and merge-ready.

Paperclip core does not know those things by default.
Without a project-specific controller, the company can only reread issue comments and guess.

### 4. No execution-mode pivot is encoded

`NEU-50` is the clear example.
The company learned that the monolithic local atlas build is operationally fragile, but there is no explicit control-plane rule that says:

- classify repeated storage / SIGKILL / process-loss failures as `monolith_unfit`
- stop retrying the same shape
- switch the project to `sharded_local` or `sharded_hpc`
- create or wake the concrete next implementation task

So the company stalls instead of pivoting.

### 5. Parent/meta issue overload prevents an executable frontier

`NEU-50` is still doing too many jobs at once:

- strategy choice,
- code-path implementation,
- production execution,
- validation,
- handoff.

A self-managing company needs smaller first-class issues so the control plane can advance one real frontier step at a time.

## What Paperclip needs to do this itself

## A. Core Paperclip upgrades

### A1. Central wake-eligibility service

One authoritative service in Paperclip core should classify every wake request before queueing or claiming it.

Output should include:

- `allowed`
- `skipped`
- `deferred`
- machine reason
- human reason
- issue status
- blocker summary
- run summary
- interaction allowance

Use it for:

- issue assignment wakes
- comment/mention wakes
- manual wakes
- scheduler wakes
- startup recovery
- queued-run claim path

### A2. Graph-health diagnostics

Paperclip should treat `blocked + no blocker edges` as an invalid/incomplete execution graph, not a normal resting state.

Need a graph-health service / endpoint / UI surface that reports:

- blocked issues with no explicit blockers
- blockers all done but issue still blocked
- cycles / impossible edges
- queued or running wakes against blocked issues
- direct frontier-ready dependents

### A3. Queued-run hygiene

Add deterministic hygiene that continuously classifies runs as:

- queued healthy
- queued stale
- queued blocked-ineligible
- queued terminal-ineligible
- duplicate queued
- running active
- running stalled
- running external-wait
- terminal success / failure / inconclusive

Policy:

- cancel or suppress queued runs on blocked/done/cancelled issues
- cancel duplicates
- surface stalled runs with evidence
- do not keep infinite-waking the same failure mode

### A4. Better blocker exposure in list/get APIs and UI

Project controllers and operators need blocker summaries directly in the list/get surfaces they already use.
The graph cannot be authoritative if it is difficult to see or absent from the main issue data path.

### A5. Project-controller/plugin contract

Paperclip core should not hardcode NEU-specific HPC logic.
Instead, it should provide a plugin/controller contract for deterministic external-state checks.

Controller responsibilities:

- queue audit
- graph audit
- artifact existence checks
- job-status checks
- safe idempotent issue transitions
- review routing
- frontier unlocking

## B. NEU-specific controller behavior

Implement a deterministic NEU controller in `CellxGene-Census`, then let Paperclip invoke it.

### B1. Queue and graph audit

Commands should include:

- `status`
- `queue-audit`
- `graph-audit`
- `reconcile-blockers --dry-run/--apply`
- `route-reviews --dry-run/--apply`
- `unlock-frontier --dry-run/--apply`

### B2. External-state checks

The controller should inspect:

- audited release root
- shard manifests
- shard output counts
- `atlas/assay_specific/*`
- `atlas/combined/*`
- HPC/buildctl state
- final artifact readability / shape

### B3. Execution-mode pivot logic

For atlas-stage work, make execution mode explicit:

- `monolithic_local`
- `sharded_local`
- `sharded_hpc`

Pivot rule:

If repeated failures show storage exhaustion, process loss, exit 137, or equivalent monolithic fragility, classify the current mode as `monolith_unfit` and stop retrying it.

Then:

1. comment evidence on the issue,
2. set or persist execution mode,
3. materialize concrete shard-first child tasks,
4. wake only the next implementation role.

### B4. Meta-issue decomposition

Convert overloaded frontier issues into explicit child tasks such as:

- add atlas shard selection support
- add atlas shard manifest and runner
- add assay-specific shard merge validator
- run production shards
- merge and verify assay-specific root
- run / verify `atlas/combined`

That creates an actually executable frontier.

## C. Cheap-model triage, but only for ambiguity

Use a cheaper model only when deterministic checks cannot resolve ambiguity, for example:

- the graph is missing and needs repair suggestions,
- run logs need failure-class classification,
- several ready issues exist and a tie-break is needed,
- a summary for a human/operator is needed.

Do not use models for:

- polling,
- waiting,
- file existence,
- job status,
- queue hygiene,
- blocker readiness,
- repeated "check again" wakes.

Cheap-model output should be structured advisory JSON and never mutate state directly.

## Recommended phased plan

### Phase 1: Paperclip core control-plane hygiene

1. Add central wake-eligibility service.
2. Route all wake sources through it.
3. Add graph-health diagnostics.
4. Add queued-run hygiene.
5. Expose blocker summaries consistently in API/UI.

### Phase 2: NEU controller dry-run

1. Finish the deterministic NEU controller in `CellxGene-Census`.
2. Prove it says `do nothing` when frontier state is unchanged.
3. Prove it detects malformed blocked issues and monolith-unfit evidence.

### Phase 3: Safe apply mode

1. Allow only idempotent controller mutations.
2. Reconcile blocker edges.
3. Unlock direct dependents only.
4. Route reviews without duplicate wakes.
5. Apply execution-mode pivots with evidence.

### Phase 4: Productise the generic pieces

Promote reusable pieces from NEU into Paperclip core/UI:

- wake-eligibility preview
- graph-health panel
- queued-run hygiene actions
- suppressed-wake logs
- frontier-ready view
- project-controller/plugin hooks

## Bottom line

The answer is not "make the CEO smarter".

The answer is:

- make the blocker graph authoritative,
- make wake eligibility universal,
- add queued-run hygiene,
- give Paperclip a deterministic project-controller hook for external state,
- encode execution-mode pivots like `monolith_unfit -> shard-first`,
- and use models only for ambiguity, not polling.

That is how Paperclip starts doing this itself instead of waiting for Nathan to notice the board is blocked in a way the control plane cannot yet interpret.
