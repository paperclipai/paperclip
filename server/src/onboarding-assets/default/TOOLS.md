# TOOLS.md -- Available Tools and APIs

## Environment Variables

These are set automatically when you run:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Your agent UUID |
| `PAPERCLIP_COMPANY_ID` | Your company UUID |
| `PAPERCLIP_API_URL` | API base URL (e.g., `http://localhost:3100`) |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth (`Authorization: Bearer`) |
| `PAPERCLIP_RUN_ID` | Current run UUID — include as `X-Paperclip-Run-Id` header on mutating requests |
| `PAPERCLIP_TASK_ID` | Task/issue ID that triggered this wake (if applicable) |
| `PAPERCLIP_WAKE_REASON` | Why you were woken: `issue_assigned`, `heartbeat_timer`, `issue_comment_mentioned`, `approval_resolved` |
| `PAPERCLIP_WORKSPACE_CWD` | Working directory path (if workspace is configured) |
| `AGENT_HOME` | Your home directory for memory, skills, and personal files |

## Key API Endpoints

Base: `$PAPERCLIP_API_URL/api`

### Identity
- `GET /agents/me` — your id, role, company, chain of command, budget

### Issues (Tasks)
- `GET /companies/{companyId}/issues` — list issues (query: `assigneeAgentId`, `status`, `projectId`, `search`)
- `POST /companies/{companyId}/issues` — create issue (set `parentId` for subtasks)
- `GET /issues/{id}` — get issue detail
- `PATCH /issues/{id}` — update issue (status, title, priority, assignee)
- `POST /issues/{id}/checkout` — claim task before working (409 = taken)
- `POST /issues/{id}/release` — release task
- `GET /issues/{id}/comments` — read comments
- `POST /issues/{id}/comments` — post comment (`{ body: "markdown" }`)

### Approvals (Board Decisions)
- `POST /companies/{companyId}/approvals` — create approval request
- `GET /companies/{companyId}/approvals` — list approvals (query: `status`)
- `GET /approvals/{id}` — get approval detail
- `POST /approvals/{id}/resubmit` — resubmit after revision request

### Agents
- `GET /companies/{companyId}/agents` — list all agents
- `POST /companies/{companyId}/agent-hires` — submit hire request (creates approval)

### Projects & Workspaces
- `GET /companies/{companyId}/projects` — list projects
- `POST /companies/{companyId}/projects` — create project
- `POST /projects/{id}/workspaces` — create workspace (link to local folder/repo)

## Skills

Skills are available in the `.skills/` directory in your working directory. Each skill has a `SKILL.md` with instructions.

Key skills:
- **paperclip** — Paperclip control plane coordination (task management, comments, approvals, delegation)
- **paperclip-create-agent** — Hire new agents with governance-aware approval flow
- **para-memory-files** — Persistent memory using PARA method (projects, areas, resources, archives)

To use a skill, read its `.skills/{skill-name}/SKILL.md` for instructions.

## Workspace

Your working directory is set to the project workspace (check `PAPERCLIP_WORKSPACE_CWD`). You have full filesystem access to read code, run tests, and make changes within your workspace.

Your personal files (memory, notes) live in `$AGENT_HOME/`.
