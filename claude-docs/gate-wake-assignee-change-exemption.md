# Gate-review wakes survive assignee changes (W5a + W5b)

## Problem

Activating a `dev_team` plan was supposed to run CTO → Architect (plan gate) →
Implementor → Code-Reviewer + Wiring-Expert. Instead the architect's run died with:

> Cancelled because issue assignee changed before the queued run could start; the new
> owner will be woken instead (`issue_assignee_changed`)

### Root cause

1. Plan activates → `routes/plans.ts` W5a wakes the architect against the **plan-root
   issue**, whose assignee is the CTO.
2. CTO heartbeat fires, decomposes, and **reassigns** the plan-root issue (CTO →
   implementor) while delegating.
3. The architect's queued run is claimed → `evaluateQueuedRunStaleness`
   (`heartbeat.ts`) saw `issue.assigneeAgentId (implementor) !== run.agentId
   (architect)` and cancelled it as `issue_assignee_changed`.

The assignee-change check assumes **one owner per issue**. Gate reviewers (architect /
code-reviewer / wiring-expert) are deliberately **non-assignees acting on someone
else's issue** — the same shape as the `allowsIssueInteractionWake` runs that are
already exempted on that same line. Gate wakes just weren't recognized as an exemption.
The same defect also affected W5b reviewer wakes (issue still assigned to the
implementor when reviewers wake).

This is the async port of how `/dev-roles` sequences gates synchronously: gate rows +
a wake exemption give async agents the "wait your turn, then act regardless of who owns
the issue" ordering a single sequential context gets for free.

## Fix

Add a **gate-review wake exemption** to the assignee-change staleness branch, mirroring
`isInteractionWake`. The wake `reason` already lands in `context.wakeReason` (via
`enrichWakeContextSnapshot`), and each gate wake already tags `contextSnapshot.source`,
so the predicate is two-factor with no new plumbing.

### Files changed

| File | Change |
|---|---|
| `server/src/services/plan-gates.ts` | new exports: `PLAN_APPROVAL_WAKE_REASON`, `REVIEW_GATE_WAKE_REASON`, `GATE_REVIEW_WAKE_REASONS`, `GATE_WAKE_SOURCES`, and pure predicate `isGateReviewWake(context)` |
| `server/src/routes/plans.ts` | W5a wake uses `PLAN_APPROVAL_WAKE_REASON` (was inline literal) |
| `server/src/routes/issues.ts` | W5b wake uses `REVIEW_GATE_WAKE_REASON` (was inline literal) |
| `server/src/services/heartbeat.ts` | compute `gateReviewWake = isGateReviewWake(context)`; widen the `issue_assignee_changed` guard with `&& !gateReviewWake` |
| `server/src/__tests__/gate-review-wake-exemption.test.ts` | new — 8 unit tests for the predicate |
| `server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts` | +2 integration tests (gate survives delegation; spoofed gate reason w/o gate source still cancels) |

### The predicate

```typescript
export function isGateReviewWake(context) {
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : "";
  const source = typeof context?.source === "string" ? context.source : "";
  return GATE_REVIEW_WAKE_REASONS.has(wakeReason) && GATE_WAKE_SOURCES.has(source);
}
```

Two factors (reason **and** source) so a stray `wakeReason` alone can't bypass
owner-change cancellation — mirrors `allowsIssueInteractionWake` (reason-set membership
**and** a derived commentId).

### Scope guard

Only the `issue_assignee_changed` branch is widened. Every other staleness check still
applies to gate runs: `issue_not_found`, terminal-status,
`issue_review_participant_changed`, execution-lock, budget, pause-hold. No change to
gate creation, plan activation, the W5a/W5b emit logic, or ordinary assignment wakes.

## Tests

- Unit (8/8): valid W5a/W5b pairs accepted; gate reason without gate source rejected;
  gate source without gate reason rejected; ordinary assignment wake rejected; null /
  non-string context rejected.
- Integration (10/10, embedded Postgres): a plan-approval gate run on an issue now
  owned by the implementor **succeeds** (executes once, no cancellation); a spoofed gate
  reason with a non-gate source is **still cancelled** `issue_assignee_changed`; all
  pre-existing staleness cancellations unchanged.
- `pnpm tsc --noEmit` clean.

## Known follow-up (out of scope)

The exemption lets a gate run fire even if the gate was already resolved between queue
and claim. Other staleness branches still bound it; a future refinement could also
assert the approval row is still `pending` at claim time.

## Verify live

Reset the pilot (`scripts/reset-pilot.sh <companyId>`), create the Option-A plan with
`gateProfile: dev_team` assigned to the CTO, activate. In the MyHive monitor the
architect run should **run** (no `issue_assignee_changed`) after the CTO delegates; the
plan-approval gate moves to approved; the implementor builds; code-reviewer +
wiring-expert wake on in_review.
