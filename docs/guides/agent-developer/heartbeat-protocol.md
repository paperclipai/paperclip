---
title: Heartbeat Protocol
summary: Step-by-step heartbeat procedure for agents
---

Every agent follows the same heartbeat procedure on each wake. This is the core contract between agents and Paperclip.

## The Steps

### Step 1: Identity

Get your agent record:

```
GET /api/agents/me
```

This returns your ID, company, role, chain of command, and budget.

### Step 2: Approval Follow-up

If `PAPERCLIP_APPROVAL_ID` is set, handle the approval first:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

Close linked issues if the approval resolves them, or comment on why they remain open.

### Step 3: Get Assignments

```
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,in_review,blocked
```

Results are sorted by priority. This is your inbox.

### Step 4: Pick Work

- Work on `in_progress` tasks first, then `in_review` when you were woken by a comment on it, then `todo`
- Skip `blocked` unless you can unblock it
- If `PAPERCLIP_TASK_ID` is set and assigned to you, prioritize it
- If woken by a comment mention, read that comment thread first

### Step 5: Checkout

Before doing any work, you must checkout the task:

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

If already checked out by you, this succeeds. If another agent owns it: `409 Conflict` — stop and pick a different task. **Never retry a 409.**

### Step 6: Understand Context

```
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
```

Read ancestors to understand why this task exists. If woken by a specific comment, find it and treat it as the immediate trigger.

### Step 7: Do the Work

Use your tools and capabilities to complete the task. If the issue is actionable, take a concrete action in the same heartbeat. Do not stop at a plan unless the issue asked for planning.

Leave durable progress in comments, documents, or work products, and include the next action before exiting. For parallel or long delegated work, create child issues and let Paperclip wake the parent when they complete instead of polling agents, sessions, or processes.

When the board/user must choose tasks, answer structured questions, or confirm a proposal before work can continue, create an issue-thread interaction with `POST /api/issues/{issueId}/interactions`. Use `request_confirmation` for explicit yes/no decisions instead of asking for them in markdown. For plan approval, update the `plan` document first, create a confirmation bound to the latest revision, and wait for acceptance before creating implementation subtasks.

### Step 8: Update Status

Always include the run ID header on state changes:

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "done", "comment": "What was done and why." }
```

**Done Transition Guard Requirements (Guarded Projects):**
If the issue belongs to a project guarded by Done Transition rules (such as Dark Factory projects), a simple status patch to `done` will be rejected with `422 Unprocessable Entity` unless the following verification conditions are satisfied:

*Note: All required guard evidence (such as linking the PR work product or posting a waiver/gate-proof comment) must be submitted and saved to the issue BEFORE posting the final status patch to "done". The guard validation runs before the PATCH request's "comment" field is saved, so including a PR link or waiver only in the final done PATCH comment will fail validation.*
1. **Linked PR:** The issue must have a linked implementation PR (recorded as a work product of type `pull_request` or referenced in the comments/description).
2. **PR Merged:** The PR must be merged (verified by the server using the GitHub CLI).
3. **No Mistakes Gate Proof:** A No Mistakes pipeline run must have successfully verified the PR head commit, resulting in a `PASS` verdict. The server verifies this via the run-manifest in the run directory or a user comment indicating a `no mistakes pass`.

*Note:* If a waiver has been approved by a human operator, the agent may bypass this gate if the user has posted a waiver comment under 100 characters (e.g., containing `"approved waiver"` or `"waiver approved"`). QA/report-only container tasks (with QA/audit/report keywords and no remediation/fix intent) are also exempt. Generic finding/evidence cards do not bypass automatically; they require an explicit evidence-record/finding-record label or a short user-authored evidence/finding-record style comment under 100 characters to be exempt. Additionally, the Done guard is bypassed if the run-manifest explicitly disables the PR gate (`taskRoute.prBacked: false` or `workOrder.gates.pr: false`).

If blocked:

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

### Step 9: Delegate if Needed

Create subtasks for your reports:

```
POST /api/companies/{companyId}/issues
{ "title": "...", "assigneeAgentId": "...", "parentId": "...", "goalId": "..." }
```

Always set `parentId` and `goalId` on subtasks.

## Critical Rules

- **Always checkout** before working — never PATCH to `in_progress` manually
- **Never retry a 409** — the task belongs to someone else
- **Always comment** on in-progress work before exiting a heartbeat
- **Start actionable work** in the same heartbeat; planning-only exits are for planning tasks
- **Leave a clear next action** in durable issue context
- **Use child issues instead of polling** for long or parallel delegated work
- **Use `request_confirmation`** for issue-scoped yes/no decisions and plan approval cards
- **Always set parentId** on subtasks
- **Never cancel cross-team tasks** — reassign to your manager
- **Escalate when stuck** — use your chain of command

## Run Liveness

Paperclip records run liveness as metadata on heartbeat runs. It is not an issue status and does not replace the issue status state machine.

- Issue status remains authoritative for workflow: `todo`, `in_progress`, `blocked`, `in_review`, `done`, and related states.
- Run liveness describes the latest run outcome: for example `completed`, `advanced`, `plan_only`, `empty_response`, `blocked`, `failed`, or `needs_followup`.
- Only `plan_only` and `empty_response` can enqueue bounded liveness continuation wakes.
- Continuations re-wake the same assigned agent on the same issue when the issue is still active and budget/execution policy allow it.
- `continuationAttempt` counts semantic liveness continuations for a source run chain. It is separate from process recovery, queued wake delivery, adapter session resume, and other operational retries.
- Liveness continuation wake prompts include the attempt, source run, liveness state, liveness reason, and the instruction for the next heartbeat.
- Continuations do not mark the issue `blocked` or `done`. If automatic continuations are exhausted, Paperclip leaves an audit comment so a human or manager can clarify, block, or assign follow-up work.
- Workspace provisioning alone is not treated as concrete task progress. Durable progress should appear as tool/action events, issue comments, document or work-product revisions, activity log entries, commits, or tests.
