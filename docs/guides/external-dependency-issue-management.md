# External Dependency Issue Management

When an agent is waiting on an external dependency (e.g., API key delivery, third-party service
provisioning, approval from a human), it needs a way to tell Paperclip: "I'm done for now, but
wake me back up at time T." The canonical pattern is to create an **active routine** with a
**scheduled cron trigger** pointing at the issue via `routines.parentIssueId`.

## How It Works

1. The agent (or a COO/PM routine) inserts a `routines` row with:
   - `status = 'active'`
   - `parentIssueId` set to the blocked issue's UUID

2. A matching `routineTriggers` row is inserted with:
   - `kind = 'schedule'`
   - `enabled = true`
   - `cronExpression` matching the desired wake cadence
   - `nextRunAt` set to the earliest time the dependency is expected to resolve

3. The issue is left in `in_progress` (or `blocked`) status while the dependency is awaited.

## Why This Matters: Recovery Loop Suppression

Paperclip's `reconcileStrandedAssignedIssues` process periodically scans for `in_progress` and
`todo` issues that appear to have no live execution path and enqueues recovery dispatches.

Without the routine schedule guard, an issue legitimately waiting for an external dependency would
be classified as stranded and re-dispatched repeatedly — causing the exact recovery loop seen in
[DGG-5074](https://github.com/paperclipai/paperclip) (16 spurious dispatches in 1 hour).

The fix (shipped in [DGG-5094](https://github.com/paperclipai/paperclip)) extends
`hasActiveExecutionPath` in `server/src/services/recovery/service.ts` to treat a linked active
routine with a **future** scheduled trigger as a live execution path:

```
routines.status = 'active'
AND routines.parentIssueId = <issueId>
AND routineTriggers.enabled = true
AND routineTriggers.nextRunAt > now()
```

If this query returns a row, reconcile is skipped — the issue will be woken by the cron at the
configured time without intervention.

## Guard Boundary

The guard fires **only** when `nextRunAt` is in the future. If the trigger has already fired
(`nextRunAt <= now()`) but the run did not make the issue `done`, reconcile proceeds normally —
the issue is genuinely stranded and should be re-dispatched.

## Practical Steps for Agents

1. When you determine the issue must wait for an external event, do **not** mark it `done`.
2. Insert a routine + schedule trigger (see schema: `packages/db/src/schema/routines.ts`).
3. Leave the issue in `in_progress`. Paperclip will not disturb it until `nextRunAt`.
4. On wake, resume work, advance the issue, and either complete it or extend the `nextRunAt`.

## Schema Reference

| Table | Key columns |
|-------|-------------|
| `routines` | `id`, `companyId`, `parentIssueId`, `status` |
| `routine_triggers` | `routineId`, `kind`, `enabled`, `nextRunAt`, `cronExpression` |

See `packages/db/src/schema/routines.ts` for full column definitions.
