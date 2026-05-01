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

**Two-stage review** (LOCKED 2026-05-01 — Anthropic April Harness Engineering pattern):

- **Code Reviewer · plan-review** (activates when Planner flips ticket to `awaiting-plan-review`) — fires `plan-review` skill on the plan PROSE before any code is written. PASS → Executor wakes; BLOCK → Planner re-plans.
- **Executor** (activates when Code Reviewer's plan-review PASSes — status `awaiting-executor`)
- **Code Reviewer · code-review-pr** (activates when Executor opens PR — same agent, different skill)
- **QA Verifier** (activates when Code Reviewer's code-review-pr APPROVEs)

Each is a separate sub-ticket so the timeline is auditable. The Code Reviewer agent fires different skills based on ticket status:

| Ticket status | Code Reviewer fires |
|---|---|
| `awaiting-plan-review` | `plan-review` (this is the new pre-impl gate) |
| `awaiting-g-code` | `code-review-pr` (the existing post-impl PR review) |

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


## 2026-05-01 ADDENDUM — sibling-check is mandatory before fan-out (LOCKED)

Before creating ANY child ticket from this dispatch flow, you MUST call the
`check-sibling-tickets` skill first. This is the de-dup contract that prevents
the parent-fan-out duplication pattern that produced the April Claude Security
Beta cluster (11 child tickets under 3 different parent IDs in a 30-min window,
no sibling check anywhere).

**Procedure (insert at the top of step "Workflow"):**

```
Step 0 — Pre-fan-out sibling check
  spec = {
    vendor_tag: <ticket vendor>,
    topic_slug: slugify(first 4 keywords of candidate title),
    content_type: <blog|course|chapter|code|research|seo|image-gen|...>,
    parent_id: <current parent>,
    candidate_assignee: <agent>,
  }
  result = invoke check-sibling-tickets(spec)

  if result.should_create_new_ticket == false:
    # canonical sibling found — DO NOT create
    POST /api/issues/<canonical_id>/comments with:
      "Re-prioritized via this dispatch. Original request: <ticket title>.
       Reason new request matters: <why>. (No new ticket — folding into canonical.)"
    return  # stop the dispatch flow

  if result.canonical_warning:
    # multiple siblings exist — surface to chief BEFORE creating
    return BLOCKED with the warning
```

**Decision matrix the skill returns** (already documented in
`skills/check-sibling-tickets/SKILL.md` — quoted here for reference):

| Found | Action |
|---|---|
| 0 siblings | Create the new ticket. Stamp `metadata.dedup_key` for future siblings. |
| 1 sibling, same chief, healthy (last activity < 4h) | DO NOT create. Comment on existing. |
| 1 sibling, different chief | Cross-team conflict. Create + add `metadata.coordinate_with`. |
| 1 sibling, same chief, stuck (no activity > 4h) | Run `recover-stuck-tickets` first, then re-evaluate. |
| 2+ siblings | DO NOT create. Mark oldest canonical, cancel rest as `superseded_by`. |

**Audit log:** every check (regardless of decision) is appended to
`vault/_audit/sibling-dedup-log.jsonl` so Vardaan can see the volume of dupes
the system would have created without this gate.

**Why this is mandatory now:** the routine-de-duplication landed earlier today
(killed dual CEO TitleCase/kebab-case routines) but only fixed dupes at the
cron-fire level. Fan-out dupes (parent → multiple children with overlapping
scope) are a separate vector and live entirely inside the chief's dispatch
flow. This addendum closes that vector.
