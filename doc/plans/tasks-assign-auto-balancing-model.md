# Assignee Diversification + Auto-Balancing Model (OTTAA-73)

## Context

`OTTAA-73` exists to prevent assignment queue saturation on a single agent lane when multiple eligible assignees exist.

Recent reliability incidents showed:

- critical work piling onto one assignee while other lanes had capacity
- repeat retries targeting the same overloaded lane
- manual triage overhead to rebalance queue health

This model defines deterministic, explainable balancing that preserves board override authority.

## Goal

Distribute assignment load across eligible agents by role fit and live capacity, while keeping assignment decisions auditable and predictable.

## Non-Goals

- No auto-reassignment of checked-out or actively running issues
- No override of explicit board-selected assignee
- No cross-company or out-of-scope assignment behavior

## Assignment Modes

1. Explicit board assignment:
   - If board user sets `assigneeAgentId`, preserve as-is.
   - Balancer records metrics but does not override.
2. Explicit scoped-operator assignment:
   - Allowed only if `tasks:assign` + scope policy permits target.
   - Balancer does not override explicit target.
3. Auto-assignment path:
   - Used for unassigned issue intake, sweeper recovery, and clean-retry paths.
   - Balancer selects assignee from eligible candidate set.

## Candidate Eligibility

A candidate is eligible only if all conditions hold:

- agent is active/runnable
- role is compatible with issue type/required role mapping
- assignment scope policy allows target agent (if actor is scoped)
- candidate is below hard WIP caps
- candidate has no active execution lock conflict for target issue

## Scoring Heuristic (Deterministic)

Each eligible agent receives a score:

```text
score =
  role_fit_weight
  + capacity_headroom_weight
  + project_familiarity_weight
  + fairness_rotation_weight
  - critical_overload_penalty
  - stale_block_penalty
```

Suggested v1 weights:

- `role_fit_weight`: 40
- `capacity_headroom_weight`: 30
- `project_familiarity_weight`: 10
- `fairness_rotation_weight`: 10
- `critical_overload_penalty`: 25
- `stale_block_penalty`: 10

Tie-breakers (in order):

1. lowest `critical_open_count`
2. earliest `last_assigned_at` (round-robin fairness)
3. stable sort by `agentId` (deterministic fallback)

## Hard Guardrails

- Do not assign critical issue to an agent above configured critical cap if another eligible candidate is below cap.
- Never auto-assign to CEO lane unless explicitly requested by board.
- Never unassign/reassign checked-out issue.
- Respect `tasks:assign_scope` deny rules before scoring.

## Explainability Contract

Every auto-assignment emits structured metadata in activity logs and optional issue comment:

```json
{
  "event": "auto_assignment_selected",
  "issueId": "<uuid>",
  "selectedAgentId": "<uuid>",
  "candidatesEvaluated": 4,
  "topCandidates": [
    { "agentId": "<uuid>", "score": 78, "reason": "high_headroom+role_fit" },
    { "agentId": "<uuid>", "score": 71, "reason": "role_fit+fairness_rotation" }
  ],
  "mode": "auto",
  "timestamp": "2026-03-05T00:00:00Z"
}
```

When assignment is denied due saturation:

```json
{
  "error": "assignment_capacity_exceeded",
  "reason": "all_candidates_over_critical_cap"
}
```

## Integration Points

- Issue create flow when no assignee is set
- Clean retry flow (`OTTAA-69`)
- Sweeper recovery flow (`OTTAA-67`)
- Queue aging recovery hooks (`OTTAA-72`) for recommendation output (not forced reassignment)

## Configuration Surface

Recommended company/project config:

```json
{
  "assignmentBalancing": {
    "enabled": true,
    "criticalCapPerAgent": 3,
    "maxQueuedPerAgent": 6,
    "fairnessWindowHours": 24,
    "excludeRoles": ["ceo"]
  }
}
```

Defaults should be conservative and board-adjustable.

## Test Gate

### Unit

- deterministic score calculation for fixed candidate sets
- tie-breaker stability
- guardrail behavior (cap enforcement, CEO exclusion)

### Integration

- auto-assignment chooses less-loaded eligible agent
- explicit board assignment bypasses auto-balancing
- scoped operator cannot assign outside allowed scope
- no auto-reassignment for checked-out issues

### Regression

- existing manual assignment behavior unchanged
- WIP-limit deny reasons remain explicit and user-facing
- activity log entries include explainability payload

## Rollout Plan

1. Ship scoring engine behind `ASSIGN_BALANCER_ENABLED=false`.
2. Enable in shadow mode (log-only decisions, no write).
3. Validate against one week of assignment traffic.
4. Enable write mode for auto-assignment paths only.
5. Review distribution + incident metrics; then widen usage if stable.

## Board Decisions Required

1. Confirm v1 hard caps (`criticalCapPerAgent`, `maxQueuedPerAgent`).
2. Confirm whether PM lane should be excluded from auto-assignment by default.
3. Confirm whether balancing comments should always post on issue or stay activity-log only.
