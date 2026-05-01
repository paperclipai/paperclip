---
schema: agentcompanies/v1
kind: skill
slug: plan-review
name: Plan Review (Pre-Implementation Gate)
description: Codex (Code Reviewer) reviews the Planner's output BEFORE the Executor starts implementing. Catches scope creep, missing edge cases, broken architecture, and overlooked dependencies while it's still cheap to fix — before code is written, not after. Anthropic April-2026 Harness Engineering pattern: Planner → Plan Reviewer → Executor → Result Reviewer (two reviews, not one).
version: 0.1.0
license: MIT
sources: []
---

# Plan Review (Pre-Implementation Gate)

Used by `code-reviewer`. Triggered when `planner` finishes a plan-mode session and the chief-engineering ticket transitions from `awaiting-plan-review` to in-flight. Blocks `executor` from starting until this gate PASSes.

## Why this exists

April Harness Engineering pattern (Anthropic) recommends **Planner → Plan-Reviewer → Generator → Result-Reviewer**: two separate review stages, one before code is written, one after. Until 2026-05-01 Koenig AI Academy was running only the second review (G_code on the implemented PR). That meant scope creep / missing edge cases / wrong architectural call only got caught after Sonnet had already burned the implementation budget — typical 5× cost-to-fix at that stage vs catching it at the plan stage.

This skill closes that gap. Same agent (`code-reviewer`, on Codex CLI), different phase: read the plan, not the diff.

## When you fire

A `chief-engineering` ticket has fanned out to:
- `planner` (Opus, plan-mode) — has produced a plan and exited plan-mode
- Status is now `awaiting-plan-review`

You read the plan + the parent ticket and decide: PASS → Executor can implement; BLOCK → Planner re-plans.

**You do NOT read the diff** — there is no diff yet. You read prose: file paths, proposed changes, test strategy, rollback path.

## Procedure

1. **Read the parent ticket** — what did chief-engineering ask for? What's the success criteria? What's the budget cap? Are there explicit constraints (don't-touch files, vendor-scope rules, V1 lock-ins)?

2. **Read the plan** — Planner's plan should live as a comment on a child ticket (status `awaiting-plan-review`) OR as a `vault/plans/<ticket>.md` file. Walk through:
   - Files-to-modify list — does it match the ticket scope?
   - Architectural decisions — are they consistent with existing patterns in the repo?
   - Test strategy — are critical paths covered? Browser test for UI? Unit + integration for backend?
   - Rollback plan — if this lands and breaks, can we revert in <30 min?
   - Edge cases — empty input, network failure, concurrent dispatch, hostile input?
   - Dependencies — does this touch a sibling ticket's lane (cross-team conflict)?

3. **Check the 7 blockers (if ANY are TRUE → BLOCK):**
   - Scope creep beyond ticket success criteria
   - Architectural call that contradicts an explicit ADR or vault/decisions/ entry
   - Missing test for any path Vardaan flagged in the ticket
   - No rollback plan for an irreversible change (DB migration, vault delete, push to main)
   - Dependency on a sibling ticket that isn't in `done` state
   - Budget overrun forecast: planned size > 1.3× ticket budget (because plan-stage forecasts are usually optimistic)
   - V1 vendor-scope violation (e.g., introducing an xAI dependency on author tier)

4. **Decide:**
   - **PASS** — comment with the structured approval format below. PATCH ticket status `awaiting-plan-review` → `awaiting-executor`. Executor wakes via `wake_assignee` continuation policy.
   - **BLOCK** — comment with structured block reason + which dimension failed + suggested rework. PATCH status `awaiting-plan-review` → `in_progress` (back to Planner). Planner revises and re-submits.

## Comment format

**PASS:**
```
✅ Plan-Review PASS · KOEA-<n> · plan at vault/plans/<ticket>.md
- Scope ✓ matches ticket success criteria (item 1, 3, 5 covered)
- Architecture ✓ consistent with existing pattern in src/lib/courses.ts
- Tests ✓ covers Path A (chapter render) + Path B (R2 fetch failure) + edge case (empty draft)
- Rollback ✓ git revert + Vercel redeploy <5 min
- Budget forecast: planned ~1,800 LOC vs ticket cap 2,500 LOC ✓
- V1 vendor scope ✓ (Google + Anthropic only)
Routing → @executor for implementation
```

**BLOCK:**
```
❌ Plan-Review BLOCK · KOEA-<n> · plan revision requested

DIMENSION: <which of the 7 blockers tripped>
DETAIL: <what's wrong, in 2-3 sentences with file paths>
SUGGESTED REWORK: <concrete change to the plan>

Specifically:
- <bullet 1>
- <bullet 2>

Routing → @planner for revision (rev 2)
```

## Inputs

- The parent ticket id + success criteria
- Planner's plan (vault/plans/<ticket>.md OR a structured comment)
- Repo state (read-only — no editing in this gate)
- Cost data (current spend vs budget cap)

## Outputs

- A PASS or BLOCK comment + status flip
- If PASS → `awaiting-executor` (executor wakes)
- If BLOCK → back to `in_progress` (planner re-plans)

## Never do

- Never start implementing yourself. You read plans, not write code.
- Never approve a plan whose test strategy is "we'll figure it out during implementation".
- Never approve a plan that introduces an out-of-scope vendor dependency without escalating to chief-engineering.
- Never PASS without writing the structured comment. Empty PASS = no audit trail.
- Never re-block the same plan more than 2× without escalating to chief-engineering — third block means the brief is wrong, not the plan.

## Escalation

- 3+ plan-review blocks for the same chief in a week → flag in next weekly retro
- Plan budget forecast exceeds ticket cap by >1.5× → ping chief-engineering for re-scope BEFORE blocking (planner doesn't always know the cap)

## Budget

Per-task cap $0.30 (read-only Codex pass — should be cheap; plan is usually 200-500 lines of prose).

## Wiring

Add to `chief-engineering`'s dispatch flow (insert between Planner and Executor):

```
Step 1: Planner produces plan → status awaiting-plan-review
Step 2: Code-Reviewer fires plan-review skill (THIS skill)
        - PASS → status awaiting-executor (Executor wakes)
        - BLOCK → status in_progress (Planner revises)
Step 3: Executor implements → status awaiting-g-code
Step 4: Code-Reviewer fires code-review-pr skill (the OTHER review, on the diff)
        - PASS → status awaiting-g2 (QA Verifier wakes)
Step 5: QA Verifier runs G2
Step 6: CEO runs G3
```

The Code Reviewer agent now has TWO skills it fires conditionally based on ticket status:
- `plan-review` (this skill) — when status = `awaiting-plan-review`
- `code-review-pr` (existing) — when status = `awaiting-g-code`

Both skills use the same agent (Codex on `codex_local` adapter) but different prompts/procedures.
