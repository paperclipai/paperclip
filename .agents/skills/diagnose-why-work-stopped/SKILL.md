---
name: diagnose-why-work-stopped
description: >
  Diagnose stalled, looping, or over-recovered Paperclip issue trees and propose
  a no-code product-rule plan. Use when asked why work stopped, why it looped, or
  how to prevent a tree from going too deep.
---

# Diagnose Why Work Stopped

A repeatable procedure for the recurring class of issues where the user (or a manager) points at a stalled / looping / over-recovered issue tree and asks "why did this stop / why is this looping / how do we make sure this doesn't happen again?"

This skill is **diagnostic + product-design**, not engineering. The output is a written root cause and an approved plan. No code changes leave this skill.

**Execution contract is canonical.** Read `doc/execution-semantics.md` §§3,6,8,9,11,12 for the execution contract (status, action-path, post-run disposition, bounded continuation, productivity review, pause-hold, watchdog, explicit recovery) before diagnosing or proposing a new liveness/recovery rule, and keep its terms intact. Do not invent a new rule until you can state how it differs from that document.

## When to use

Trigger on an assignment whose title or body matches any of:

- "why did this work stop", "why did this stall", "why did this just stop"
- "infinite loop", "looping", "spinning", "going too deep", "recovery went too deep"
- "liveness — what happened here", "this tree stopped working", "stuck"
- "approach it from a product perspective", "general product principle / rule"
- An attached link to a specific stalled / looping / over-recovered issue tree

Also use when the user asks for forensics, root cause, or a write-up *before* any product change.

## When NOT to use

- The assignment asks you to ship a code change directly. Use normal engineering flow.
- The assignment is a normal bug report against a specific feature. Use normal investigation.
- You are the original implementer being asked to fix your own bug. Use normal debugging.

## Three invariants you must preserve

Every diagnosis and every proposed rule must hold these three invariants together. They recur on every issue of this class; treat them as load-bearing:

1. **Productive work continues.** Agents that have a clear next action must keep working without needing the user to wake them.
2. **Only real blockers stop work.** Stops happen when something genuinely cannot proceed (missing approval, missing dependency, human owner). Pseudo-stops (in_review with no action path, cancelled leaves, malformed metadata) must be detected and routed, not left silent.
3. **No infinite loops.** Stranded-work recovery and continuation loops must be bounded and distinguishable from genuinely productive continuation.

If a proposed rule violates any of the three, drop it or rework it. State explicitly in the plan how each invariant is held.

## Procedure

### 1. Forensics on the named tree — before anything else

Do this in the same heartbeat. Do not propose a rule until you have a concrete stop point.

- Open the linked issue (and its blocker chain, parents, recovery siblings, recent runs).
- Walk the tree node-by-node and find the exact issue + state combination that stops the world. Recurring failure shapes (all defined in the execution contract):
  - `in_review` with no typed execution participant, no active run, no pending interaction, no recovery issue — a stalled review state.
  - `in_progress` after a successful run with no future action path queued — an invalid post-run disposition.
  - Blocker chain whose leaf is `cancelled` / malformed / cross-company-inaccessible — `cancelled` blockers do not auto-resolve.
  - `issue.continuation_recovery` waking the same issue >N times after successful runs — continuation must stay bounded.
  - Stranded-work recovery treating its own recovery issues as more recoverable source work — recursive recovery, forbidden.
- Quote the evidence: run ids, comment timestamps, status transitions. "Inferred" is acceptable only when an API boundary blocks direct evidence — say so explicitly and mark the claim provisional.

**Rule out working brakes before you call anything a stop.** Paperclip deliberately withholds some wakes and some routine fires. From the outside these look identical to a silent skip, and a diagnosis that names a working brake as the root cause is wrong — it will propose loosening a protection that exists on purpose. Check both before writing a root cause:

- **`issue_rewake_throttled`** (`server/src/services/issue-rewake-throttle.ts`) — after **2 consecutive `succeeded` runs by the same agent on the same issue that left no issue-visible progress**, information-free wakes for that issue are held for an escalating cooldown (2 min, doubling, capped at **30 min**) from the last run's finish. It surfaces as an `agent_wakeup_requests` row with `status = 'skipped'`, `reason = 'issue_rewake_throttled'`, and `payload.heartbeatSkip` carrying `requestedReason`, `noProgressStreak`, `cooldownMs`, `lastRunFinishedAt`, `nextAllowedAt`. No `heartbeat_run` is created — that is by design. It applies only to reason-less on-demand invokes plus `issue_assigned`, `issue_continuation_needed`, `issue_assignment_recovery`, `issue_graph_liveness_backstop`; every event-carrying reason, `forceFreshSession`, explicit resume, and wake comment passes through, and server-side recovery retries never reach the gate.
- **`no_external_activity`** (`server/src/services/routines.ts`) — a routine whose `activity_gate_policy` is `require_external_activity` (column default is `always`; this is opt-in per routine) does not fire when nothing external happened since its last dispatched run. It surfaces as a `routine_runs` row with `status = 'skipped'`, `failure_reason = 'no_external_activity'`, touched-state `skipped_no_activity`, and a `routine.run_skipped` activity whose details carry `activityGate.verdict = 'quiet'`. `nextRunAt` still advances.

Telling a brake from a genuine stall:

| Signal | Brake working as designed | Genuine stall |
| --- | --- | --- |
| Throttle | Streak is real (runs succeeded, left no comment/mutation/document/work-product) and `nextAllowedAt` is ≤30 min out | `nextAllowedAt` long past with still nothing run, or a wake with an event-carrying `requestedReason` got held |
| Activity gate | Routine is gated, window genuinely quiet, `nextRunAt` advanced | Window was not quiet, or `nextRunAt` stopped advancing, or the routine should not be gated at all |

A throttle firing repeatedly is still worth writing up — but the defect is **the no-progress streak underneath it** (bad next action, missing context, wedged agent), not the throttle. Name the work problem, not the brake.

Respect the API boundary. If the linked issue is in another company and your agent token returns 403, do not bypass scoping. Either request a board-approved diagnostic path or proceed from inferred evidence visible from your own company and label it.

### 2. Survey recent related work

Before proposing a new product rule, read what already shipped this week in the same area. A recurring instruction on these diagnostics is to review the liveness/recovery work shipped in the last couple of days before writing anything new. A new rule that contradicts code merged 48 hours ago is rework, not improvement.

Quick survey:
- Recent merged PRs in the affected area.
- Recent done issues whose title mentions liveness, recovery, productivity, continuation, or the affected subsystem.
- Any active plan documents on parent issues. The fix may belong as a revision to an existing plan, not as a new top-level proposal.

State in the forensics: "I reviewed X, Y, Z. The new gap is …"

### 3. Classify each non-progressing issue in the tree

For every issue in the affected tree that is not `done` / `cancelled` / actively running, decide:

- **Truly needs human or board intervention** — name the owner and the action.
- **Agent-actionable but not currently routed** — name the rule that would have routed it, and the agent that should have been waked.
- **Already covered** — point at the active run, queued wake, recovery issue, or pending interaction.

This classification table is requested on virtually every issue of this class. Without it the plan is abstract.

### 4. Frame as a general product rule

The user does not want a one-off patch on the named tree. They want the rule. Two checks:

- The rule is **stated as a contract**, not as an if/else patch (e.g. the liveness contract: a heartbeat ends in a terminal state, an explicit waiting path, or an explicit live path).
- The rule is reconciled against `doc/execution-semantics.md`. Prefer citing and applying the existing contract; propose a document change only when the current doc is incomplete or contradicted by accepted/implemented behavior.
- The rule **explicitly preserves the three invariants** above. Show the work.

If the rule would have blocked a recent productive run from succeeding, drop or narrow it.

### 5. Plan, do not code

Write the plan into the issue's `plan` document. Cover:

- Forensics summary (root cause + evidence).
- The general product rule, stated as a contract.
- Whether the existing `doc/execution-semantics.md` contract already covers the case, or what exact documentation update is needed.
- Phased subtasks: typically `Phase 0` resolves the named live tree (carefully, not destructively), `Phase 1` codifies the contract in docs, then implementation phases for detection, recovery, UI surfacing, security review, QA, and CTO review.
- Explicit assignees per phase; favor team specialty (CodexCoder for server, ClaudeCoder for FE, UXDesigner for visible state, SecurityEngineer for ownership/permissions, QA for validation).
- Blocking dependencies wired with `blockedByIssueIds`, parallel branches identified.

Do not create the child issues yet. Do not push code.

### 6. Request approval, then decompose

- Open a `request_confirmation` interaction targeting the latest plan revision. Idempotency key `confirmation:{issueId}:plan:{revisionId}`.
- Wait for board/CTO acceptance. If the user posts a new comment that supersedes the plan, the prior confirmation is invalidated — open a fresh confirmation tied to the new revision (plans on these issues commonly cycle through several revisions; that is fine).
- Only after acceptance: create the phased child issues with the right assignees and dependencies, then block this parent on the final QA / CTO review issue so the parent only wakes when the chain finishes.

### 7. Phase 0 hygiene on the named tree

Phase 0 cleans up the live tree without papering over evidence:

- Move stalled `in_review` leaves with no participant to `todo` with a precise next action and named owner.
- Detach cancelled/dead blockers from chains they were holding hostage; do not silently mark issues `done` to clear backlog.
- Leave a comment on the original named issue summarizing what changed and why; never hide the recovery chain history.

### 8. Final close-out

When the phase chain is complete, post a board-level summary comment on the parent issue: what changed, what the new contract is, what the rollout step is (e.g. "restart the control-plane to pick up the new response shape"), and the live state of the originally-named tree. Then close the parent.

## Pitfalls

- **Restating one invariant at the cost of another.** Bound continuation too tightly and productive work stalls; loosen recovery and infinite loops return. Always check all three together — this trade-off is the trap unique to this class.
- **Coding before approval / skipping the recent-work survey.** Forensic-phase code and contracts that contradict what shipped 24 hours ago are the two fastest ways to get the plan rejected.
- **Hiding the chain.** Don't silently delete, hide, or mark `done` the symptomatic recovery issues to clear backlog — the operator needs the audit trail.
- **Diagnosing a brake as the bug.** `issue_rewake_throttled` and `no_external_activity` are working protections. Proposing to weaken either is proposing to reinstate the wake storm / quiet-period churn they were built to stop — it violates invariant 3 directly. If a brake is genuinely misfiring, say which of the specific red flags above you observed; otherwise diagnose what is behind it.

## Verification checklist (before posting the plan)

- [ ] The exact stop point in the named tree is identified with run ids / comment ids.
- [ ] `issue_rewake_throttled` / `no_external_activity` have been ruled out as the "cause", or a specific red flag is cited for why one is genuinely misfiring.
- [ ] Recent shipped work in the same area was surveyed and is referenced.
- [ ] Every non-progressing issue is classified human-needed / agent-actionable / already-covered.
- [ ] The proposed rule is stated as a contract, not a patch.
- [ ] All three invariants are explicitly preserved.
- [ ] No code change has landed in this heartbeat.
- [ ] A `request_confirmation` against the latest plan revision is open.
- [ ] Phase 0 of the plan addresses the live named tree without destroying evidence.
- [ ] Implementation phases name specialty-appropriate assignees and `blockedByIssueIds` dependencies.
