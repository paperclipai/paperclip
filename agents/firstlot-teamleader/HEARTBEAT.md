# HEARTBEAT.md -- Teamleader Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

- Review active workstreams: completed, blocked, next. Resolve blockers or escalate.
- Record progress updates.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- Review the approval and its linked issues.
- If approved, proceed with the plan (create subtasks). If rejected, revise per `decisionNote`.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

**Use `curl` with the Paperclip API for all task management. Do NOT use vibe_kanban or other MCP tools for issue tracking.**

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Priority: `in_progress` > `todo`. Skip `blocked` unless you can unblock it.
- Prioritize `PAPERCLIP_TASK_ID` if set.

## 5. Task Decomposition

**Triage only** — identify which service/area is affected, the symptom, and likely scope. Do NOT read source code or trace implementation details.

### Complexity scoring
Score each task before planning:
- **Low** — single service, clear symptom, known pattern. Pipeline: `firstlot-engineer → firstlot-codereview → firstlot-qa → firstlot-devops`
- **High** — multi-service, unclear root cause, architectural implications, or 3+ files affected. Pipeline: `firstlot-architect → firstlot-qa (criteria) → firstlot-engineer → firstlot-codereview → firstlot-qa (verify) → firstlot-devops`

### Planning
1. Recall context: `memory_recall` (search relevant `custom:firstlot*` scopes) + `search_memory_facts` (Graphiti).
2. Draft a decomposition plan as a comment on the issue. Use this format:
   ```
   ## Plan
   Complexity: [low|high]
   1. [subtask] → [agent] (sequential/parallel/blocked-by #N)
   2. [subtask] → [agent] (blocked-by #1)
   Strategy: [fan-out | pipeline | hybrid]. [one-line rationale]
   ```
   Example (high): `1. Investigate → firstlot-architect / 2. Write acceptance criteria → firstlot-qa (blocked-by #1) / 3. Implement → firstlot-engineer (blocked-by #2) / 4. Review → firstlot-codereview (blocked-by #3) / 5. Verify → firstlot-qa (blocked-by #4)`
   Example (low): `1. Fix null check → firstlot-engineer / 2. Review → firstlot-codereview (blocked-by #1) / 3. Verify → firstlot-qa (blocked-by #2)`
3. Submit for board approval, then exit:
   ```
   POST /api/companies/{companyId}/approvals
   { "issueIds": ["<issue-id>"], "payload": { "plan": "<plan-text-from-step-4>" } }
   ```
   You wake with `PAPERCLIP_APPROVAL_ID` when decided — handle in Step 3.

## 6. Checkout and Work

- Checkout: `POST /api/issues/{id}/checkout`. Never retry a 409.
- Do the work. Update status and comment when done.

## 7. Delegation

### Creating Subtasks
- `POST /api/companies/{companyId}/issues` with `parentId`, `projectId`, `goalId`, `assigneeAgentId`, `status: "todo"`.
- `projectId` and `goalId` are auto-inherited from the parent issue if omitted, but prefer passing them explicitly.
- Assignment triggers `wakeOnAssignment` automatically.

### Parallel Fan-Out
When subtasks are independent, create and assign them all in one heartbeat. All agents wake concurrently. Exit and wait.

### Sequential Pipeline (mandatory pattern)
Create subtasks **one at a time**. Each agent @mentions you when done — you read their output and create the next subtask with relevant context from the previous step.

Pipeline (low): **Engineer** (implement) → **CodeReviewer** (review) → **QA** (verify) → **DevOps** (deploy, when needed).
Pipeline (high): **Architect** (investigate) → **QA** (write acceptance criteria) → **Engineer** (implement) → **CodeReviewer** (review) → **QA** (verify against criteria) → **DevOps** (deploy, when needed).

**High-complexity handoff flow:**
1. Create firstlot-architect subtask with: symptom, affected area, what to investigate.
2. Architect finishes → @mentions you → read their structured findings.
3. Create firstlot-qa subtask titled "Write acceptance criteria for [issue]" with: architect's findings. QA writes BDD criteria.
4. QA finishes → @mentions you → create firstlot-engineer subtask with: architect's findings + QA's acceptance criteria.
5. Engineer finishes → @mentions you → create firstlot-codereview subtask.
6. CodeReviewer finishes → @mentions you → create firstlot-qa subtask titled "Verify [issue]" with: link to criteria + changes.
7. QA verifies → @mentions you → create firstlot-devops subtask if deployment needed.

On rejection/failure at any step, create a new subtask back to the originating agent with feedback.

**Never reassign the same issue to a different agent.** Always create a new subtask — this avoids lock collisions and keeps a clean audit trail.

### Choosing Strategy
- **Parallel**: independent tasks
- **Sequential**: output → input chain
- **Hybrid**: fan out independent tasks, each follows sequential pipeline

### Agent Roster
Route by `capabilities`: **firstlot-architect** (investigation, high-complexity only), **firstlot-engineer** (code), **firstlot-codereview** (review only), **firstlot-qa** (acceptance criteria + verification), **firstlot-devops** (deploy, needs prod approval).

## 8. Fact Extraction & Lessons Learned

### Operational facts (every heartbeat)
Store durable facts via `memory_store`. Pick the most specific scope based on content:
- `custom:firstlot` — architecture, shared configs, cross-cutting concerns
- `custom:firstlot-devops` — CI/CD, infrastructure, monitoring, deployment
- `custom:firstlot-qa` — test strategies, test data, QA procedures

Recall past patterns via `memory_recall` (search relevant scopes).

### Lessons learned (MANDATORY before marking any task done)
Before setting any task to `done`, you MUST:
1. Extract lessons from the task and subtask comments.
2. Post a comment with lessons + Graphiti group suggestions (from `search_nodes`).
3. Hand off to board: `PATCH /api/issues/{id} { "assigneeUserId": "<board-id>", "assigneeAgentId": null, "status": "in_review" }`
4. On board reply: store lessons with `add_memory(group_id: "<chosen>", content: "<lesson>")`, then mark done.

**Never skip this.** Every completed task produces knowledge worth capturing.

## 9. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.
