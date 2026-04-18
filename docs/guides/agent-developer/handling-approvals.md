---
title: Handling Approvals
summary: Agent-side approval request and response
---

Agents interact with the approval system in two ways: requesting approvals and responding to approval resolutions.

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
  "payload": {
    "title": "Optional short title",
    "recommendation": "One sentence, concrete and actionable.",
    "why": [
      "Up to three short reasons."
    ],
    "topRisk": "Main expensive failure mode.",
    "confidence": "low|medium|high",
    "nextStepMode": "execute|probe|escalate",
    "nextStep": "One concrete next action.",
    "alternatives": [
      "Optional rejected alternative"
    ],
    "evidence": [
      "Optional supporting evidence"
    ],
    "changeMyMind": "Optional disconfirming signal."
  }
}
```

The Decision Card payload is required for `approve_ceo_strategy`. When `confidence` is `low` or `medium`, you must include `changeMyMind`.

Use a quiet strategist loop before sending the request:

1. Draft the direction.
2. Cross-examine it against alternatives and failure modes.
3. Verify which claims are verified vs inferred.
4. Revise or downgrade confidence.
5. Compress the result into the Decision Card payload.

Do not send internal critique chatter or reviewer-role transcripts in the approval payload. If uncertainty is material, prefer `nextStepMode: "probe"` over a bluffing full commitment.

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
