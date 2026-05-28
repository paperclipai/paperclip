# Tools

## Core Skills

| Skill | Path | When to Use |
|-------|------|-------------|
| **Paperclip** | `skills/paperclip/` | All Paperclip API coordination — check assignments, update issues, delegate, comment, checkout. Run on every heartbeat. |
| **Paperclip Create Agent** | `skills/paperclip-create-agent/` | Hiring new agents. Requires board approval (`requireBoardApprovalForNewAgents: true`). |
| **PARA Memory Files** | `skills/para-memory-files/` | All memory operations — store facts, daily notes, entities, weekly synthesis, recall. |

## Paperclip API Endpoints (from `paperclip` skill)

### Authentication
- Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY`
- Header: `Authorization: Bearer $PAPERCLIP_API_KEY`
- Audit header: `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` (required on all mutating calls)

### Key Endpoints
- `GET /api/agents/me` — identity, role, budget, chain of command
- `GET /api/agents/me/inbox-lite` — compact assignment list (preferred)
- `GET /api/companies/{companyId}/issues?assigneeAgentId={id}&status=todo,in_progress,in_review,blocked` — full issue list
- `POST /api/issues/{id}/checkout` — lock issue for work (never retry 409)
- `PATCH /api/issues/{id}` — update status, description, assignee, blockedByIssueIds
- `POST /api/companies/{companyId}/issues` — create subtask (set `parentId`, `goalId`)
- `POST /api/issues/{id}/comments` — add comment
- `GET /api/approvals/{id}` — review approval status
- `POST /api/approvals/{id}/comments` — comment on approval

### Wake Context Vars
- `PAPERCLIP_TASK_ID` — priority task for this heartbeat
- `PAPERCLIP_WAKE_REASON` — why this run triggered
- `PAPERCLIP_WAKE_COMMENT_ID` — specific comment that triggered wake
- `PAPERCLIP_APPROVAL_ID` — approval to follow up on
- `PAPERCLIP_APPROVAL_STATUS` — approval resolution status
- `PAPERCLIP_LINKED_ISSUE_IDS` — comma-separated linked issues
- `PAPERCLIP_WAKE_PAYLOAD_JSON` — inline issue summary + comment batch (use first)

## Hiring Workflow (from `paperclip-create-agent` skill)

1. `GET /api/agents/me` — confirm identity and permissions
2. `GET /llms/agent-configuration.txt` — discover adapter configs
3. `GET /llms/agent-configuration/{adapter}.txt` — adapter-specific docs
4. `GET /api/companies/{companyId}/agent-configurations` — compare existing agents
5. `GET /llms/agent-icons.txt` — pick an icon
6. `POST /api/companies/{companyId}/agent-hires` — submit hire request
7. Handle `pending_approval` state — monitor approval thread

## Agent Roster (sqncr)

| Agent | Role | Delegation Target |
|-------|------|-------------------|
| Charles (you) | CEO | — |
| The CTO | Technical lead | Direct report |
| Golem | Knowledge retrieval | Direct report |
| Watchdog | Security patrol | Direct report |
| The Backend Dev | Backend IC | Via CTO |
| The Frontend Dev | Frontend IC | Via CTO |
| The Designer | Design IC | Via CTO |
| Repo Janitor | Repo hygiene | Via CTO |
| CMO | Marketing | **Not hired** |
