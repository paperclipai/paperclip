---
name: diagnose-why-work-stopped
description: >
  How to handle "why did this work stop / why is this looping?" assignments.
  Forensics first on the named tree, surface the exact stop-point, frame the
  fix as a general product rule that respects three invariants (productive
  work continues, only real blockers stop work, no infinite loops), and
  deliver a plan — no code changes — gated by board/CTO approval before
  child issues are created. Use whenever the issue title or body asks for
  forensics on a stalled, looping, or "went too deep" tree.
---

# Diagnose Why Work Stopped

A repeatable procedure for the recurring class of issues where the user (or a manager) points at a stalled / looping / over-recovered issue tree and asks "why did this stop / why is this looping / how do we make sure this doesn't happen again?"

This skill is **diagnostic + product-design**, not engineering. The output is a written root cause and an approved plan. No code changes leave this skill.

Canonical execution model: read `doc/execution-semantics.md` before diagnosing or proposing a new liveness/recovery rule. Use that document as the source of truth for status, action-path, post-run disposition, bounded continuation, productivity review, pause-hold, watchdog, and explicit recovery semantics. If the investigation finds a true product-rule gap, the plan should say whether `doc/execution-semantics.md` needs a matching update.

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

Every diagnosis and every proposed rule must hold these three invariants together. The user has restated them on at least four issues; treat them as load-bearing:

1. **Productive work continues.** Agents that have a clear next action must keep working without needing the user to wake them. ([PAP-2674](/PAP/issues/PAP-2674), [PAP-2708](/PAP/issues/PAP-2708))
2. **Only real blockers stop work.** Stops happen when something genuinely cannot proceed (missing approval, missing dependency, human owner). Pseudo-stops (in_review with no action path, cancelled leaves, malformed metadata) must be detected and routed, not left silent. ([PAP-2335](/PAP/issues/PAP-2335), [PAP-2674](/PAP/issues/PAP-2674))
3. **No infinite loops.** Stranded-work recovery and continuation loops must be bounded and distinguishable from genuinely productive continuation. ([PAP-2602](/PAP/issues/PAP-2602), [PAP-2486](/PAP/issues/PAP-2486))

If a proposed rule violates any of the three, drop it or rework it. State explicitly in the plan how each invariant is held.

## Procedure

### 0. Read the current execution contract

Before walking the tree, read `doc/execution-semantics.md` and keep its terms intact:

- live path / waiting path / recovery path
- post-run disposition: terminal, explicitly live, explicitly waiting, invalid
- bounded `run_liveness_continuation`
- productivity review vs liveness recovery
- active subtree pause holds
- silent active-run watchdog

Do not invent a new rule until you can state how it differs from the current execution semantics document.

### 1. Forensics on the named tree — before anything else

Do this in the same heartbeat. Do not propose a rule until you have a concrete stop point.

- Open the linked issue (and its blocker chain, parents, recovery siblings, recent runs).
- Walk the tree node-by-node and find the exact issue + state combination that stops the world. Common shapes seen in the company so far:
  - `in_review` with no typed execution participant, no active run, no pending interaction, no recovery issue ([PAP-2335](/PAP/issues/PAP-2335), [PAP-2674](/PAP/issues/PAP-2674)).
  - `in_progress` after a successful run with no future action path queued ([PAP-2674](/PAP/issues/PAP-2674)).
  - Blocker chain whose leaf is `cancelled` / malformed / cross-company-inaccessible ([PAP-2602](/PAP/issues/PAP-2602)).
  - `issue.continuation_recovery` waking the same issue >N times after successful runs ([PAP-2602](/PAP/issues/PAP-2602)).
  - Stranded-work recovery treating its own recovery issues as more recoverable source work ([PAP-2486](/PAP/issues/PAP-2486)).
- Quote the evidence: run ids, comment timestamps, status transitions. "Inferred" is acceptable only when an API boundary blocks direct evidence — say so explicitly and mark the claim provisional ([PAP-2631](/PAP/issues/PAP-2631)).

Respect the API boundary. If the linked issue is in another company and your agent token returns 403, do not bypass scoping. Either request a board-approved diagnostic path or proceed from inferred PAP-side evidence and label it.

### 2. Survey recent related work

Before proposing a new product rule, read what already shipped this week in the same area. The user has explicitly called this out: ([PAP-2602](/PAP/issues/PAP-2602)) "review our recent work on liveness that we shipped in the last couple of days." A new rule that contradicts code merged 48 hours ago is rework, not improvement.

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

This is the table the user has asked for repeatedly ([PAP-2335](/PAP/issues/PAP-2335)). Without it the plan is abstract.

### 4. Frame as a general product rule

The user does not want a one-off patch on the named tree. They want the rule. Two checks:

- The rule is **stated as a contract**, not as an if/else patch. Example contract: "every agent-owned non-terminal issue must finish each heartbeat with a terminal state, an explicit waiting path, or an explicit live path" ([PAP-2674](/PAP/issues/PAP-2674)).
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
- Wait for board/CTO acceptance. If the user posts a new comment that supersedes the plan, the prior confirmation is invalidated — open a fresh confirmation tied to the new revision ([PAP-2602](/PAP/issues/PAP-2602) cycled three revisions; that is fine).
- Only after acceptance: create the phased child issues with the right assignees and dependencies, then block this parent on the final QA / CTO review issue so the parent only wakes when the chain finishes.

### 7. Phase 0 hygiene on the named tree

Phase 0 cleans up the live tree without papering over evidence:

- Move stalled `in_review` leaves with no participant to `todo` with a precise next action and named owner ([PAP-2335](/PAP/issues/PAP-2335)).
- Detach cancelled/dead blockers from chains they were holding hostage; do not silently mark issues `done` to clear backlog.
- Leave a comment on the original named issue summarizing what changed and why; never hide the recovery chain history.

### 8. Final close-out

When the phase chain is complete, post a board-level summary comment on the parent issue: what changed, what the new contract is, what the rollout step is (e.g. "restart the control-plane to pick up the new response shape"), and the live state of the originally-named tree. Then close the parent.

## Pitfalls

- **Coding before approval.** The user has said "make a plan first" on every recent diagnostic issue. Producing code in the forensic phase wastes the round-trip.
- **Restating one invariant at the cost of another.** Bound continuation too tightly and productive work stalls; loosen recovery and infinite loops return. Always check all three.
- **Skipping the recent-work survey.** Proposing a contract that contradicts what shipped 24 hours ago is the easiest way to get the plan rejected.
- **Letting "in_review" mean done.** A leaf assigned to another agent with no participant or active run is not progress; treat it as a stop.
- **Bypassing company scoping.** Cross-company forensics needs a board-approved diagnostic path, not a database read.
- **Recursive recovery.** Stranded-work recovery that recovers its own recovery issues is the canonical infinite loop ([PAP-2486](/PAP/issues/PAP-2486)). Detect it and refuse to deepen.
- **Hiding the chain.** Don't silently delete or hide the symptomatic recovery issues — the operator needs the audit trail.

## Verification checklist (before posting the plan)

- [ ] The exact stop point in the named tree is identified with run ids / comment ids.
- [ ] Recent shipped work in the same area was surveyed and is referenced.
- [ ] Every non-progressing issue is classified human-needed / agent-actionable / already-covered.
- [ ] The proposed rule is stated as a contract, not a patch.
- [ ] All three invariants are explicitly preserved.
- [ ] No code change has landed in this heartbeat.
- [ ] A `request_confirmation` against the latest plan revision is open.
- [ ] Phase 0 of the plan addresses the live named tree without destroying evidence.
- [ ] Implementation phases name specialty-appropriate assignees and `blockedByIssueIds` dependencies.
