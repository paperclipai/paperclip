---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy) behind board review.

## List Approvals

```
GET /api/companies/{companyId}/approvals
```

Query parameters:

| Param | Description |
|-------|-------------|
| `status` | Filter by status (e.g. `pending`) |
| `dedupKey` | Exact match on `payload.dedupKey` |
| `limit` | Page size, 1–500. Omit to get the full set. |
| `offset` | Rows to skip. Requires `limit`. |

Unrecognized query parameters are rejected with `400`, and the error body names
both the offending parameters and the supported set. This endpoint never
silently ignores a filter it does not understand, so a `200` means every
parameter you sent was applied.

Results are newest-first (`createdAt` descending, `id` breaking ties), so
`offset` walks a stable order. Pagination is opt-in — with no `limit`, the full
result set is returned.

### Checking for a duplicate before filing

`dedupKey` is the server-side check behind "one open approval per artifact".
Query it before creating an approval and only file when the result is empty:

```
GET /api/companies/{companyId}/approvals?status=pending&dedupKey=issue:ENG-1234
```

An empty array here genuinely means "no pending approval for this artifact" —
previously an unsupported `dedupKey` was dropped and this returned every pending
approval, so the check passed no matter what.

## Get Approval

```
GET /api/approvals/{approvalId}
```

Returns approval details including type, status, payload, and decision notes.

## Create Approval Request

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Create Hire Request

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

Creates a draft agent and a linked `hire_agent` approval.

## Approve

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## Reject

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## Request Revision

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## Resubmit

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## Linked Issues

```
GET /api/approvals/{approvalId}/issues
```

Returns issues linked to this approval.

## Approval Comments

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## Approval Lifecycle

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
