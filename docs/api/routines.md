---
title: Routines
summary: Recurring task scheduling, triggers, and run history
---

Routines are recurring tasks that fire on a schedule, webhook, or API call and create a heartbeat run for the assigned agent. Depending on concurrency policy, a run may create a new issue, reuse the routine's canonical open issue, or coalesce/skip against a live execution.

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

Routine detail and list payloads also expose execution-state fields for routine-backed issues:

- `canonicalIssue`: the single durable open issue for `coalesce_if_active` and `skip_if_active`
- `liveIssue`: the canonical issue only while a live heartbeat run is attached
- `executionState`: `none`, `paused`, `idle`, or `live`
- `activeIssue`: legacy alias for `liveIssue`

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
| `coalesce_if_active` (default) | If a live canonical issue exists, the new run is finalised as `coalesced`. If the canonical issue is still open but idle, the new run is finalised as `issue_reused` and wakes that existing issue instead of creating a new ticket. |
| `skip_if_active` | If a live canonical issue exists, the new run is finalised as `skipped`. If the canonical issue is open but idle, the run reuses and re-wakes that issue instead of creating a new ticket. |
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
  "status": "paused"
}
```

All fields from create are updatable. **Agents can only update routines assigned to themselves and cannot reassign a routine to another agent.**

Pausing a routine is stronger than disabling the scheduler:

- schedules stop firing
- manual runs return `409`
- webhook/public trigger fires return `409`
- queued routine wakeups are cancelled so COO cannot keep re-waking paused routine issues
- already-queued routine heartbeat runs are cancelled and cleared off the issue before queued-run recovery can claim them

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

Paused routines reject manual runs with `409`.

`triggerId` is optional. When supplied, the server validates the trigger belongs to this routine (`403`) and is enabled (`409`), then records the run against that trigger and updates its `lastFiredAt`. Omit it for a generic manual run with no trigger attribution.

## Fire Public Trigger

```
POST /api/routine-triggers/public/{publicId}/fire
```

Fires a webhook trigger from an external system. Requires a valid `Authorization` or `X-PrivateClip-Signature` + `X-PrivateClip-Timestamp` header pair matching the trigger's signing mode.

Paused routines reject public trigger fires with `409`.

## List Runs

```
GET /api/routines/{routineId}/runs?limit=50
```

Returns recent run history for the routine. Defaults to 50 most recent runs.

Routine run statuses include:

- `issue_created`
- `issue_reused`
- `coalesced`
- `skipped`
- `completed`
- `failed`

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
