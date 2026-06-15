# Plan Force-Delete — RESTRICT FK 500 Fix (shipped) Overview

> Written 2026-06-15. `DELETE /plans/:issueId` returned a 500 whenever an agent
> had actually run on the plan. Commit `b31a64cf`. Surfaced while clearing the
> MyHive pilot board after the CTO budget-pause incident.

---

## Symptom

Deleting a plan from the hive board (`HivePlanCard` trash → `plansApi.remove` →
`DELETE /api/plans/:issueId`) returned `{"error":"Internal server error"}` (500)
for some plans but not others. Empty, never-run plans deleted fine; any plan the
CTO had been woken on 500'd.

## Root cause

`plans.deletePlanSubtree` already purged the gate approvals and broke the
self-referential `parent_id` / `plan_root_issue_id` links before calling
`issues_.remove` per subtree issue. But seven tables reference `issues.id` with
**no `onDelete` rule** — Postgres defaults that to `NO ACTION` (RESTRICT):

| Table | `issue_id` | Why a row exists |
|---|---|---|
| `cost_events` | nullable | every model call the agent made |
| `finance_events` | nullable | the finance projection of those calls |
| `issue_read_states` | notNull | board read tracking |
| `feedback_votes` | notNull | 👍/👎 on the issue |
| `issue_inbox_archives` | notNull | inbox archive state |
| `issue_comments` | notNull | agent/user comments |
| `issue_thread_interactions` | notNull | question/answer interactions |

A never-run plan has none of these, so the delete worked. The moment the CTO ran
(the 1.86M-token runaway), `cost_events.issue_id` pointed at the plan issue, and
`DELETE FROM issues` tripped the RESTRICT FK → unhandled error → 500.

`heartbeat_runs` and the wakeup tables were checked and have **no** issue FK, so
they never blocked.

## Fix

In `deletePlanSubtree`, after the gate-approval purge and before the remove loop,
clear all seven RESTRICT referrers for the subtree issue ids:

- **`cost_events` / `finance_events` → `SET NULL`.** The spend already happened;
  the company/agent budget meters read `observedAmount` from `cost_events`, so the
  rows must survive — only the `issue_id` link is detached.
- **The five notNull tables → `DELETE`.** They are issue-lifecycle ephemera and
  die with the issue.

All secondary referrers of `issue_comments.id` / `issue_thread_interactions.id`
are declared `ON DELETE SET NULL`, so removing those rows can't FK-block in turn.

Service-layer purge (not a schema migration) keeps the blast radius to one
function and mirrors the existing gate-approval purge already in that block. A
comment marks the block so any future RESTRICT issue-referrer gets added here.

## Trace

```
DELETE /api/plans/:issueId            routes/plans.ts:284  (UI HivePlanCard → plansApi.remove)
  → cancelIssueSubtree                 (unchanged: tree-hold, cancel runs/wakeups/statuses)
  → plans.deletePlanSubtree            services/plans.ts:365
      recursive CTE → subtree ids (deepest-first)
      purge gate approvals             (existing)
      cost_events / finance_events     SET NULL issue_id            ← new
      read_states/votes/inbox/thread/comments  DELETE               ← new
      null parent_id / plan_root_issue_id
      issues_.remove(id) per id        (cascades the ON DELETE CASCADE tables)
  → logActivity plan.deleted + publishLiveEvent + res.json{deletedIssueIds}
```

## Verification

- Extended `plan-gate-activation.test.ts`: seeds all seven referrers on a plan an
  agent has run on, then asserts the delete succeeds, `cost_events`/`finance_events`
  survive with `issue_id` NULL, and the five ephemera tables are emptied. 13/13
  pass; `tsc` + `eslint` clean. No DB migration.
- Live: the four pilot plans that previously 500'd all deleted `200` after the
  watch rebuild; the hive board went to zero plans.

## Out of scope / follow-ups

- **Non-atomicity (pre-existing):** the purge + per-issue `issues_.remove` loop are
  not wrapped in a single transaction, so a mid-failure can leave partial state.
  Matches the existing gate-approval purge; not addressed here.
- **Schema alternative:** flipping the seven FKs to `ON DELETE SET NULL`/`CASCADE`
  via migration would make this DB-enforced instead of service-enforced. Larger
  blast radius; deferred.
- **The 1.86M runaway** that created the `cost_events` in the first place is a
  separate burn issue — the per-run 500k ceiling caught it correctly.
