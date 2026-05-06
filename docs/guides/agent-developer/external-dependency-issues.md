# External-Dependency Issues and Routine-Based Wake-Up

When an issue is `in_progress` and the next step depends on something external (a human approval, a slow pipeline, a third-party API, a scheduled data feed), the agent should register a **routine schedule** that targets the issue instead of busy-polling or leaving the issue stranded.

## Why this matters (DGG-5094)

Paperclip's heartbeat reconciler (`reconcileStrandedAssignedIssues`) periodically scans for `in_progress` issues that appear to have no live execution path.
Before DGG-5094 it recognised only two live-path signals:

| Signal | Description |
|---|---|
| Active heartbeat run | A `queued`, `running`, or `scheduled_retry` run referencing the issue |
| Deferred issue execution wake | An `agentWakeupRequests` row with `status = deferred_issue_execution` |

An issue waiting on an external dependency that had _neither_ of these was misclassified as stranded, triggering unnecessary recovery issues (the DGG-5074 wake-loop pattern).

After DGG-5094 a **future routine schedule** is also recognised as a live execution path:
a `routines` row with `parentIssueId = <issue id>`, `status = active`, joined to a `routineTriggers` row with `enabled = true` and `nextRunAt > now()`.

## How to register a routine schedule

Set the issue status to `in_progress` (or leave it there), then create a routine that targets it:

```
# 1. Create the routine
POST /api/companies/{companyId}/routines
{
  "title": "Wait for external API readiness",
  "description": "Polls once the dependency is expected to be ready",
  "parentIssueId": "{issueId}",
  "assigneeAgentId": "{yourAgentId}",
  "status": "active"
}
# -> { "id": "{routineId}", ... }

# 2. Attach a schedule trigger
POST /api/routines/{routineId}/triggers
{
  "kind": "schedule",
  "label": "daily-check",
  "cronExpression": "0 9 * * *",
  "timezone": "UTC",
  "enabled": true
}
```

Once the trigger's `nextRunAt` is in the future the reconciler will consider the issue _live_ and will not create a stranded-issue recovery ticket for it.

When the routine fires it creates a new heartbeat run with the issue in context; the agent can then re-evaluate whether the dependency has been satisfied and advance or re-schedule accordingly.

## What prevents the DGG-5074 wake-loop

The wake-loop occurred because:

1. An in_progress issue had a succeeded run but no queued/running follow-up run.
2. The reconciler classified it as stranded and issued a recovery wake.
3. The recovery wake produced another succeeded run with no follow-up.
4. Repeat from step 2.

Registering a future routine schedule (step above) breaks the loop at step 2: `hasActiveExecutionPath` returns `true` and the reconciler skips the issue entirely, producing zero recovery wakes until the scheduled run fires.

## See also

- `docs/guides/agent-developer/heartbeat-protocol.md` — heartbeat lifecycle overview
- `server/src/services/recovery/service.ts` → `hasActiveExecutionPath` — implementation
- DGG-5094 — original fix; DGG-5074 — wake-loop incident that motivated it
