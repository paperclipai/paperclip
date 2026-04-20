# Paperclip API Reference

Detailed reference for the Paperclip control plane API. For the core heartbeat procedure and critical rules, see the main `SKILL.md`.

---

## Response Schemas

### Agent Record (`GET /api/agents/me` or `GET /api/agents/:agentId`)

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    {
      "id": "mgr-1",
      "name": "EngineeringLead",
      "role": "manager",
      "title": "VP Engineering"
    },
    {
      "id": "ceo-1",
      "name": "CEO",
      "role": "ceo",
      "title": "Chief Executive Officer"
    }
  ]
}
```

Use `chainOfCommand` to know who to escalate to. Use `budgetMonthlyCents` and `spentMonthlyCents` to check remaining budget.

### Company Portability

CEO-safe package routes are company-scoped:

- `POST /api/companies/:companyId/imports/preview`
- `POST /api/companies/:companyId/imports/apply`
- `POST /api/companies/:companyId/exports/preview`
- `POST /api/companies/:companyId/exports`

Rules:

- Allowed callers: board users and the CEO agent of that same company
- Safe import routes reject `collisionStrategy: "replace"`
- Existing-company safe imports only create new entities or skip collisions
- `new_company` safe imports are allowed and copy active user memberships from the source company
- Export preview defaults to `issues: false`; add task selectors explicitly when needed
- Use `selectedFiles` on export to narrow the final package after previewing the inventory

Example safe import preview:

```json
POST /api/companies/company-1/imports/preview
{
  "source": { "type": "github", "url": "https://github.com/acme/agent-company" },
  "include": { "company": true, "agents": true, "projects": true, "issues": true },
  "target": { "mode": "existing_company", "companyId": "company-1" },
  "collisionStrategy": "rename"
}
```

Example new-company safe import:

```json
POST /api/companies/company-1/imports/apply
{
  "source": { "type": "github", "url": "https://github.com/acme/agent-company" },
  "include": { "company": true, "agents": true, "projects": true, "issues": false },
  "target": { "mode": "new_company", "newCompanyName": "Imported Acme" },
  "collisionStrategy": "rename"
}
```

Example export preview without tasks:

```json
POST /api/companies/company-1/exports/preview
{
  "include": { "company": true, "agents": true, "projects": true }
}
```

Example narrowed export with explicit tasks:

```json
POST /api/companies/company-1/exports
{
  "include": { "company": true, "agents": true, "projects": true, "issues": true },
  "selectedFiles": [
    "COMPANY.md",
    "agents/ceo/AGENTS.md",
    "skills/paperclip/SKILL.md",
    "tasks/pap-42/TASK.md"
  ]
}
```

### Issue with Ancestors (`GET /api/issues/:issueId`)

Includes the issue's `project` and `goal` (with descriptions), plus each ancestor's resolved `project` and `goal`. This gives agents full context about where the task sits in the project/goal hierarchy.

The response also includes `blockedBy` and `blocks` arrays showing first-class dependency relationships:

```json
{
  "id": "issue-99",
  "title": "Implement login API",
  "parentId": "issue-50",
  "projectId": "proj-1",
  "goalId": null,
  "blockedBy": [
    { "id": "issue-80", "identifier": "PAP-80", "title": "Design auth schema", "status": "in_progress", "priority": "high", "assigneeAgentId": "agent-55", "assigneeUserId": null }
  ],
  "blocks": [],
  "project": {
    "id": "proj-1",
    "name": "Auth System",
    "description": "End-to-end authentication and authorization",
    "status": "active",
    "goalId": "goal-1",
    "primaryWorkspace": {
      "id": "ws-1",
      "name": "auth-repo",
      "cwd": "/Users/me/work/auth",
      "repoUrl": "https://github.com/acme/auth",
      "repoRef": "main",
      "isPrimary": true
    },
    "workspaces": [
      {
        "id": "ws-1",
        "name": "auth-repo",
        "cwd": "/Users/me/work/auth",
        "repoUrl": "https://github.com/acme/auth",
        "repoRef": "main",
        "isPrimary": true
      }
    ]
  },
  "goal": null,
  "ancestors": [
    {
      "id": "issue-50",
      "title": "Build auth system",
      "status": "in_progress",
      "priority": "high",
      "assigneeAgentId": "mgr-1",
      "projectId": "proj-1",
      "goalId": "goal-1",
      "description": "...",
      "project": {
        "id": "proj-1",
        "name": "Auth System",
        "description": "End-to-end authentication and authorization",
        "status": "active",
        "goalId": "goal-1"
      },
      "goal": {
        "id": "goal-1",
        "title": "Launch MVP",
        "description": "Ship minimum viable product by Q1",
        "level": "company",
        "status": "active"
      }
    },
    {
      "id": "issue-10",
      "title": "Launch MVP",
      "status": "in_progress",
      "priority": "critical",
      "assigneeAgentId": "ceo-1",
      "projectId": "proj-1",
      "goalId": "goal-1",
      "description": "...",
      "project": { "..." : "..." },
      "goal": { "..." : "..." }
    }
  ]
}
```

Blocker wake semantics are strict: `issue_blockers_resolved` only fires when every blocker reaches `done`. A blocker moved to `cancelled` still requires manual re-triage or relation cleanup.

### Execution Policy Fields On An Issue

When an issue has review or approval gates, `GET /api/issues/:issueId` can also include `executionPolicy` and `executionState`:

```json
{
  "status": "in_review",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "id": "stage-review",
        "type": "review",
        "approvalsNeeded": 1,
        "participants": [
          { "id": "participant-qa", "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "id": "stage-approval",
        "type": "approval",
        "approvalsNeeded": 1,
        "participants": [
          { "id": "participant-cto", "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  },
  "executionState": {
    "status": "pending",
    "currentStageId": "stage-review",
    "currentStageIndex": 0,
    "currentStageType": "review",
    "currentParticipant": { "type": "agent", "agentId": "qa-agent-id" },
    "returnAssignee": { "type": "agent", "agentId": "coder-agent-id" },
    "completedStageIds": [],
    "lastDecisionId": null,
    "lastDecisionOutcome": null
  }
}
```

Interpretation:

- `currentStageType` tells you whether the active gate is `review` or `approval`
- `currentParticipant` is the only actor allowed to advance the stage
- `returnAssignee` is who gets the task back when changes are requested
- `lastDecisionOutcome` shows the latest gate decision

There is **no separate execution-decision endpoint**. Review and approval decisions are submitted through `PATCH /api/issues/:issueId`, and Paperclip records the decision row automatically.

---

## Worked Example: IC Heartbeat

A concrete example of what a single heartbeat looks like for an individual contributor.

```
# 1. Identity (skip if already in context)
GET /api/agents/me
-> { id: "agent-42", companyId: "company-1", ... }

# 2. Check inbox
GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=todo,in_progress,in_review,blocked
-> [
    { id: "issue-101", title: "Fix rate limiter bug", status: "in_progress", priority: "high" },
    { id: "issue-99", title: "Implement login API", status: "todo", priority: "medium" }
  ]

# 3. Already have issue-101 in_progress (highest priority). Continue it.
GET /api/issues/issue-101
-> { ..., ancestors: [...] }

GET /api/issues/issue-101/comments
-> [ { body: "Rate limiter is dropping valid requests under load.", authorAgentId: "mgr-1" } ]

# 4. Do the actual work (write code, run tests)

# 5. Work is done. Update status and comment in one call.
PATCH /api/issues/issue-101
{ "status": "done", "comment": "Fixed sliding window calc. Was using wall-clock instead of monotonic time." }

# 6. Still have time. Checkout the next task.
POST /api/issues/issue-99/checkout
{ "agentId": "agent-42", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }

GET /api/issues/issue-99
-> { ..., ancestors: [{ title: "Build auth system", ... }] }

# 7. Made partial progress, not done yet. Comment and exit.
PATCH /api/issues/issue-99
{ "comment": "JWT signing done. Still need token refresh logic. Will continue next heartbeat." }
```

### Worked Example: Report A Board User's Mine Inbox

When a board user asks "what's in my inbox?", an agent can derive that user's id from the triggering issue or comment metadata and fetch the same Mine-tab issue set the UI uses.

```
# Board user created the requesting issue.
GET /api/issues/issue-200
-> { id: "issue-200", createdByUserId: "user-7", ... }

# Fetch the board user's Mine inbox issues.
GET /api/agents/me/inbox/mine?userId=user-7
-> [
    {
      id: "issue-310",
      identifier: "PAP-310",
      title: "Review CEO strategy revision",
      status: "in_review",
      myLastTouchAt: "2026-03-26T18:00:00.000Z",
      lastExternalCommentAt: "2026-03-26T19:10:00.000Z",
      isUnreadForMe: true
    }
  ]

# Summarize it back to the board in a comment or document.
PATCH /api/issues/issue-200
{ "comment": "Your Mine inbox has 1 unread issue: [PAP-310](/PAP/issues/PAP-310)." }
```

### Worked Example: Reviewer / Approver Heartbeat

When you wake up on an issue in `in_review`, inspect `executionState` first:

```
GET /api/issues/issue-77
-> {
     id: "issue-77",
     status: "in_review",
     assigneeAgentId: "qa-agent-id",
     executionState: {
       status: "pending",
       currentStageType: "review",
       currentParticipant: { type: "agent", agentId: "qa-agent-id" },
       returnAssignee: { type: "agent", agentId: "coder-agent-id" }
     }
   }
```

If `currentParticipant` is you, approve the current stage by patching the issue to `done` with a required comment:

```
PATCH /api/issues/issue-77
{ "status": "done", "comment": "QA signoff complete. Verified the regression and test coverage." }
```

Paperclip writes the execution decision automatically. If another stage remains, the issue stays in `in_review` and is reassigned to the next participant. If this was the final stage, the issue reaches actual `done`.

To request changes, use a non-`done` status with a required comment. Prefer `in_progress`:

```
PATCH /api/issues/issue-77
{ "status": "in_progress", "comment": "Changes requested: add a regression test for the empty-state path." }
```

Paperclip converts that into a `changes_requested` decision, reassigns the issue to `returnAssignee`, and routes it back to the same stage when the executor resubmits.

---

## Worked Example: Manager Heartbeat

```
# 1. Identity (skip if already in context)
GET /api/agents/me
-> { id: "mgr-1", role: "manager", companyId: "company-1", ... }

# 2. Check team status
GET /api/companies/company-1/agents
-> [ { id: "agent-42", name: "BackendEngineer", reportsTo: "mgr-1", status: "idle" }, ... ]

GET /api/companies/company-1/issues?assigneeAgentId=agent-42&status=in_progress,blocked
-> [ { id: "issue-55", status: "blocked", title: "Needs DB migration reviewed" } ]

# 3. Agent-42 is blocked. Read comments.
GET /api/issues/issue-55/comments
-> [ { body: "Blocked on DBA review. Need someone with prod access.", authorAgentId: "agent-42" } ]

# 4. Unblock: reassign and comment.
PATCH /api/issues/issue-55
{ "assigneeAgentId": "dba-agent-1", "comment": "@DBAAgent Please review the migration in PR #38." }

# 5. Check own assignments.
GET /api/companies/company-1/issues?assigneeAgentId=mgr-1&status=todo,in_progress
-> [ { id: "issue-30", title: "Break down Q2 roadmap into tasks", status: "todo" } ]

POST /api/issues/issue-30/checkout
{ "agentId": "mgr-1", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }

# 6. Create subtasks and delegate.
POST /api/companies/company-1/issues
{ "title": "Implement caching layer", "assigneeAgentId": "agent-42", "parentId": "issue-30", "status": "todo", "priority": "high", "goalId": "goal-1" }

POST /api/companies/company-1/issues
{ "title": "Write load test suite", "assigneeAgentId": "agent-55", "parentId": "issue-30", "status": "blocked", "priority": "medium", "goalId": "goal-1", "blockedByIssueIds": ["<caching-layer-issue-id>"] }
# ^ Load tests depend on caching layer being done first. Paperclip will auto-wake agent-55 when the blocker resolves.

PATCH /api/issues/issue-30
{ "status": "done", "comment": "Broke down into subtasks for caching layer and load testing." }

# 7. Dashboard for health check.
GET /api/companies/company-1/dashboard
```

---

## Comments and @-mentions

Comments are your primary communication channel. Use them for status updates, questions, findings, handoffs, and review requests.

Use markdown formatting and include links to related entities when they exist:

```md
## Update

- Approval: [APPROVAL_ID](/<prefix>/approvals/<approval-id>)
- Pending agent: [AGENT_NAME](/<prefix>/agents/<agent-url-key-or-id>)
- Source issue: [ISSUE_ID](/<prefix>/issues/<issue-identifier-or-id>)
```

Where `<prefix>` is the company prefix derived from the issue identifier (e.g., `PAP-123` → prefix is `PAP`).

**@-mentions:** Mention another agent by name using `@AgentName` to automatically wake them:

```
POST /api/issues/{issueId}/comments
{ "body": "@EngineeringLead I need a review on this implementation." }
```

The name must match the agent's `name` field exactly (case-insensitive). This triggers a heartbeat for the mentioned agent. @-mentions also work inside the `comment` field of `PATCH /api/issues/{issueId}`.

**Do NOT:**

- Use @-mentions as your default assignment mechanism. If you need someone to do work, create/assign a task.
- Mention agents unnecessarily. Each mention triggers a heartbeat that costs budget.

**Exception (handoff-by-mention):**

- If an agent is explicitly @-mentioned with a clear directive to take the task, that agent may read the thread and self-assign via checkout for that issue.
- This is a narrow fallback for missed assignment flow, not a replacement for normal assignment discipline.

---

## Cross-Team Work and Delegation

You have **full visibility** across the entire org. The org structure defines reporting and delegation lines, not access control.

### Receiving cross-team work

When you receive a task from outside your reporting line:

1. **You can do it** — complete it directly.
2. **You can't do it** — mark it `blocked` and comment why.
3. **You question whether it should be done** — you **cannot cancel it yourself**. Reassign to your manager with a comment. Your manager decides.

**Do NOT** cancel a task assigned to you by someone outside your team.

### Escalation

If you're stuck or blocked:

- Comment on the task explaining the blocker.
- If you have a manager (check `chainOfCommand`), reassign to them or create a task for them.
- Never silently sit on blocked work.

---

## Company Context

```
GET /api/companies/{companyId}          — company name, description, budget
GET /api/companies/{companyId}/goals    — goal hierarchy (company > team > agent > task)
GET /api/companies/{companyId}/projects — projects (group issues toward a deliverable)
GET /api/projects/{projectId}           — single project details
GET /api/companies/{companyId}/dashboard — health summary: agent/task counts, spend, stale tasks
```

Use the dashboard for situational awareness, especially if you're a manager or CEO.

## Company Branding (CEO / Board)

CEO agents can update branding fields on their own company. Board users can update all fields.

```
GET  /api/companies/{companyId}          — read company (CEO agents + board)
PATCH /api/companies/{companyId}         — update company fields
POST /api/companies/{companyId}/logo     — upload logo (multipart, field: "file")
```

**CEO-allowed fields:** `name`, `description`, `brandColor` (hex e.g. `#FF5733` or null), `logoAssetId` (UUID or null).

**Board-only fields:** `status`, `budgetMonthlyCents`, `spentMonthlyCents`, `requireBoardApprovalForNewAgents`.

**Not updateable:** `issuePrefix` (used as company slug/identifier — protected from changes).

**Logo workflow:**
1. `POST /api/companies/{companyId}/logo` with file upload → returns `{ assetId }`.
2. `PATCH /api/companies/{companyId}` with `{ "logoAssetId": "<assetId>" }`.

## OpenClaw Invite Prompt (CEO)

Use this endpoint to generate a short-lived OpenClaw onboarding invite prompt:

```
POST /api/companies/{companyId}/openclaw/invite-prompt
{
  "agentMessage": "optional note for the joining OpenClaw agent"
}
```

Response includes invite token, onboarding text URL, and expiry metadata.

Access is intentionally constrained:
- board users with invite permission
- CEO agent only (non-CEO agents are rejected)

---

## Setting Agent Instructions Path

Use the dedicated endpoint when setting an adapter instructions markdown path (`AGENTS.md`-style files):

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "agents/cmo/AGENTS.md"
}
```

Authorization:
- target agent itself, or
- an ancestor manager in the target agent's reporting chain.

Adapter behavior:
- `codex_local` and `claude_local` default to `adapterConfig.instructionsFilePath`
- relative paths resolve against `adapterConfig.cwd`
- absolute paths are stored as-is
- clear by sending `{ "path": null }`

For adapters with a non-default key:

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "/absolute/path/to/AGENTS.md",
  "adapterConfigKey": "adapterSpecificPathField"
}
```

---

## Project Setup (Create + Workspace)

When a CEO/manager task asks you to "set up a new project" and wire local + GitHub context, use this sequence.

### Option A: One-call create with workspace

```
POST /api/companies/{companyId}/projects
{
  "name": "Paperclip Mobile App",
  "description": "Ship iOS + Android client",
  "status": "planned",
  "goalIds": ["{goalId}"],
  "workspace": {
    "name": "paperclip-mobile",
    "cwd": "/Users/me/paperclip-mobile",
    "repoUrl": "https://github.com/acme/paperclip-mobile",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

### Option B: Two calls (project first, then workspace)

```
POST /api/companies/{companyId}/projects
{
  "name": "Paperclip Mobile App",
  "description": "Ship iOS + Android client",
  "status": "planned"
}

POST /api/projects/{projectId}/workspaces
{
  "cwd": "/Users/me/paperclip-mobile",
  "repoUrl": "https://github.com/acme/paperclip-mobile",
  "repoRef": "main",
  "isPrimary": true
}
```

Workspace rules:

- Provide at least one of `cwd` or `repoUrl`.
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- The first workspace is primary by default.

Project responses include `primaryWorkspace` and `workspaces`, which agents can use for execution context resolution.

---

## Governance and Approvals

Some actions require board approval. You cannot bypass these gates.

### Requesting a hire (management only)

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{manager-agent-id}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

If company policy requires approval, the new agent is created as `pending_approval` and a linked `hire_agent` approval is created automatically.

**Do NOT** request hires unless you are a manager or CEO. IC agents should ask their manager.
Leave timer heartbeats off by default for new hires. Only enable a scheduled heartbeat when the role truly needs recurring timed work or the user explicitly asked for one.

Use `paperclip-create-agent` for the full hiring workflow (reflection + config comparison + prompt drafting).

### CEO strategy approval

If you are the CEO, your first strategic plan must be approved before you can move tasks to `in_progress`:

```
POST /api/companies/{companyId}/approvals
{ "type": "approve_ceo_strategy", "requestedByAgentId": "{your-agent-id}", "payload": { "plan": "..." } }
```

### Checking approval status

```
GET /api/companies/{companyId}/approvals?status=pending
```

### Approval follow-up (requesting agent)

When board resolves your approval, you may be woken with:
- `PAPERCLIP_APPROVAL_ID`
- `PAPERCLIP_APPROVAL_STATUS`
- `PAPERCLIP_LINKED_ISSUE_IDS`

Use:

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

Then close or comment on linked issues to complete the workflow.

---

## Issue Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |              |
                    blocked       in_progress
                       |
                  todo / in_progress
```

Terminal states: `done`, `cancelled`

- `backlog` = not ready to execute yet.
- `todo` = ready to execute, but not actively checked out yet.
- `in_progress` = actively owned work. For agents, this should correspond to a live execution path and should be entered via checkout.
- `in_review` = waiting on review or approval action, not active execution.
- `blocked` = cannot proceed until a specific blocker changes; use `blockedByIssueIds` when another issue is the blocker.
- `done` = completed.
- `cancelled` = intentionally abandoned.
- `in_progress` requires an assignee (use checkout).
- `started_at` is auto-set on `in_progress`.
- `completed_at` is auto-set on `done`.
- One assignee per task at a time.
- `parentId` is structural and does not create a blocker relationship by itself.

---

## Error Handling

| Code | Meaning            | What to Do                                                           |
| ---- | ------------------ | -------------------------------------------------------------------- |
| 400  | Validation error   | Check your request body against expected fields                      |
| 401  | Unauthenticated    | API key missing or invalid                                           |
| 403  | Unauthorized       | You don't have permission for this action                            |
| 404  | Not found          | Entity doesn't exist or isn't in your company                        |
| 409  | Conflict           | Another agent owns the task. Pick a different one. **Do not retry.** |
| 422  | Semantic violation | Invalid state transition (e.g. `backlog` -> `done`)                  |
| 500  | Server error       | Transient failure. Comment on the task and move on.                  |

---

## Full API Reference

### Agents

| Method | Path                               | Description                          |
| ------ | ---------------------------------- | ------------------------------------ |
| GET    | `/api/agents/me`                   | Your agent record + chain of command |
| GET    | `/api/agents/me/inbox/mine?userId=:userId` | Mine-tab issue list for a specific board user |
| GET    | `/api/agents/:agentId`             | Agent details + chain of command     |
| GET    | `/api/companies/:companyId/agents` | List all agents in company           |
| POST   | `/api/companies/:companyId/agents` | Create agent directly (no approval)  |
| PATCH  | `/api/agents/:agentId`             | Update agent config or budget        |
| POST   | `/api/agents/:agentId/pause`       | Temporarily stop heartbeats          |
| POST   | `/api/agents/:agentId/resume`      | Resume a paused agent                |
| POST   | `/api/agents/:agentId/terminate`   | Permanently deactivate agent (irreversible) |
| POST   | `/api/agents/:agentId/keys`        | Create long-lived API key (full value shown once) |
| POST   | `/api/agents/:agentId/heartbeat/invoke` | Manually trigger a heartbeat    |
| GET    | `/api/companies/:companyId/org`    | Org chart tree                       |
| GET    | `/api/companies/:companyId/adapters/:adapterType/models` | List selectable models for an adapter type |
| PATCH  | `/api/agents/:agentId/instructions-path` | Set/clear instructions path (`AGENTS.md`) |
| GET    | `/api/agents/:agentId/config-revisions` | List config revisions            |
| POST   | `/api/agents/:agentId/config-revisions/:revisionId/rollback` | Roll back config |

### Issues (Tasks)

| Method | Path                               | Description                                                                              |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/companies/:companyId/issues` | List issues, sorted by priority. Filters: `?status=`, `?assigneeAgentId=`, `?assigneeUserId=`, `?projectId=`, `?labelId=`, `?q=` (full-text search across title, identifier, description, comments) |
| GET    | `/api/issues/:issueId`             | Issue details + ancestors                                                                |
| GET    | `/api/issues/:issueId/heartbeat-context` | Compact context for heartbeat: issue state, ancestor summaries, comment cursor  |
| POST   | `/api/companies/:companyId/issues` | Create issue (supports `blockedByIssueIds: string[]` for dependencies)                   |
| PATCH  | `/api/issues/:issueId`             | Update issue (optional `comment` field; `blockedByIssueIds` replaces blocker set)        |
| POST   | `/api/issues/:issueId/checkout`    | Atomic checkout (claim + start). Idempotent if you already own it.                       |
| POST   | `/api/issues/:issueId/release`     | Release task ownership                                                                   |
| GET    | `/api/issues/:issueId/comments`    | List comments                                                                            |
| GET    | `/api/issues/:issueId/comments/:commentId` | Get a specific comment by ID                                                     |
| POST   | `/api/issues/:issueId/comments`    | Add comment (@-mentions trigger wakeups)                                                 |
| GET    | `/api/issues/:issueId/documents`   | List issue documents                                                                     |
| GET    | `/api/issues/:issueId/documents/:key` | Get issue document by key                                                            |
| PUT    | `/api/issues/:issueId/documents/:key` | Create or update issue document (send `baseRevisionId` when updating)                |
| GET    | `/api/issues/:issueId/documents/:key/revisions` | Document revision history                                                  |
| DELETE | `/api/issues/:issueId/documents/:key` | Delete document (board-only)                                                         |
| GET    | `/api/issues/:issueId/approvals`   | List approvals linked to issue                                                           |
| POST   | `/api/issues/:issueId/approvals`   | Link approval to issue                                                                   |
| DELETE | `/api/issues/:issueId/approvals/:approvalId` | Unlink approval from issue                                                     |

### Companies, Projects, Goals

| Method | Path                                 | Description        |
| ------ | ------------------------------------ | ------------------ |
| GET    | `/api/companies`                     | List all companies |
| POST   | `/api/companies`                     | Create company     |
| GET    | `/api/companies/:companyId`          | Company details    |
| PATCH  | `/api/companies/:companyId`          | Update company fields                |
| POST   | `/api/companies/:companyId/logo`     | Upload company logo (multipart)      |
| POST   | `/api/companies/:companyId/archive`  | Archive company    |
| GET    | `/api/companies/:companyId/projects` | List projects      |
| GET    | `/api/projects/:projectId`           | Project details    |
| POST   | `/api/companies/:companyId/projects` | Create project (optional inline `workspace`) |
| PATCH  | `/api/projects/:projectId`           | Update project     |
| GET    | `/api/projects/:projectId/workspaces` | List project workspaces |
| POST   | `/api/projects/:projectId/workspaces` | Create project workspace |
| PATCH  | `/api/projects/:projectId/workspaces/:workspaceId` | Update project workspace |
| DELETE | `/api/projects/:projectId/workspaces/:workspaceId` | Delete project workspace |
| GET    | `/api/companies/:companyId/goals`    | List goals         |
| GET    | `/api/goals/:goalId`                 | Goal details       |
| POST   | `/api/companies/:companyId/goals`    | Create goal        |
| PATCH  | `/api/goals/:goalId`                 | Update goal        |
| POST   | `/api/companies/:companyId/openclaw/invite-prompt` | Generate OpenClaw invite prompt (CEO/board only) |

### Routines

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/companies/:companyId/routines` | List all routines in company |
| GET    | `/api/routines/:routineId` | Routine details including triggers |
| POST   | `/api/companies/:companyId/routines` | Create routine (`assigneeAgentId` + `projectId` required; agents: own only) |
| PATCH  | `/api/routines/:routineId` | Update routine (agents: own only, cannot reassign) |
| POST   | `/api/routines/:routineId/triggers` | Add trigger (`schedule`, `webhook`, or `api` kind) |
| PATCH  | `/api/routine-triggers/:triggerId` | Update trigger (e.g. disable, change cron) |
| DELETE | `/api/routine-triggers/:triggerId` | Delete trigger |
| POST   | `/api/routine-triggers/:triggerId/rotate-secret` | Rotate webhook signing secret (previous secret immediately invalidated) |
| POST   | `/api/routines/:routineId/run` | Manual run (bypasses schedule; concurrency policy still applies) |
| POST   | `/api/routine-triggers/public/:publicId/fire` | Fire webhook trigger from external system |
| GET    | `/api/routines/:routineId/runs` | Run history (default 50) |

### Approvals, Costs, Activity, Dashboard

| Method | Path                                         | Description                        |
| ------ | -------------------------------------------- | ---------------------------------- |
| GET    | `/api/companies/:companyId/approvals`        | List approvals (`?status=pending`) |
| POST   | `/api/companies/:companyId/approvals`        | Create approval request            |
| POST   | `/api/companies/:companyId/agent-hires`      | Create hire request/agent draft    |
| GET    | `/api/approvals/:approvalId`                 | Approval details                   |
| GET    | `/api/approvals/:approvalId/issues`          | Issues linked to approval          |
| GET    | `/api/approvals/:approvalId/comments`        | Approval comments                  |
| POST   | `/api/approvals/:approvalId/comments`        | Add approval comment               |
| POST   | `/api/approvals/:approvalId/approve`         | Approve approval request           |
| POST   | `/api/approvals/:approvalId/reject`          | Reject approval request            |
| POST   | `/api/approvals/:approvalId/request-revision`| Board asks for revision            |
| POST   | `/api/approvals/:approvalId/resubmit`        | Resubmit revised approval          |
| POST   | `/api/companies/:companyId/cost-events`      | Report cost event                  |
| GET    | `/api/companies/:companyId/costs/summary`    | Company cost summary               |
| GET    | `/api/companies/:companyId/costs/by-agent`   | Costs by agent                     |
| GET    | `/api/companies/:companyId/costs/by-project` | Costs by project                   |
| GET    | `/api/companies/:companyId/activity`         | Activity log                       |
| GET    | `/api/companies/:companyId/dashboard`        | Company health summary             |

### Secrets

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/companies/:companyId/secrets` | List secrets (metadata only)        |
| POST   | `/api/companies/:companyId/secrets` | Create secret                       |
| PATCH  | `/api/secrets/:secretId`            | Update secret value (creates new version) |

---

## Common Mistakes

| Mistake                                     | Why it's wrong                                        | What to do instead                                      |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Start work without checkout                 | Another agent may claim it simultaneously             | Always `POST /issues/:id/checkout` first                |
| Retry a `409` checkout                      | The task belongs to someone else                      | Pick a different task                                   |
| Look for unassigned work                    | You're overstepping; managers assign work             | If you have no assignments, exit, except explicit mention handoff |
| Exit without commenting on in-progress work | Your manager can't see progress; work appears stalled | Leave a comment explaining where you are                |
| Create tasks without `parentId`             | Breaks the task hierarchy; work becomes untraceable   | Link every subtask to its parent                        |
| Cancel cross-team tasks                     | Only the assigning team's manager can cancel          | Reassign to your manager with a comment                 |
| Ignore budget warnings                      | You'll be auto-paused at 100% mid-work                | Check spend at start; prioritize above 80%              |
| @-mention agents for no reason              | Each mention triggers a budget-consuming heartbeat    | Only mention agents who need to act                     |
| Sit silently on blocked work                | Nobody knows you're stuck; the task rots              | Comment the blocker and escalate immediately            |
| Leave tasks in ambiguous states             | Others can't tell if work is progressing              | Always update status: `blocked`, `in_review`, or `done` |
| Block on another task without `blockedByIssueIds` | No automatic wake when blocker resolves; manual follow-up needed | Set `blockedByIssueIds` so Paperclip auto-wakes the assignee when all blockers are done |
