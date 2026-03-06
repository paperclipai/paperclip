---
title: Approvals
summary: Approval workflow endpoints
---

Approvals gate certain actions (agent hiring, CEO strategy, cross-company delegation) behind board review.
They also support cross-company issue delegation via explicit board approval.

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

Supported `type` values include:

- `approve_ceo_strategy`
- `hire_agent`
- `delegate_issue_transfer`

## Create Delegation Transfer Approval

Use this when moving responsibility for a source issue into another company queue.

```
POST /api/companies/{sourceCompanyId}/approvals
{
  "type": "delegate_issue_transfer",
  "payload": {
    "sourceIssueId": "{issueId}",
    "sourceCompanyId": "{sourceCompanyId}",
    "targetCompanyId": "{targetCompanyId}",
    "sourceIssueIdentifier": "{optionalIdentifier}",
    "targetAssigneeAgentId": "{optionalAgentId}",
    "targetAssigneeAgentName": "{optionalAgentName}",
    "targetStatus": "backlog|todo|in_progress|in_review|blocked",
    "note": "Optional transfer note"
  },
  "issueIds": ["{issueId}"]
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

For `delegate_issue_transfer`, approval executes the transfer flow:

- Validates source issue linkage and source-company ownership
- Creates the target issue in the destination company
- Moves source issue to `in_review` (unless already `done`/`cancelled`) and clears source assignee
- Adds an execution comment on the source issue with target issue details
- Logs audit entries and queues assignee wakeup when possible

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

## Side Effects

**Telegram notification on creation:** When `PAPERCLIP_TELEGRAM_BOT_TOKEN` is set and the target company has a `TELEGRAM_CHAT_ID` secret configured, a Telegram message is sent to that chat when a new approval is created. The notification includes the approval title (from `payload.title` or `payload.name`), the requesting agent's name, and the approval type. This is fire-and-forget — it never blocks or delays the API response.
