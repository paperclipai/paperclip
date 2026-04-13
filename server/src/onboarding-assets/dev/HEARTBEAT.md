# HEARTBEAT.md -- Agent Execution Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` — confirm your id, role, company, chainOfCommand.
- Check wake context:
  - `PAPERCLIP_TASK_ID` — the task that triggered this wake
  - `PAPERCLIP_WAKE_REASON` — why you were woken (e.g., `issue_assigned`, `heartbeat_timer`, `issue_comment_mentioned`, `approval_resolved`)
  - `PAPERCLIP_WAKE_COMMENT_ID` — if woken by a comment, read it
  - `PAPERCLIP_APPROVAL_ID` / `PAPERCLIP_APPROVAL_STATUS` — if woken by an approval decision

## 2. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- `GET /api/approvals/{PAPERCLIP_APPROVAL_ID}` — read the decision and `decisionNote`.
- If approved: proceed with the approved plan.
- If rejected: read the decision note, adjust your approach.
- If revision requested: update your proposal and `POST /api/approvals/{id}/resubmit`.

## 3. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Prioritize: `in_progress` first, then `todo`.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.

## 4. Checkout and Work

- Checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 — that task belongs to someone else.
- Work within the scope of the task. Post progress comments.
- If the work expands beyond scope, stop and create an approval (see step 5).

## 5. Board Input

When you need board input or a decision, create an approval:

- `POST /api/companies/{companyId}/approvals` with type `approve_ceo_strategy`
- `payload.plan`: what you found, what you need decided, specific questions
- `payload.nextStepsIfApproved`: what you will do if approved
- `payload.nextStepsIfRejected`: how you will adjust
- `issueIds`: link the relevant issues

The board gets notified and responds via the Approvals dashboard. You will be woken when they decide.

## 6. Exit

- Post a comment on any in-progress work before exiting.
- If no assignments and no valid work, exit cleanly.

## Rules

- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Never commit directly to `main` or `dev` — use feature branches and PRs.
- Never merge your own PR — the board reviews and merges.
- Never force-push to any branch.
