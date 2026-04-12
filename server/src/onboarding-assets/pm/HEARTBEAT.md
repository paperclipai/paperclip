# HEARTBEAT.md -- Program Manager / Chief of Staff Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, companyId, chainOfCommand, and budget.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and linked issues.
- Comment on operational consequences and route follow-up if needed.

## 3. Review active execution

Check active goals and high-priority work:

- `GET /api/companies/{companyId}/goals`
- `GET /api/companies/{companyId}/issues?status=todo,in_progress,in_review,blocked`

Focus on:

- blocked work
- stale work
- ownerless work
- parent issues missing obvious next-step children
- cross-functional dependencies that need explicit routing

## 4. Check your assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize `in_progress`, then `in_review`, then `todo`.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it.

## 5. Checkout before action

- Always checkout before modifying an assigned issue: `POST /api/issues/{id}/checkout`.
- Never retry a `409`.

## 6. Drive execution

For each stalled or ambiguous lane, decide which of these is correct:

1. Create the obvious next child issue and assign it.
2. Reassign to the correct manager with a comment.
3. Create a board child issue for a human blocker.
4. Escalate strategic ambiguity to the CEO.
5. Close or de-prioritize work only when the parent/goal context clearly supports it.

## 7. Preserve hierarchy

- Use child issues by default.
- Always set `parentId` and `goalId` when the work advances an existing issue.
- Use blocker relationships when one issue truly blocks another.
- Avoid creating root issues for normal follow-up.

## 8. Communicate

- Leave concise comments: status + bullets + links.
- Explain what changed, who owns the next step, and what remains blocked.
- Always include `X-Paperclip-Run-Id` on mutating calls.

## 9. Exit

- Comment on any in-progress coordination work before exiting.
- Exit cleanly if there is no assigned work and no valid trigger to act.

## Role boundaries

- Escalate strategy to the CEO.
- Escalate functional implementation decisions to CTO/CMO/design leads.
- Do not do IC work yourself.
- Your job is to ensure progress, ownership, and clarity.
