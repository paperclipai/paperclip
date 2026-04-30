---
name: dispatch-engineering-task
description: >
  Chief Engineering's dispatch skill — receive an engineering ticket, classify
  complexity, set up the harness cycle (planner→executor→code-reviewer→qa),
  dispatch. Use when Chief Engineering's heartbeat fires with new tickets.
---

# Dispatch Engineering Task

You orchestrate the harness; you don't code.

## Scope

- One engineering ticket → 4 sub-tickets (one per harness stage)
- Per-stage budget watching
- Worktree management

## Inputs

- CEO/Chief-dispatched Paperclip ticket with `assignee: chief-engineering`
- Repo state (learnovaBeast or koenig-ai-org)

## Workflow

### 1. Classify ticket complexity

| Class | Indicator | Per-stage budget |
|---|---|---|
| Trivial | Typo, copy fix, 1-line config | $0.20 plan + $0.20 exec + $0.10 review + $0.10 QA |
| Small | <200 LOC, ≤3 files | $0.40 + $0.50 + $0.30 + $0.30 |
| Medium | 200-500 LOC, 3-5 files | $0.80 + $1.00 + $0.50 + $0.50 |
| Large | >500 LOC, >5 files | **REJECT** — request ticket split |

If ticket would be Large → comment back asking CEO/Chief for split. Don't dispatch.

### 2. Set up worktree (Medium+ tickets only)

```bash
cd <repo>
git worktree add ../<repo>-koe-<ticket-id> -b koe-<id>/<slug>
```

Pin worktree path in ticket.

### 3. Dispatch Planner ticket

```yaml
title: "[Plan] KOE-<id>: <one-line>"
assignee: planner
status: ready-to-plan
deadline: same-heartbeat
budget: $<plan-budget>
context:
  - parent_ticket: KOE-<id>
  - repo: <name>
  - worktree: <path or main>
  - acceptance_criteria: <from parent>
```

### 4. Pre-create downstream sub-tickets (status: pending-handoff)

- Executor (activates when Planner flips status)
- Code Reviewer (activates when Executor opens PR)
- QA Verifier (activates when Code Reviewer APPROVEs)

### 5. Comment on parent ticket

```
✅ Harness dispatched · KOE-<id> (<class>)
- @planner planning (budget $<X>)
- Worktree: <path>
- Parent budget: $<sum>
```

### 6. Run `run-harness-cycle` skill

Hand off to `run-harness-cycle` for stage-by-stage tracking.

## Output

4 sub-tickets + worktree + parent comment.

## Notes

- Don't skip Planner stage — even trivial tickets get a plan (audit log split).
- Don't allow Planner to begin without acceptance criteria. If unclear, route back.
- Worktree only for Medium+. Trivial/Small can run in main checkout.

## Escalation

- Ticket is Large → REJECT + ask for split
- Acceptance criteria unclear → route back to dispatcher
- 3+ revisions on same ticket → escalate to CEO
