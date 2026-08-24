---
title: Approvals
summary: Governance flows for hiring, strategy, and plan review gates
---

Paperclip includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Plan Review Gates

Plan review gates are structured approvals on plan document revisions. Each gate targets a milestone and lists acceptance criteria. When all gates for the current plan revision are approved, the plan status auto-transitions to `approved`.

Key behaviors:
- Gates are created per revision (`POST /issues/{id}/plan/gates`)
- Each gate has acceptance criteria and an optional assigned agent
- Approve or reject via `PATCH /issues/{id}/plan/gates/{gateId}`
- A plan with one or more rejected gates stays `in_review` — a new revision with fresh gates is needed
- Gate resolutions emit live events (`plan.gate_resolved`) for real-time UI updates
- See the [Plan Documents API](/api/plans) for the full workflow

### Hire Agent

When an agent (typically a manager or CEO) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### CEO Strategy

The CEO's initial strategic plan requires board approval before the CEO can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
