# Cancellation Replacement Gate Design

**Date:** 2026-04-11
**PR target:** `feat/department-wide-dedup` branch
**Builds on:** Initiative Chain Tracking (PR #262)

## Problem

When an agent cancels a task under an initiative, the phase silently disappears. The initiative stays open (enforced by `initiative_has_active_children`), but nobody is forced to declare whether the cancelled work needs a successor. The chain health sweeper eventually flags the stall, but that's detection hours later — not prevention at cancel time.

## Solution

New gate function `assertCancellationReplacement` that fires on agent `→ cancelled` transitions for tasks. The agent's comment must contain either:

- A replacement issue reference matching the company prefix pattern (`DLD-\d+`)
- The explicit waiver `no-replacement-needed` (case-insensitive)

## Gate specification

| Field | Value |
|-------|-------|
| Function | `assertCancellationReplacement` |
| Gate name | `cancellation_replacement_required` |
| Activity log action | `issue.cancellation_replacement_blocked` |
| Actor scope | Agent only (board users bypass) |
| Issue type scope | Tasks only (initiatives bypass) |
| Transition scope | `→ cancelled` only (current status !== cancelled) |
| Replacement pattern | `/\bDLD-\d+\b/i` |
| Waiver pattern | `/\bno-replacement-needed\b/i` |
| HTTP response | 422 |

## Gate ordering (PATCH `/issues/:id`)

1. `assertAgentRunCheckoutOwnership` — checkout lock
2. `assertAgentTransition` — status state machine
3. **`assertCancellationReplacement`** — new gate
4. `initiative_has_active_children` — child count guard
5. `assertDeliveryGate` — work product requirements
6. `assertEngineerBrowseEvidence` — screenshot for in_review
7. `assertQAGate` — QA PASS requirement
8. `assertQABrowseEvidence` — screenshot from QA reviewer
9. `assertAgentCommentRequired` — comment presence (last)

## Why tasks only

Cancelling an initiative is a board-level structural decision — all children must already be terminal (enforced by `initiative_has_active_children`). Requiring a replacement reference on the initiative itself would be redundant.

## Interaction with existing gates

- **`assertAgentCommentRequired`** — complementary. That gate checks comment *presence*; this gate checks comment *content*. An agent with no comment hits `comment_required` (runs last). An agent with a comment but no reference hits `cancellation_replacement_required` (runs earlier).
- **`assertAgentTransition`** — runs before this gate. If the transition itself is invalid (e.g., `done → cancelled`), the agent is rejected before reaching the replacement check.
- **`initiative_has_active_children`** — runs after. If the cancelled task is the last active child, the initiative can then auto-close via the chain health sweeper.

## Error response

```json
{
  "error": "cancellation_replacement_required",
  "gate": "cancellation_replacement_required",
  "message": "When cancelling a task, agents must reference a replacement issue (e.g. DLD-123) or include 'no-replacement-needed' in the comment."
}
```

## Test plan

File: `server/src/__tests__/cancellation-replacement-gate.test.ts`

1. Agent cancels task without comment → 422 `comment_required`
2. Agent cancels task with comment but no reference/waiver → 422 `cancellation_replacement_required`
3. Agent cancels task with `DLD-123` in comment → allowed
4. Agent cancels task with `no-replacement-needed` in comment → allowed
5. Agent cancels task with `No-Replacement-Needed` (case variation) → allowed
6. Board user cancels task without reference → allowed (bypass)
7. Agent transitions task to non-cancelled status without reference → allowed (gate doesn't fire)
8. Agent cancels initiative (issueType=initiative) → allowed (tasks only)

## Future considerations

- **Existence validation**: A follow-up could verify the referenced `DLD-\d+` issue actually exists. Deferred — fabricated references are visible in the audit trail.
- **Company prefix flexibility**: Currently hardcoded to `DLD-\d+`. If multi-company support matters, extract the prefix from the company record. Low priority since DLD Ent. is the only company.
