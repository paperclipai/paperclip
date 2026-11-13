# Legacy continuation authority: wording invariance

Status: implemented; legacy acceptance verified. Full live campaign retains one browser reload failure. Requested September 22, 2026.
Working branch: `codex/lifecycle-behavior-baseline-20260921`.
Baseline implementation/results head: `141950faf`.

## Objective

Changing narrative alone must not change whether legacy execution wakes, waits,
repairs, exhausts its repair budget, or creates a different causal wake identity.
Narrative includes summary/result/message/nextAction/error text, comments,
continuation summaries, stdout and stderr. A field named `nextAction` containing
free text is not a typed continuation contract.

The current 36 failed wording assertions are repeated probes, not 36 distinct bugs.
Do not make them green by skipping every continuation or always continuing.

## Current authority leak

`server/src/services/run-liveness.ts` interprets prose into `plan_only`,
`blocked`, `needs_followup` and actionability, and extracts the next instruction.
`heartbeat.ts` persists this classification after run termination.
`recovery/run-liveness-continuations.ts` selects `plan_only`/`empty_response`
for an immediate continuation and puts the classification in its wake key.
`recovery/successful-run-handoff.ts` also consumes liveness and the existence
of a detected progress summary. `recovery/service.ts` uses persisted liveness
in subsequent productive-continuation recovery. These consumers must be handled
as one authority boundary, including delayed/replayed processing.

## Proposed decision contract

Create a pure legacy post-run authority decision using only trusted structured
facts collected from persisted task/run state and public tool/API effects.
Keep text rendering/diagnostics separate; they may describe a decision, never
select or identify it. Diagnostic classifications must not remain authoritative
through a recovery consumer or stale persisted row.

| Structured facts | Decision |
|---|---|
| Durable completed/cancelled disposition | No additional task execution |
| Pending question/approval, unresolved dependency, valid blocker/review/monitor path | Leave continuation to that existing owner/event |
| Existing active run, queued wake, routine, plugin-owned lifecycle or recovery owner | Do not create a competing path |
| Stopped, paused, budget-blocked, changed owner or invalid company/task/run binding | Do not dispatch |
| Ordinary conversation with its turn settled | No task-disposition repair |
| Eligible successful task run still lacks both a durable disposition and an owned next path | Bounded disposition repair |
| Failed/interrupted run | Existing typed failure/cancellation policy; no prose-based promotion to runnable work |

A repair asks the agent to record the outcome through the existing API/tools:
complete the task, register the real blocker/question/approval, or establish a
supported continuation path. It does not itself approve governed work or mark
completion. A prose-only blocker must be converted to a real blocked/waiting
path; a prose-only completion must be recorded as a real disposition.

Use the existing durable disposition-repair infrastructure where appropriate,
including its backoff and ledger. There must be one owner and one bounded budget
for a missing-disposition episode, not stacked liveness + handoff + repair budgets.
Preserve exhausted episodes and consumed attempts during transition; do not
silently grant a new budget by changing reason codes. Audit the existing caps
(2 liveness, 1 handoff, 5 disposition repair) before routing into the shared path;
keep already-recorded tighter limits. Do not redesign productive-work retry
budgets as part of this slice.

Wake identity derives from structured issue/source/episode/attempt identity,
never diagnostic labels or extracted text. Retain replay receipts, recheck gates
at actual dispatch, and account for legacy pending wakes during rollout so an old
and new key cannot schedule two successors.

## Implementation sequence

1. Refresh the unit and heartbeat baseline on this branch. Add explicit expected
   decisions to the pairs and positive controls. Preserve the prior snapshots.
2. Add the pure decision and a structured evidence collector, reusing the durable
   path queries in `recovery/disposition-repair.ts` rather than inventing new
   model-facing disposition fields. Finalize field shapes against the real API.
3. Route immediate liveness/handoff and later recovery through the same decision.
   Remove prose-derived fields from scheduling inputs, keys and trusted repair
   instructions. Previous output may remain quoted context. Do not change native
   semantic finalization. Reuse the current public tools; no provider rewrite.
4. Prove persisted effects, concurrency, restart, gate rechecks and exhaustion.
   An enqueue path must not bypass an outstanding approval just because the
   classifier used to call its prose runnable.
5. Run affected live pairs, then the complete 42-cell lifecycle suite (original 40 plus two legacy repair probes) before
   declaring the replacement verified. Record fresh immutable results.

## Acceptance tests

- Hold structured state fixed; change each narrative channel through all paired
  variants, including empty text. Assert the same decision, reason category,
  repair budget, wake identity, successor count and authority-bearing payload.
- Keep text identical and change durable completion, blocker, pending question,
  approval, dependency, Stop, budget, ownership or existing wake. Assert the
  correct different decision. Exercise normal conversation separately.
- Repair succeeds by recording disposition; invalid/missing disposition stays
  bounded. No third path appears after exhaustion, restart or commentary.
- Immediate and delayed handlers processing the same source produce one successor.
  Restart between persistence and dispatch preserves the receipt/attempt. An old
  persisted prose classification cannot revive the previous authority path.
- Extend the real heartbeat narrative pair to compare wake reason, key, status,
  attempt and dispatch count, not just eventual final status. That recorded
  handoff-path discrepancy is part of this same decision boundary.
- Use scripted unit/database tests for timing permutations; real LLM/browser runs
  verify tool compliance and orchestration, not exhaustive race coverage.

## Verification result

[September 22 report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/LEGACY-CONTINUATION-2026-09-22.md):
902/904 deterministic assertions pass; the two native compatibility probes remain
visible. All 22 legacy live cases pass, including both causally verified repair
variants. The complete live campaign is 41/42, with one native case completing its
persisted lifecycle but failing on a blank browser reload. Earlier failed runs and
artifact hashes remain in the inventory. This does not claim repo-wide green or
removal of prose interpretation from every remaining product surface.

## Retained backlog for later requests

These counts refer to the original scripted baseline, not a new measurement.
Keep this section even if this slice incidentally resolves some assertions.

| Finding | Recorded count | Disposition |
|---|---:|---|
| Narrative changes continuation | 36 | Fixed by the persisted-disposition authority slice; see verification above |
| Title/description words select work mode | 4 | Heuristic removed in [explicit work-mode follow-up](2026-09-22-explicit-work-mode-authority.md). Clarification: this was a liveness diagnostic exemption, not a stored mode mutation. Deterministic checks and 4/4 corrected live wording cases pass; both explicit planning controls pass |
| Commentary counts as progress | 1 | Retain for progress-evidence audit; no comment-count budget resets in this slice |
| Wording selects liveness versus handoff path in heartbeat | 1 | Retain separately in results; must be covered while closing the current shared authority boundary |
| Native autonomous continuation compatibility probes | 2 | Replaced with reachable question/response continuation tests in the [September 23 follow-up](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md), including no execution before an answer and duplicate-delivery checks. `same_agent` injection was not a current model-facing defect |
| Productive continuation versus repair/failure budgets | Three new findings | Fixed with separate persisted allowances and episode-aware delayed repair promotion. All original intended-behavior failures pass; [fresh verification and retained baseline](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md) distinguish deterministic and live evidence |
| Blank task route after reload | Repeated live observation | Development-worker interception of Vite module revalidation removed. The [September 23 report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md) retains the trace limitation and shows the previously failing legacy journey completing all five steps, plus both native reload journeys. The original empty screenshots and failed measurements remain preserved |
| Duplicate legacy response | One later live observation | Campaign 35805477715 legacy work-mode neutral: provider issued two successful PATCH calls, second escaping an underscore. Retain as model behavior evidence; exact-once matcher rejected it |
| Missing-comment policy ownership | Coverage boundary | Existing typed retry policy remains; review separately if consolidating all post-run compliance into one disposition contract |
| Maintain CI and prepare App/Evals review | Pending | Promote fixed invariants into maintained cheap gates; paid suites remain explicit |

Reference reports moved to `paperclip-evals`; see the
[results index](../../tests/lifecycle-baseline/README.md#recorded-results-moved-to-paperclip-evals)
for the initial baseline, live baseline, and live fixes.
Live follow-up: 40/40 Product E2E passed on App `331e89bb3`; original protocol
correction: 8/8 passed. Those results do not establish prose-free authority.

Accounting test-first follow-up: [scenario matrix and executable layers](2026-09-22-continuation-accounting-baseline.md).
Production follow-up: [September 23 implementation and verification](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/CONTINUATION-ACCOUNTING-FIXES-2026-09-23.md).
