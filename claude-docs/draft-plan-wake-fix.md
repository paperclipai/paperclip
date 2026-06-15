# Draft-Plan Wake Fix (shipped) Overview

> Written 2026-06-15. `POST /plans` woke the assignee on plan create (DRAFT state),
> burning 500k+ tokens per CTO run before activation. Commit `b7090fba`.

---

## Symptom

Every `POST /plans` with an `assigneeAgentId` enqueued an immediate
`queueIssueAssignmentWakeup` call (source: `assignment`, reason: `issue_assigned`,
mutation: `plan_created`). The W2 idle short-circuit only suppresses `source:"timer"`
wakes, so the CTO woke and ran on every draft plan — including unactivated pilot plans
created by scripts, causing the 1.86M-token and 500k-token runaway incidents observed
during the MyHive pilot setup.

## Root cause

`routes/plans.ts` line 103 (pre-fix) had:

```typescript
// If assigned, wake the agent so it can draft the plan (it stays a draft
// until the operator activates it).
if (body.assigneeAgentId) {
  void queueIssueAssignmentWakeup({ ..., mutation: "plan_created" });
}
```

The comment itself describes the misunderstanding: the operator controls activation
timing, not the agent. An agent running on a DRAFT plan can do nothing useful — tiers
are editable only in draft; children don't exist yet; the gate loop hasn't started.

## Fix

Removed the 12-line block (comment + if-guard + wake call) from `POST /plans`.

The import of `queueIssueAssignmentWakeup` was **kept** — it is still legitimately
used at `POST /plans/:id/activate` (line 197, wakes child assignees after
`plans.activate()` materializes the tier-1 children).

## Wake lifecycle after fix

| Event | Who wakes | Source | When |
|---|---|---|---|
| `POST /plans` (DRAFT) | nobody | — | never |
| `POST /plans/:id/activate` | child assignees | `assignment` / `plan_activated` | after activation |
| `POST /plans/:id/activate` (W5a) | architect gate agent | `assignment` / `gate_plan_approval_requested` | after activation |

## Trace

```
POST /plans                      routes/plans.ts:60
  → plans.createPlan()           services/plans.ts
  → logActivity(plan.created)
  → (REMOVED: queueIssueAssignmentWakeup)
  → 201 { issue, planDetails }
```

## Verification

- New `plan-draft-no-wake.test.ts`: 3 cases — assignee set, no assignee, response
  shape. All assert `queueIssueAssignmentWakeup` never called. 3/3 pass.
- `plan-gate-activation.test.ts`: 13/13 still pass (activation wake unchanged).
- `tsc --noEmit` clean. No ESLint errors.

## Out of scope / follow-ups

- **Broader "no-work-no-wake" guard** for timer/recovery/productivity-review sources
  when agent has no active assigned work. Larger task; separate branch.
- **Per-run token blowup** — one CTO run consuming 500k+. Separate investigation
  needed into why a single invocation pulls that much context.
