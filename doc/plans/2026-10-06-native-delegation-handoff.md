# Native delegation handoff repair

Date: 2026-10-06. Owner: this Codex task. Branch: `codex/delegation-handoff`.
Starting master: `0fe47882cfcb12082035113c59ca96091c46ebfc`.

## Finish line

A reopened ordinary native child can complete again and deliver one fresh completion
notification to its parent. Replaying the same committed completion remains
idempotent. Prepare a reviewed, verified PR; merging is a separate human action.

## Scope

The native status committer currently deduplicates parent notifications by the
parent/child pair. A consumed notification can therefore suppress a later
completion of the same child. Scope the key to the durable completion decision
in both parent-notification branches, including a child that is also a blocker.
Keep existing readiness, company, ownership, workspace finalization and governance
gates. Do not change model prompts, tools, dependency replacement semantics or
the outcome oracle. General dependency-only wake reconciliation is separate. Exact `task_watchdog`
children keep their existing stable wake key to avoid repeated watchdog loops;
near-match origin names remain ordinary children. Related open #10559 and
#4507 concern legacy wake deduplication; #11179 concerns delivery during an
active parent run; #13044 separately proposes suppressing watchdog signals.
The initial slice changed only the native committed-decision wake key. The
failed live trial below requires the bounded native delivery extension described here.

Prior procedure experiments in #15218 exposed stalled and premature parent
outcomes but do not alone prove this mechanism caused every failure. The
production relocation and earlier controller repairs were not shipped. #15296
shipped the smaller planning skills; its report publication is separate.

## Verification contract

1. Reproduce the consumed-wake collision against unchanged master production
   with the real database/control-plane conformance test. Cover parents with
   and without an explicit dependency edge, the latest child summary, and
   duplicate finalization.
2. Run relevant conformance checks, repository typecheck, tests and build.
   Preserve failures and distinguish environment limitations.
3. Freeze candidate and baseline branches on this master with identical
   Product E2E fixtures, graders, provider profiles and budgets. Run only
   `everyday-workflows.runner-codex.local.delegate-feedback` and
   `everyday-workflows.runner-acpx-claude.local.delegate-feedback` in each
   variant: one attempt each, 12-minute per-cell deadline, at most 12 story
   run records, 1,000-cent company and lead-agent hard stops, concurrency 2.
   No reroll of a completed behavior failure. All provider continuations and
   automatic recovery count in the actual run inventory.
4. Inspect original grades and retained chronology, including revised child
   delivery, worker ownership, parent review and parent completion ordering.
   A green workflow is not itself a behavioral pass. A single pair does not
   establish general equivalence, causation or cost/speed trends.
5. Retain dated measurement/results in the private `paperclip-evals` archive
   and existing campaign artifact storage. Keep a compact index here. Verify
   current-head CI and review before a readiness claim.

## Current state

- [x] Record merged #15218 and #15296 in the working checklist.
- [x] Reproduce both relationship cases: second completion leaves only the
  original wake against unchanged production.
- [x] Verify the scoped correction and replay behavior: all 20 database-backed
  control-plane conformance tests pass, including exact watchdog and near-match
  origin controls. Repository checks are still running.
- [ ] Complete frozen live comparison and retain original evidence.
- [ ] Complete PR review and CI.


## Active-parent failure and bounded correction

The original four live cells are complete: Codex PASS → FAIL and Claude FAIL →
PASS, 17 actual runs with no retries. Original grades remain unchanged. The
Codex candidate receives the revised child completion while its parent is active;
the parent later blocks using an outdated child-running view, with no retained
continuation. Both Claude parent finals reference an earlier artifact, so their
original grades do not prove delivery/review of the latest child artifact.

The human authorized publishing this summary and fixing the failures. The PR body
now retains the original results and limits. The next source revision:

- Carries ordinary child completion decision identity through the durable wake.
- Defers that wake behind an active parent instead of treating updated run context
  as proof the provider received it. Exact watchdog and legacy behavior stay as before.
- Preserves a queued/deferred child result across a parent Done claim. Completion
  authority leaves the task in progress and uses the existing continuation; it
  rechecks under the parent status lock. Consumed and current-run wakes do not
  block completion. Cancellation and governance are not bypassed.

67 focused scheduler, native conformance and authority tests pass, along with
repository typecheck. The controlled scheduler test proves one sequential parent
continuation carrying the revised summary, including dispatcher replay. Native
coverage distinguishes queued, claimed, deferred, consumed, and current-run wakes.

The original baseline remains frozen. Measure only the corrected candidate in
the same two cases, one attempt each, under the existing bounds and oracle. Keep
all previous runs and inspect final artifact delivery separately from machine
pass totals. Live qualification and fresh CI/review remain pending; keep draft.


### Concurrency review and cancelled intermediate campaign

Fresh review of `3c1cf6830ce9db4123b834ffb99c594c383a8986` raised an
outbox-insertion versus parent-completion race. A controlled PostgreSQL barrier
uses distinct parent and child agents and pauses the real child transaction at
wake insertion. The parent must wait, then preserve the pending result. The
previous source also passes that ordering because child writes acquire an
implicit parent foreign-key lock. This is not a reproduced additional failure.
The correction makes parent serialization explicit before child writes, avoiding
shared-lock upgrades between siblings. The original four failing regressions
remain the before/after evidence for the active-parent fix.

Intermediate campaign `37518652522` was cancelled once that review required
source changes. Both paid-cell steps started and both tasks were created before
cancellation completed. Each retained artifact contains only its invocation
policy. No original grade, API run inventory, final ledger or cleanup receipt
survived. Provider-run count and charges are unknown; record two incomplete
attempts, not passes or zero-provider setup failures. Preserve these separately
from the original 17 actual runs. The next candidate must pass fresh review
before its bounded live attempts. Original baseline, prompts and oracle stay
frozen.

The final lock revision passes all 68 focused scheduler, conformance and arbiter
tests plus repository typecheck. Build, fresh CI/review and live qualification
remain pending.
