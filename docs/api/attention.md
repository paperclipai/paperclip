---
title: Attention inbox
summary: Personal request routing, close actions, and decision history
---

The attention API projects pending requests and operational alerts into an inbox.
All routes require a board user with access to the company. Task and approval
privacy checks apply to cards, counts, history, and receipts. Agents cannot use
these board routes.

## Read the inbox

```text
GET /api/companies/{companyId}/attention
GET /api/companies/{companyId}/attention/summary
GET /api/companies/{companyId}/attention/tasks
```

The feed accepts these query parameters:

| Parameter | Meaning |
| --- | --- |
| `view` | `mine`, `unassigned`, `company`, `archived`, or `all`. The API default is `all`. |
| `includeDismissed` | Include personally hidden cards. Default: `false`. |
| `archived` | Read retained source archives instead of current sources. This differs from personal `view=archived`. |
| `all` | Return a complete snapshot instead of a page. |
| `limit`, `cursor` | Page size and opaque continuation cursor. Default size: 50; maximum: 100. |
| `sort` | `activity` or `decide`. |
| `activitySince`, `activityUntil` | Inclusive activity bounds in ISO date-time format. |
| `queue` | Filter by a decision queue key. |

The response includes `items`, `totalCount`, `countsBySourceKind`, `viewCounts`,
`deskBadgeCount`, and `nextCursor`. Related evidence shares one obligation lead
and counts once. `deskBadgeCount` counts requests assigned to the viewer.
Summary returns the same current counts without card bodies. Tasks also returns
unique `taskIds` for visible requests. Neither endpoint returns card bodies.

Routing uses explicit recipients, chat ownership, review participants, task
assignees, human instigators, and configured decision owners. A card with no
owner enters Unassigned. After seven days it moves to Company. A required
request that waits 30 days escalates to the configured decision owner or Company.
Task privacy still applies. Escalation keeps the request pending and its gate closed.

`view=mine` also includes receipts when someone else handles the viewer's request.
Receipts expire after seven days. They do not count as decisions or in the badge.
Every approval-linked task must remain readable to return an approval receipt.

## Claim or transfer

```text
POST /api/companies/{companyId}/attention/{sourceKind}/{sourceId}/claim
POST /api/companies/{companyId}/attention/{sourceKind}/{sourceId}/transfer
```

Claim has no body. Transfer takes `{ "userId": "<user ID>", "reason": "optional" }`.
These operations support `issue_thread_interaction` sources. Claim assigns an
ownerless request to the caller. Changing an addressed request requires its current
addressee or an active company owner/administrator (or an instance administrator).
Transfer assigns it to a writer who can read the task and satisfy the interaction
creator exclusions and the task review policy. Viewers cannot claim or transfer
requests. A chat question stays with its chat owner. A request to an agent that
can still answer stays with that agent.

The addressee is part of resolution authorization, so routing validates authority
and the recipient under task and interaction row locks before updating it. Inbox
view placement alone grants no authority. Concurrent claims and transfers retain
their compare-and-set checks. An identical repeated assignment returns
`alreadyClaimed` or `alreadyTransferred`. Changes record `attention.claimed` or
`attention.transferred` activity.

## Close a card

```text
POST /api/companies/{companyId}/attention/{sourceKind}/{sourceId}/close
```

Use one of these bodies:

```json
{ "mode": "archive", "fingerprint": "<changeFingerprint from the card>" }
```

```json
{ "mode": "snooze", "until": "2099-01-01T12:00:00.000Z", "fingerprint": "<changeFingerprint>" }
```

```json
{ "mode": "withdraw", "reason": "The proposal is no longer needed" }
```

Archive and snooze affect only the caller. The source stays pending. Hiding
obligation evidence hides its lead and all related evidence. The returned
`itemKey` identifies the personal dismissal. Restore it through the existing
inbox-dismissal restore endpoint. A content change or a new assignment to the
viewer can make a hidden card return. A snoozed card also returns when time expires.

Withdrawal affects everyone. It cancels an interaction, approval, or decision
through that source's existing lifecycle. Review policy and execution checks
still apply. A hire request must be rejected through approvals instead.
The card's `closeModes` lists its supported actions. A successful close records
`attention.closed` activity and returns the source, mode, dismissal key, and time.

## Decision history

```text
GET /api/companies/{companyId}/attention/history
```

History includes resolved interactions, decisions, and approvals. `scope=mine` shows work handled by or for the caller. `scope=all`
shows accessible company history. `handledForMe=true` narrows it to work handled
for the caller. Filters include `search`, `outcome`, `agentId`, `projectId`,
`since`, `sort=newest|oldest`, `limit` (maximum 100), and `cursor`.
Withdrawn requests, expired requests, and requests closed with their task have
separate outcomes. Personal archive and snooze do not record consent.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid source kind, UUID, filters, cursor, or request body; a snooze needs a future time. |
| `403` | No company access, no board user context, read-only membership, or a denied review policy. |
| `404` | Missing source or a source the caller cannot read. |
| `409` | Another person claimed, routed, or answered first; the request is already closed; or execution prevents withdrawal. |
| `422` | Unsupported operation, unavailable recipient, recipient without task access, or a chat ownership constraint. |

A closed-source conflict includes `code: attention_already_closed` and the
recorded resolver when known. Clients should refresh the feed and show that
outcome instead of retrying a decision automatically.
