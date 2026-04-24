# Capability-Blocked Specialist Lanes Design

## Goal

Make unstaffable specialist workflow lanes self-healing instead of silently drifting between "ready" and "unassigned" states.

## Problem

Paperclip already prevents creating new engineering workflows when no security specialist exists, and heartbeat already knows how to avoid routing some unstaffable security work. The remaining gap is that the truth is fragmented:

- delivery integrity classifies some rows as capability-blocked
- heartbeat target selection filters some security lanes out of ready-unassigned routing
- board brief has a separate security-only attention rule
- issue board state still presents some unstaffable lanes as ready or invalid

That leaves drifted or legacy rows visible in inconsistent ways and makes recovery logic harder to extend.

## Design

Introduce one canonical server-side helper for specialist-lane capability blocking. The helper answers two questions:

1. Does this issue require a specialist role that is explicitly unavailable?
2. If yes, what board/operator copy should every caller use?

For the current product surface, the only persisted specialist-lane capability rule is workflow lane role `security -> security specialist`. The helper should still be shaped as a generic capability-block abstraction so future specialist lanes extend one map instead of adding more scattered `if workflowLaneRole === "security"` checks.

## Behavioral Rules

- If an open specialist lane has no assignee and no eligible specialist exists, it is capability-blocked.
- Capability-blocked work must not be selected as ready-unassigned routing work.
- Capability-blocked work must surface explicit board/operator attention instead of looking ready or invalid.
- If an already-assigned specialist lane loses all eligible specialists, COO must unassign it and preserve the issue as explicit capability-blocked work.
- When an eligible specialist becomes available again, the issue should naturally fall back into normal routing without manual repair.

## Integration Points

- `delivery-integrity.ts`: canonical classification for open unassigned specialist lanes
- `heartbeat.ts`: wrong-specialist/unstaffable-owner repair path
- `operations-heartbeat-target` logic inside `heartbeat.ts`: exclude capability-blocked rows from ready-unassigned selection
- `issue-board-state.ts`: render capability-blocked board state instead of `ready` or `system_error`
- `board-brief.ts`: reuse the same capability-block reason instead of a security-only branch
- UI presentation helpers: describe capability-blocked board state accurately

## Non-Goals

- No new DB column in this patch
- No change to workflow creation semantics
- No attempt to generalize standalone QA review demotion into this same abstraction yet; that path has different ownership semantics and already has separate repair logic

## Expected Outcome

The system has one source of truth for unstaffable specialist lanes. Drifted rows auto-repair into an explicit blocked state, board surfaces stop contradicting each other, and staffing recovery happens automatically as soon as a valid specialist exists again.
