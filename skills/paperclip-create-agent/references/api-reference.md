# Paperclip Create Agent API Reference

## Core Endpoints

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`
- `GET /llms/agent-icons.txt`
- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/companies/:companyId/skills`
- `POST /api/companies/:companyId/skills/import`
- `GET /api/agents/:agentId/configuration`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`
- `GET /api/agents/:agentId/config-revisions`
- `POST /api/agents/:agentId/config-revisions/:revisionId/rollback`
- `POST /api/issues/:issueId/approvals`
- `GET /api/approvals/:approvalId/issues`

Approval collaboration:

- `GET /api/approvals/:approvalId`
- `POST /api/approvals/:approvalId/request-revision` (board)
- `POST /api/approvals/:approvalId/resubmit`
- `GET /api/approvals/:approvalId/comments`
- `POST /api/approvals/:approvalId/comments`
- `GET /api/approvals/:approvalId/issues`

## `POST /api/companies/:companyId/agent-hires`

Request body matches agent create shape:

```json
{
  "name": "CTO",
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "uuid-or-null",
  "capabilities": "Owns architecture and engineering execution",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-sonnet-4-5-20250929"
  },
  "instructionsBundle": {
    "entryFile": "AGENTS.md",
    "files": {
      "AGENTS.md": "You are CTO..."
    }
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true
    }
  },
  "budgetMonthlyCents": 0,
  "sourceIssueId": "uuid-or-null",
  "sourceIssueIds": ["uuid-1", "uuid-2"]
}
```

Response:

```json
{
  "agent": {
    "id": "uuid",
    "status": "pending_approval"
  },
  "approval": {
    "id": "uuid",
    "type": "hire_agent",
    "status": "pending",
    "payload": {
      "desiredSkills": ["vercel-labs/agent-browser/agent-browser"]
    }
  }
}
```

If company setting disables required approval, `approval` is `null` and the agent is created as `idle`.

`desiredSkills` accepts company skill ids, canonical keys, or a unique slug. The server resolves and stores canonical company skill keys.
Leave timer heartbeats disabled by default. Only set `runtimeConfig.heartbeat.enabled=true` and include an `intervalSec` when the role truly needs scheduled recurring work or the user explicitly requested it.

Do not include `adapterConfig.cwd` in new hire payloads. It is a deprecated legacy fallback for local adapters (`claude_local`, `codex_local`, `cursor_local`, `gemini_local`, `opencode_local`, `pi_local`, `acpx_local`); Paperclip leases an execution workspace per issue. The hire and direct-create endpoints drop this field for new agents (logged as `agent.hire_dropped_deprecated_field` / `agent.create_dropped_deprecated_field` for audit). Existing agents that still carry `cwd` are preserved by the PATCH path.

## Approval Lifecycle

Statuses:

- `pending`
- `revision_requested`
- `approved`
- `rejected`
- `cancelled`

For hire approvals:

- approved: linked agent transitions `pending_approval -> idle`
- rejected: linked agent is terminated

## Safety Notes

- Config read APIs redact obvious secrets.
- `pending_approval` agents cannot run heartbeats, receive assignments, or create keys.
- All actions are logged in activity for auditability.
- Use markdown in issue/approval comments and include links to approval, agent, and source issue.
- After approval resolution, requester may be woken with `PAPERCLIP_APPROVAL_ID` and should reconcile linked issues.
