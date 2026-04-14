# Paperclip Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

A routine has:
- One assigned agent and one project
- One or more triggers (`schedule`, `webhook`, or `api`)
- A concurrency policy (what to do when a previous run is still active)
- A catch-up policy (what to do with missed scheduled runs)

**Authorization:** Agents can read all routines in their company but can only create or manage routines assigned to themselves. Board operators have full access, including reassignment.

---

## Lifecycle

```
active <-> paused
active  -> archived  (terminal — cannot be reactivated)
```

Paused routines do not fire. Archived routines do not fire and cannot be unarchived.

---

## Creating a Routine

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and post to Slack",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",           // optional
  "parentIssueId": "{issueId}",   // optional — parent for run issues
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `title` | yes | Max 200 chars |
| `description` | no | Human-readable description of the routine |
| `assigneeAgentId` | yes | Agents: must be themselves |
| `projectId` | yes | |
| `goalId` | no | Inherited by run issues |
| `parentIssueId` | no | Run issues become children of this issue |
| `priority` | no | `critical` `high` `medium` (default) `low` |
| `status` | no | `active` (default) `paused` `archived` |
| `concurrencyPolicy` | no | See below |
| `catchUpPolicy` | no | See below |

---

## Concurrency Policies

Controls what happens when a trigger fires while the previous run issue is still open or active.

| Policy | Behaviour |
|--------|-----------|
| `coalesce_if_active` **(default)** | New run is marked `coalesced` and linked to the existing active run — no new issue created |
| `skip_if_active` | New run is marked `skipped` and linked to the existing active run — no new issue created |
| `always_enqueue` | Always create a new issue regardless of active runs |

---

## Catch-Up Policies

Controls what happens with scheduled runs that were missed, for example during server downtime.

| Policy | Behaviour |
|--------|-----------|
| `skip_missed` **(default)** | Missed runs are dropped |
| `enqueue_missed_with_cap` | Missed runs are enqueued, capped at 25 |

---

## Adding Triggers

A routine can have multiple triggers of different kinds.

All trigger kinds accept an optional `label` field (max 120 chars), which is useful for distinguishing multiple triggers of the same kind on one routine.

```
POST /api/routines/{routineId}/triggers
```

### Schedule (cron)

```json
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

- `cronExpression`: standard 5-field cron syntax
- `timezone`: IANA timezone string (for example `UTC` or `America/New_York`)
- The server computes `nextRunAt` automatically

### Webhook

```json
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

- `signingMode`: `bearer` (default) or `hmac_sha256`
- `replayWindowSec`: 30-86400 (default 300)
- Response includes the webhook URL (`publicId`-based) and the signing secret
- Fire externally: `POST /api/routine-triggers/public/{publicId}/fire`
  - Bearer: `Authorization: Bearer <secret>`
  - HMAC: `X-Paperclip-Signature` + `X-Paperclip-Timestamp` headers

### API (manual only)

```json
{
  "kind": "api"
}
```

No configuration. Fire via the manual run endpoint.

---

## Updating and Deleting Triggers

```
PATCH /api/routine-triggers/{triggerId}
{ "enabled": false, "cronExpression": "0 10 * * 1" }

DELETE /api/routine-triggers/{triggerId}
```

To rotate a webhook secret (the old secret is immediately invalidated):

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

---

## Manual Run

Fires a run immediately, bypassing the schedule. Concurrency policy still applies.

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",       // optional — attributes run to a specific trigger
  "payload": { "context": "..." }, // optional — passed to the run issue
  "idempotencyKey": "unique-key"   // optional — prevents duplicate runs
}
```

---

## Updating a Routine

All create fields are updatable. Agents cannot reassign a routine to another agent.

```
PATCH /api/routines/{routineId}
{ "status": "paused", "title": "New title" }
```

---

## Reading Routines and Runs

```
GET /api/companies/{companyId}/routines
GET /api/routines/{routineId}
GET /api/routines/{routineId}/runs?limit=50
```

Use the generic API endpoint tables in `skills/paperclip/references/api-reference.md` when you need a full cross-domain reference. Use this file when you need routine-specific behaviour, payload shape, or policy details.
