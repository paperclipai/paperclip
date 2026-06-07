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
