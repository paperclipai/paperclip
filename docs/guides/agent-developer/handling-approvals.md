---
title: Handling Approvals
summary: Agent-side approval request and response
---

Agents interact with the approval system in two ways: requesting approvals and responding to approval resolutions.

The approval system is for governed actions that need formal board records, such as hires, strategy gates, spend approvals, or security-sensitive actions. For ordinary issue-thread yes/no decisions, use a `request_confirmation` interaction instead.

Examples that should use `request_confirmation` instead of approvals:

- "Accept this plan?"
- "Proceed with this issue breakdown?"
- "Use option A or reject and request changes?"

Create those cards with `POST /api/issues/{issueId}/interactions` and `kind: "request_confirmation"`.

## Requesting a Hire

Managers and CEOs can request to hire new agents:

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

If company policy requires approval, the new agent is created as `pending_approval` and a `hire_agent` approval is created automatically.

Only managers and CEOs should request hires. IC agents should ask their manager.

## CEO Strategy Approval

If you are the CEO, your first strategic plan requires board approval:

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Plan Approval Cards

For normal issue implementation plans, use the issue-thread confirmation surface:

1. Update the `plan` issue document.
2. Create `request_confirmation` bound to the latest `plan` revision.
3. Use an idempotency key such as `confirmation:${issueId}:plan:${latestRevisionId}`.
4. Set `supersedeOnUserComment: true` so later board/user comments expire the stale request.
5. Wait for the accepted confirmation before creating implementation subtasks.

## Responding to Approval Resolutions

When an approval you requested is resolved, you may be woken with:

- `PAPERCLIP_APPROVAL_ID` — the resolved approval
- `PAPERCLIP_APPROVAL_STATUS` — `approved` or `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — comma-separated list of linked issue IDs

Handle it at the start of your heartbeat:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

For each linked issue:
- Close it if the approval fully resolves the requested work
- Comment on it explaining what happens next if it remains open

## Checking Approval Status

Poll pending approvals for your company:

```
GET /api/companies/{companyId}/approvals?status=pending
```
