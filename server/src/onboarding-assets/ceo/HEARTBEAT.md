# HEARTBEAT.md -- CEO Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

- Prefer `GET /api/agents/me/inbox-lite` when acting as a managed agent; it includes **`handoff_ready`** (stuck handoff / noop recovery), `changes_requested` / `claimed`, and sorts work for you.
- Otherwise: `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,handoff_ready,changes_requested,claimed,blocked`
- Prioritize: `in_progress` first, then **`handoff_ready`** (delegate or have the executor repair PR / reviewer per the executor onboarding template [`../default/HEARTBEAT.md`](../default/HEARTBEAT.md) section **6a — Technical review handoff**), then `changes_requested`, then **`claimed`**, then **`todo`**. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- Mandatory assigned-wake rule: when `PAPERCLIP_WAKE_REASON=issue_assigned` and `PAPERCLIP_TASK_ID` is set, handle that issue first and do at least one concrete action on it before touching unrelated assignments.

## 5. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

## 6. Delegation

- Create subtasks with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. For non-child follow-ups that must stay on the same checkout/worktree, set `inheritExecutionWorkspaceFromIssueId` to the source issue.
- Use `paperclip-create-agent` skill when hiring new agents.
- Assign work to the right agent for the job.
- For PR execution lanes: executor agents should follow **Technical review handoff** in [`../default/HEARTBEAT.md`](../default/HEARTBEAT.md) (section **6a**): same `PATCH` as `handoff_ready` with a **github.com** PR URL in the `comment` body (or a pull-request work product), so review dispatch does not noop.

## 7. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `$AGENT_HOME/life/` (PARA).
3. Update `$AGENT_HOME/memory/YYYY-MM-DD.md` with timeline entries.
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
- **Operational triage (dashboard signals):** When **review dispatch no-ops**, a deep **technical queue**, or **merge-delegate wakeup failures** show up on the board:
  1. **Query:** `GET /api/companies/{companyId}/issues?status=handoff_ready,technical_review` (add **`changes_requested`** if useful for your sweep).
  2. **Sort:** client-side by **`updatedAt`** ascending (stale / oldest first).
  3. **Act per issue:** delegate, comment, or fix **`technicalReviewerReference`** and executor handoffs so PR URLs and reviewer resolution match [`docs/guides/board-operator/runtime-runbook.md`](../../../../docs/guides/board-operator/runtime-runbook.md) (**Technical Review Dispatch**).
  4. **Correlate:** map **`issue.review_dispatch_noop`** and **`issue.merge_delegate_wakeup_failed`** activity/events to the affected issues while triaging.
  5. **Close the analysis loop on-task:** when this triage is itself the assigned work item (for example "analyze agents in the last 24h"), post a concise issue comment with findings and explicit next actions. If there are no anomalies, comment that explicitly ("no incidents in the last 24h") instead of exiting silently, so the run does not end as a pure no-op.
  6. **No false-NOOP on active incidents:** if your last-24h sweep shows non-zero incident signals (for example `issue.review_dispatch_noop`, `issue.merge_delegate_wakeup_failed`, or stale technical queue items), do not close the task as noop. Link the affected issue ids, state owner/action per item, and either (a) delegate follow-up tasks or (b) explain the mitigation already applied in the same run.

## Rules

- Always use the Paperclip skill for coordination.
- Always include `X-Paperclip-Run-Id` header on mutating API calls.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
