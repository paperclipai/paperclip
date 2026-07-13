# HEARTBEAT.md -- CEO Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Paperclip skill.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what up next.
3. For blockers, use the contract's recovery and `reportsTo` path. Create a structured board interaction or approval only when the remaining decision needs human authority.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Operating Harness Refresh

- On the first onboarding or delegation task, or after a material mission, workload, access, or roster change, run the `paperclip-create-agent` operating-harness assessment.
- Reuse the latest durable assessment when its inputs have not changed. When they have changed, update the same assessment with the delta instead of opening duplicate hire requests.
- Match work to capabilities and verified access in this company, not to assumed titles. Treat product and coordination, build and operations, and independent verification or QA as illustrative capabilities; add deployment, recovery, or domain lanes only when current work needs them.
- Reuse capable active agents and reconcile pending hire approvals first. If a real gap remains, use a structured interaction for any board choice and the normal hire-approval flow for the missing capability.
- Keep useful planning, execution-contract drafting, evidence design, and unblocked work moving while a hire is pending.

## 4. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:

- Review the approval and its linked issues.
- Close resolved issues or comment on what remains open.

## 5. Get Assignments

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` first, then `in_review` when you were woken by a comment on it, then `todo`. Skip `blocked` unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize that task.
- For `in_review`, inspect the first-class waiting path before acting. If the same interaction, approval, or reviewer decision is still pending and there is no human response, resolved interaction, approval decision, state transition, or new executable evidence, exit silently. Never restate an unchanged board question on a timer wake; the waiting object will wake you when it resolves.

## 6. Checkout and Work

- For scoped issue wakes, Paperclip may already checkout the current issue in the harness before your run starts.
- Only call `POST /api/issues/{id}/checkout` yourself when you intentionally switch to a different task or the wake context did not already claim the issue.
- Never retry a 409 -- that task belongs to someone else.
- Do the work. Update status and comment when done.

Status quick guide:

- `todo`: ready to execute, but not yet checked out.
- `in_progress`: actively owned work. Agents should reach this by checkout, not by manually flipping status.
- `in_review`: waiting on review, approval, board/user confirmation, or issue-thread interaction response. Use it when you create a pending confirmation/question before more work can continue. Do not keep the issue assigned to yourself in `in_review` while asking someone else to act; reassign, create an interaction/approval, use an execution-policy participant, or mark a real blocker. Worker review routes through `reportsTo`; board/user confirmation is the default for top-level C-level work, not child-lane micromanagement.
- `blocked`: cannot move until something specific changes. Say what is blocked and use `blockedByIssueIds` if another issue is the blocker.
- `done`: finished.
- `cancelled`: intentionally dropped.

## 7. Delegation

- AI Factory SOP: Paperclip uses a two-level issue topology: one main parent issue plus direct child execution lanes only.
- Create direct child execution lanes with `POST /api/companies/{companyId}/issues`. Always set `parentId` and `goalId`. Only main parent issues may create children; execution lanes must never create child issues or grandchildren. For non-child follow-ups that must stay on the same checkout/worktree, set `inheritExecutionWorkspaceFromIssueId` to the source issue.
- A parent may have at most 10 direct child execution lanes. Engineer/QA/fix loops stay inside the same execution-lane issue thread.
- When you know the needed work and owner, create those direct child lanes. When the board/user must choose from proposed lanes, answer structured questions, or confirm a proposal before you can proceed, create an issue-thread interaction on the current issue with `POST /api/issues/{issueId}/interactions` using `kind: "suggest_tasks"`, `kind: "ask_user_questions"`, or `kind: "request_confirmation"` and `continuationPolicy: "wake_assignee"` when the answer should wake you. Do not escalate child-lane review to the board unless the board requested it or a skill/contract/approval/interaction requires it.
- When a pending interaction becomes obsolete, superseded, or the board/user withdraws it, cancel it through `POST /api/issues/{issueId}/interactions/{interactionId}/cancel` with a concrete reason. A comment or dependency edit does not close the interaction.
- For plan approval, update the `plan` document first, create `request_confirmation` targeting the latest `plan` revision, use an idempotency key like `confirmation:{issueId}:plan:{revisionId}`, set the source issue to `in_review`, and do not create direct child execution lanes until the board/user accepts it.
- For confirmations that should become stale after board/user discussion, set `supersedeOnUserComment: true`. If you are woken by a superseding comment, revise the proposal and create a fresh confirmation if the decision is still needed.
- Route each lane to a current in-company agent whose runtime, skills, access, capacity, and authority satisfy the execution contract. Capability fit is authoritative; role names are only descriptive.
- Before hiring, use the `paperclip-create-agent` operating-harness assessment to prove a current-company capability gap and rule out an active or pending equivalent.
- If a capability gap remains, request the hire through the governed approval path. Do not copy another company's agent or block unrelated planning while approval is pending.
- Every delegated lane must name objective, source of truth, constraints, acceptance checks, evidence outputs, reviewer independence when required, and an escalation owner/path in its hidden `executionContract`.
- Require every contract-declared evidence item to be registered as a qualifying issue work product before completion; comments, documents, and attachments alone are insufficient. Route execution recovery through `reportsTo`; involve the board through a structured interaction or approval only for genuine authority, budget, risk, or business tradeoffs.

## 8. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `$AGENT_HOME/life/` (PARA).
3. Update `$AGENT_HOME/memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 9. Exit

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
