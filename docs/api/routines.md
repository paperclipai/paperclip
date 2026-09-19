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

Signing modes: `bearer` (default), `hmac_sha256`, `github_hmac`, and `none`.
The replay window applies to `hmac_sha256` only: 30–86400 seconds (default 300).
Creating a webhook returns `trigger` and one-time `secretMaterial` containing
`webhookUrl` and `webhookSecret`. Save the secret before closing the dialog.
Routine details retain the URL; rotate the secret if its value is lost.

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

Fires a webhook trigger from an external system without a Paperclip login. Send
`Content-Type: application/json` and a JSON object. The trigger authenticates the
request using its own secret; an agent or board API key is not a substitute.

| Mode | Headers and signature |
|------|-----------------------|
| `bearer` | `Authorization: Bearer <webhookSecret>` |
| `hmac_sha256` | `X-Paperclip-Timestamp` (Unix seconds or milliseconds) and `X-Paperclip-Signature: sha256=<hex>`; HMAC-SHA256 over the timestamp string, a dot, and the exact body bytes |
| `github_hmac` | `X-Hub-Signature-256: sha256=<hex>`; HMAC-SHA256 over the exact body bytes, without a timestamp. `X-Paperclip-Signature` is also accepted. Configure GitHub to send JSON. |
| `none` | No signature. Anyone with the generated URL can fire the trigger; keep it private. |

For a bearer trigger:

```sh
curl --fail-with-body "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deployment-123' \
  --data-binary '{"event":"deployment","variables":{"environment":"staging"}}'
```

For a timestamped HMAC trigger, sign and send the same bytes:

```js
import { createHmac } from "node:crypto";
const body = JSON.stringify({ variables: { environment: "staging" } });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", process.env.WEBHOOK_SECRET)
  .update(`${timestamp}.`).update(body).digest("hex");
const response = await fetch(process.env.WEBHOOK_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Paperclip-Timestamp": timestamp,
    "X-Paperclip-Signature": `sha256=${signature}`,
  },
  body,
});
console.log(response.status, await response.json());
```

`202` returns the routine run, including its status and linked task. The task
runs asynchronously, so acceptance does not mean the agent has finished.
Concurrency policy can coalesce or skip a delivery while work is active.
Payload fields or a nested `variables` object supply declared routine variables;
nested values take precedence. The full payload is retained in run history.

For bearer, GitHub HMAC, and unsigned triggers, send a stable `Idempotency-Key`
when retrying a delivery to receive the original run without creating another
task. Timestamped HMAC rejects an identical signed delivery with `409`, even
inside the replay window; stale timestamps and invalid secrets/signatures return
`401`. Disabled triggers and paused/archived routines return `409`. Missing
required variables return `422`; non-JSON media types return `415` and invalid
JSON objects return `400`. Rotating a secret immediately invalidates the old one.

Cloud installations use their canonical public origin for generated URLs.
Self-hosted installations should set `PAPERCLIP_PUBLIC_URL` to their HTTPS
origin. The reverse proxy must forward this POST endpoint and its authorization,
signature, timestamp, and idempotency headers without requiring a browser login.
For local HTTPS testing, proxy an isolated test instance through Tailscale Serve;
use Funnel only if the sender is outside the tailnet. Existing routine and agent
execution controls still apply, including the isolated-worktree execution gate.

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

## Routine detail navigation

The routine detail page keeps **Runs** and **Activity** in the routine sidebar. Runs lists the execution issues for that routine using the shared issue list, including issue status, priority, assignee, and search controls. Activity shows the routine, trigger, and run event timeline without leaving the routine page. The overview links to these same local tabs.


## Webhook setup and connection checks

Create a webhook trigger with `setupPending: true` to configure it safely. While setup is pending, authenticated deliveries return `202` with `{ "status": "test_received", "test": true, "routineStarted": false, "linkedIssueId": null }`. They never create a routine run, task, or agent wakeup. This state survives refreshes and server restarts, and connection checks also work while the routine is paused. Invalid authentication still returns `401`.

Routine detail exposes `setupPending` and `lastWebhookDelivery` (`status`, `receivedAt`, and `test`) so the wizard can show live connection feedback. The secret is only returned at creation or rotation; it is never stored in browser draft storage or included in routine detail.

Finish setup with `PATCH /api/routine-triggers/{id}` and `{ "setupPending": false }`. Future deliveries use normal routine dispatch and still respect the routine's enabled state. Test events are not dispatched on activation. Retries with the same `Idempotency-Key`, GitHub `X-GitHub-Delivery`, or timestamp-HMAC replay key remain test receipts after activation. Send a unique delivery ID per event so a sender's retries can be recognized. Requests without a delivery ID are new events after activation.

For compatibility, API-created triggers without `setupPending: true` are immediately live. Completed triggers cannot be returned to setup mode. Checking a previously enabled webhook observes real deliveries and can start the routine; the management UI explains this difference.

Trigger cards support removal with Undo. `PATCH` with `{ "archived": true }` excludes a trigger from routine detail and scheduling, and rejects its webhook deliveries. Setting `archived` back to `false` restores the same URL and credentials. `DELETE` remains the permanent deletion API.

The webhook wizard and saved trigger editor warn about localhost, private-network addresses, Tailscale hostnames, and HTTP URLs without blocking setup. HTTPS does not imply public access: Tailscale Serve is private, while Funnel can expose the same hostname publicly. These warnings inspect the URL only; they do not resolve DNS or test internet reachability. Use [the HTTPS setup guide](https://docs.paperclip.ing/reference/deploy/https/) to configure public access when the sender is outside your network.
