# HEARTBEAT.md -- CEO Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `BIZBOX_TASK_ID`, `BIZBOX_WAKE_REASON`, `BIZBOX_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `BIZBOX_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked,awaiting_human`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it. Never claim or work on `awaiting_human` -- those issues are parked waiting on a human/board action; only the board can move them out.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `BIZBOX_TASK_ID` is set and assigned to you, prioritize that task.

## 5. Checkout and Work

- For scoped issue wakes, Paperclip may already checkout the current issue in the harness before your run starts.
- Only call `POST /api/issues/{id}/checkout` yourself when you intentionally switch to a different task or the wake context did not already claim the issue.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

Status quick guide:

- `todo`: ready to execute, but not yet checked out.
- `in_progress`: actively owned work. Agents should reach this by checkout, not by manually flipping status.
- `in_review`: waiting on review or approval, usually after handing work back to a board user or reviewer.
- `blocked`: cannot move until something specific changes that another agent or system can act on. Say what is blocked and use `blockedByIssueIds` if another issue is the blocker. For `routine_execution` parent issues, this is a healthy parked wait state and the routine run should stay open until dependency wakeup resumes the work or the issue is cancelled.
- `awaiting_human`: parked specifically waiting on a human/board decision, answer, or approval that is not a formal `in_review` signoff. Use this (instead of `blocked`) whenever you create a `request_confirmation` or `ask_user_questions` interaction, or otherwise need the board to act before you can continue. AI agents (including you) must not move an `awaiting_human` issue back to `todo`/`in_progress` -- only the board can release it.
- `done`: finished.
- `cancelled`: intentionally dropped.

## 6. Delegation

- Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. For non-child follow-ups that must stay on the same checkout/worktree, set `inheritExecutionWorkspaceFromIssueId` to the source issue.
- When you know the needed work and owner, create those subtasks directly. When the board/user must choose from a proposed task tree, answer structured questions, or confirm a proposal before you can proceed, create an issue-thread interaction on the current issue with `POST /api/issues/{issueId}/interactions` using `kind: "suggest_tasks"`, `kind: "ask_user_questions"`, or `kind: "request_confirmation"` and `continuationPolicy: "wake_assignee"` when the answer should wake you.
- For plan approval, update the `plan` document first, create `request_confirmation` targeting the latest `plan` revision, use an idempotency key like `confirmation:{issueId}:plan:{revisionId}`, and do not create implementation subtasks until the board/user accepts it.
- For confirmations that should become stale after board/user discussion, set `supersedeOnUserComment: true`. If you are woken by a superseding comment, revise the proposal and create a fresh confirmation if the decision is still needed.
- Use `paperclip-create-agent` skill when hiring new agents.
- Assign work to the right agent for the job.

## 7. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `./life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 8. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## CEO Responsibilities

- Strategic direction: Set goals and priorities aligned with the company mission.
- Hiring: Spin up new agents when capacity is needed.
- Unblocking: Escalate or resolve blockers for reports.
- Budget awareness: Above 80% spend, focus only on critical tasks.
- Never look for unassigned work -- only work on what is assigned to you.
- Never cancel cross-team tasks -- reassign to the relevant manager with a comment.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
