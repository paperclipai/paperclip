---
name: run-harness-cycle
description: >
  Chief Engineering's master skill — orchestrates the full Anthropic Harness
  Engineering cycle (Planner → Executor → Code Reviewer → QA Verifier) for
  one engineering ticket. Use when a new engineering ticket lands from CEO
  or another chief.
---

# Run Harness Cycle

End-to-end engineering ticket execution. You orchestrate 4 agents through 4 stages with explicit handoffs. Same ticket flows through all 4.

## Scope

- New engineering ticket → fully G2-passed PR ready for CEO G3
- Anthropic Harness Engineering pattern (April 2026)
- Per-stage budget watching

## Inputs

- A Paperclip engineering ticket from CEO/Chief with success criteria

## Workflow

### Stage 1: Plan

Dispatch ticket to Planner:
```
status: ready-to-plan
assignee: @planner
deadline: same heartbeat
deliverable: vault/decisions/<ticket-id>-plan.md
```

Wait for status flip to `ready-to-execute`. Verify the plan file landed in vault.

### Stage 2: Execute

Dispatch to Executor (same ticket, status flipped):
```
status: ready-to-execute
assignee: @executor
deadline: per plan estimate
deliverable: open PR matching plan
```

Wait for status flip to `awaiting-code-review`. Verify PR is open + tests pass locally.

### Stage 3: G_code Review

Run `run-g_code-gate` skill — it dispatches to Code Reviewer + audits the result.

### Stage 4: G2 QA Verify

Run skill: dispatch QA Verifier; wait for G2 PASS or BLOCK.

### Stage 5: Hand to G3

On G2 PASS:
```
status: awaiting-g3
assignee: @ceo
PR: <url>
plan: vault/decisions/<ticket-id>-plan.md
gates: G_code ✓ G2 ✓
```

## Re-cycle on BLOCK

| Stage that BLOCKed | Route back to |
|---|---|
| G_code | Executor (revise, re-route via G_code) |
| G2 | Executor (via G_code) — if 2nd G2 BLOCK on same issue, route to Planner for re-plan |
| Planner re-plan request | Planner (then full re-cycle) |

Limit: 3 cycles. After 3, escalate to CEO with a tickit-split or scope-revisit recommendation.

## Output

A G2-passed PR + status `awaiting-g3` with full audit trail in Paperclip ticket.

## Notes

- Don't poll. Each stage is a heartbeat-driven handoff. Status flips trigger the next stage.
- Total cost target per ticket: <$3 across all 4 agents combined
- If a stage exceeds 1.5× its budget, surface in next EOD as a process flag

## Escalation

- 3+ cycles on same ticket → CEO; ticket may need split or different approach
- Same agent BLOCKing repeatedly → flag in weekly retro
- Tests pass for Executor but fail for Reviewer → environment drift; investigate before next ticket
