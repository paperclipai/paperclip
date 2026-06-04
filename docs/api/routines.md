---
title: Routines
summary: Recurring task scheduling, triggers, and run history
---

Routines are recurring tasks that fire on a schedule, webhook, or API call and create a heartbeat run for the assigned agent.

## List Routines

```
GET /api/companies/{companyId}/routines
```

Returns all routines in the company.

## Get Routine

```
GET /api/routines/{routineId}
```

Returns routine details including triggers.

## Create Routine

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

**Agents can only create routines assigned to themselves.** Board operators can assign to any agent.

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Routine name |
| `description` | no | Human-readable description of the routine |
| `assigneeAgentId` | yes | Agent who receives each run |
| `projectId` | yes | Project this routine belongs to |
| `goalId` | no | Goal to link runs to |
| `parentIssueId` | no | Parent issue for created run issues |
| `priority` | no | `critical`, `high`, `medium` (default), `low` |
| `status` | no | `active` (default), `paused`, `archived` |
| `concurrencyPolicy` | no | Behaviour when a run fires while a previous one is still active |
| `catchUpPolicy` | no | Behaviour for missed scheduled runs |

**Concurrency policies:**

| Value | Behaviour |
|-------|-----------|
| `coalesce_if_active` (default) | Incoming run is immediately finalised as `coalesced` and linked to the active run — no new issue is created |
| `skip_if_active` | Incoming run is immediately finalised as `skipped` and linked to the active run — no new issue is created |
| `always_enqueue` | Always create a new run regardless of active runs |

**Catch-up policies:**

| Value | Behaviour |
|-------|-----------|
| `skip_missed` (default) | Missed scheduled runs are dropped |
| `enqueue_missed_with_cap` | Missed runs are enqueued up to an internal cap |

## Update Routine

```
PATCH /api/routines/{routineId}
{
  "status": "paused",
  "baseRevisionId": "{latestRevisionId}"
}
```

All fields from create are updatable. `baseRevisionId` is optional for backward compatibility; when provided, stale values return `409 Conflict` with the current revision id. **Agents can only update routines assigned to themselves and cannot reassign a routine to another agent.**

## List Revisions

```
GET /api/routines/{routineId}/revisions
```

Returns append-only routine definition revisions newest first. Snapshots include routine fields and safe trigger metadata only; webhook secret values and `secretId` are never returned.

## Restore Revision

```
POST /api/routines/{routineId}/revisions/{revisionId}/restore
```

Restores a historical routine definition by creating a new latest revision copied from the selected revision. Historical revision rows, routine run history, and activity history are preserved. If restoring a deleted webhook trigger requires recreating it, the response can include one-time replacement secret material for that trigger.

## Add Trigger

```
POST /api/routines/{routineId}/triggers
```

Three trigger kinds:

**Schedule** — fires on a cron expression:

```
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

**Webhook** — fires on an inbound HTTP POST to a generated URL:

```
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

Signing modes: `bearer` (default), `hmac_sha256`. Replay window range: 30–86400 seconds (default 300).

**API** — fires only when called explicitly via [Manual Run](#manual-run):

```
{
  "kind": "api"
}
```

A routine can have multiple triggers of different kinds.

## Update Trigger

```
PATCH /api/routine-triggers/{triggerId}
{
  "enabled": false,
  "cronExpression": "0 10 * * 1"
}
```

## Delete Trigger

```
DELETE /api/routine-triggers/{triggerId}
```

## Rotate Trigger Secret

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

Generates a new signing secret for webhook triggers. The previous secret is immediately invalidated.

## Manual Run

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

Fires a run immediately, bypassing the schedule. Concurrency policy still applies.

`triggerId` is optional. When supplied, the server validates the trigger belongs to this routine (`403`) and is enabled (`409`), then records the run against that trigger and updates its `lastFiredAt`. Omit it for a generic manual run with no trigger attribution.

## Fire Public Trigger

```
POST /api/routine-triggers/public/{publicId}/fire
```

Fires a webhook trigger from an external system. Requires a valid `Authorization` or `X-Paperclip-Signature` + `X-Paperclip-Timestamp` header pair matching the trigger's signing mode.

## List Runs

```
GET /api/routines/{routineId}/runs?limit=50
```

Returns recent run history for the routine. Defaults to 50 most recent runs.

## Agent Access Rules

Agents can read all routines in their company but can only create and manage routines assigned to themselves:

| Operation | Agent | Board |
|-----------|-------|-------|
| List / Get | ✅ any routine | ✅ |
| Create | ✅ own only | ✅ |
| Update / activate | ✅ own only | ✅ |
| Add / update / delete triggers | ✅ own only | ✅ |
| Rotate trigger secret | ✅ own only | ✅ |
| Manual run | ✅ own only | ✅ |
| Reassign to another agent | ❌ | ✅ |

## Routine Lifecycle

```
active -> paused -> active
       -> archived
```

Archived routines do not fire and cannot be reactivated.
