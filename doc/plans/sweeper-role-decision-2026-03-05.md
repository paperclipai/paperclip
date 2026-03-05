# Sweeper Role Decision (OTTAA-74)

## Question

Do we need a new dedicated "Sweeper" role to cross-check all projects and advise on sync/status updates?

## Decision

Not as a new standalone role right now.

## Why

- Paperclip already emits a daily parent rollup (`daily_parent_rollup_posted`) and queue health signals.
- Current bottleneck is assignment permission boundaries (`tasks:assign`), not lack of visibility.
- Adding a new role before permission/governance fixes would add coordination overhead without removing root causes.

## What to Do Instead (Now)

1. Keep sweep behavior as a responsibility, not a new role:
   - PM owns queue hygiene + blocker escalation.
   - Daily rollup automation continues for parent epics.
2. Fix assignment governance first:
   - unblock `OTTAA-71` (scoped delegation model implementation)
   - unblock `OTTAA-73` (auto-balancing model implementation)
3. Re-evaluate need for a dedicated Sweeper role after governance rollout.

## Re-evaluation Trigger

Open role discussion again only if both are true for 7+ consecutive days:

- queue hygiene automation + PM process still leaves recurrent stale/ownerless critical work
- board/PM spends >30 minutes/day on manual cross-project reconciliation

## Owner

PM recommendation delivered to board via `OTTAA-74`.
