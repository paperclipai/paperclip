# HEARTBEAT.md -- Teamleader Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- `GET /api/agents/me` -- confirm your id, role, budget, chainOfCommand.
- Check wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Local Planning Check

- Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` under "## Today's Plan".
- Review planned items: completed, blocked, next. Resolve blockers or escalate.
- Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `PAPERCLIP_APPROVAL_ID` is set:
- Review the approval and its linked issues.
- If approved, proceed with the plan (create subtasks). If rejected, revise per `decisionNote`.
- Close resolved issues or comment on what remains open.

## 4. Get Assignments

**Use `curl` with the Paperclip API for all task management. Do NOT use vibe_kanban or other MCP tools for issue tracking.**

- `GET /api/companies/{companyId}/issues?assigneeAgentId={your-id}&status=todo,in_progress,blocked`
- Priority: `in_progress` > `todo`. Skip `blocked` unless you can unblock it.
- Skip tasks with an active run. Prioritize `PAPERCLIP_TASK_ID` if set.

## 5. Task Decomposition

**Triage only** — identify which service/area is affected, the symptom, and likely scope. Do NOT read source code or trace implementation details.

### Complexity scoring
Score each task before planning:
- **Low** — single service, clear symptom, known pattern. Pipeline: `engineer → CodeReviewer → qa → devops`
- **High** — multi-service, unclear root cause, architectural implications, or 3+ files affected. Pipeline: `architect → qa (criteria) → engineer → CodeReviewer → qa (verify) → devops`

### Planning
1. Recall context: `memory_recall` (search relevant `custom:portal2*` scopes) + `search_memory_facts` (Graphiti).
2. Draft a decomposition plan as a comment on the issue. Use this format:
   ```
   ## Plan
   Complexity: [low|high]
   1. [subtask] → [agent] (sequential/parallel/blocked-by #N)
   2. [subtask] → [agent] (blocked-by #1)
   Strategy: [fan-out | pipeline | hybrid]. [one-line rationale]
   ```
   Example (high): `1. Investigate → architect / 2. Write acceptance criteria → qa (blocked-by #1) / 3. Implement → engineer (blocked-by #2) / 4. Review → CodeReviewer (blocked-by #3) / 5. Verify → qa (blocked-by #4)`
   Example (low): `1. Fix null check in buildFacts → engineer (sequential) / 2. Review → CodeReviewer (blocked-by #1)`
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

Pipeline (low): **Engineer** (implement) → **CodeReviewer** (review) → **QA** (verify) → **DevOps** (deploy).
Pipeline (high): **Architect** (investigate) → **QA** (write acceptance criteria) → **Engineer** (implement) → **CodeReviewer** (review) → **QA** (verify against criteria) → **DevOps** (deploy).

**High-complexity handoff flow:**
1. Create architect subtask with: symptom, affected area, what to investigate.
2. Architect finishes → @mentions you → read their structured findings (root cause, blast radius, implementation plan).
3. Create QA subtask titled "Write acceptance criteria for [issue]" with: architect's findings. QA writes BDD Given/When/Then criteria.
4. QA finishes → @mentions you → create engineer subtask with: architect's findings + QA's acceptance criteria.
5. Engineer finishes → @mentions you → create CodeReviewer subtask.
6. CodeReviewer finishes → @mentions you → create QA subtask titled "Verify [issue]" with: link to acceptance criteria + engineer's changes.
7. QA verifies against criteria → @mentions you → create DevOps subtask if deployment needed.

On rejection/failure at any step, create a new subtask back to the originating agent with feedback.

**Never reassign the same issue to a different agent.** Always create a new subtask — this avoids lock collisions and keeps a clean audit trail.

### Choosing Strategy
- **Parallel**: independent tasks (fix bug A + fix bug B)
- **Sequential**: output → input chain (implement → review → QA → deploy)
- **Hybrid**: fan out independent tasks, each follows sequential pipeline

### Agent Roster
Route by `capabilities`: **architect** (investigation, high-complexity only), **workflow** (Temporal workflow issues, state machines, async processing), **engineer** (code), **codereview** (review only), **qa** (test only), **devops** (deploy, needs prod approval).

### Workflow-Related Issues
When an issue involves Temporal workflows, state machines, stuck/failed workflows, activity retries, or async processing:
- **Low complexity**: assign to **workflow** agent instead of engineer for investigation + fix, then follow normal pipeline (CodeReviewer → qa → devops).
- **High complexity**: assign to **workflow** agent instead of architect for deep investigation, then follow high-complexity pipeline (qa criteria → engineer → CodeReviewer → qa verify → devops).
- Keywords that indicate workflow issues: "workflow", "temporal", "activity", "signal", "stuck", "retry", "state machine", "compensation", "saga".

## 8. Fact Extraction & Lessons Learned

### Operational facts (every heartbeat)
Store durable facts via `memory_store`. Pick the most specific scope based on content:
- `custom:portal2` — architecture, shared configs, cross-cutting concerns
- `custom:portal2-devops` — CI/CD, infrastructure, monitoring, alerting
- `custom:portal2-qa` — test strategies, test data, QA procedures
- `custom:portal2-workflow` — Temporal workflows, state machines, error handling

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

---

## Rules

- Always use the Paperclip skill for coordination. Include `X-Paperclip-Run-Id` header on mutating API calls.
- Only work on assigned tasks. Never look for unassigned work.
- Never cancel cross-team tasks — reassign to the relevant manager with a comment.
- Review deliverables from reports before marking work as done.
- Above 80% budget spend, focus only on critical tasks.
- Comment in concise markdown: status line + bullets + links.
