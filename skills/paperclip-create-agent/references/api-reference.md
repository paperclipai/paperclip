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
- `GET /api/agents/:agentId/instructions-bundle` — post-hire verification (Step 10)
- `PUT /api/agents/:agentId/instructions-bundle/file` — fallback upload when GET returns an empty bundle

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
    "cwd": "/absolute/path",
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

## Post-Hire Bundle Verification

Required after every hire (immediate-active or post-approval) and before marking any hire/source issue `done`. See SKILL.md Step 10.

### `GET /api/agents/:agentId/instructions-bundle`

Returns the persisted bundle state. Required assertions:

- `files.length >= 1`
- `resolvedEntryPath` is non-null (a string filesystem path)
- `entryFile` matches what was sent on hire
- every file from the original `instructionsBundle.files` appears in `files[].path`

Response shape (abridged):

```json
{
  "agentId": "uuid",
  "companyId": "uuid",
  "mode": "managed",
  "rootPath": "/.../agents/<id>/instructions",
  "managedRootPath": "/.../agents/<id>/instructions",
  "entryFile": "AGENTS.md",
  "resolvedEntryPath": "/.../agents/<id>/instructions/AGENTS.md",
  "editable": true,
  "warnings": [],
  "legacyPromptTemplateActive": false,
  "legacyBootstrapPromptTemplateActive": false,
  "files": [
    {
      "path": "AGENTS.md",
      "size": 7015,
      "language": "markdown",
      "markdown": true,
      "isEntryFile": true,
      "editable": true,
      "deprecated": false,
      "virtual": false
    }
  ]
}
```

### `PUT /api/agents/:agentId/instructions-bundle/file`

Fallback upload when the bundle is empty or missing files after hire. The path goes in the **request body**, not the query string.

Request body:

```json
{
  "path": "AGENTS.md",
  "content": "<full file body>",
  "clearLegacyPromptTemplate": true
}
```

Notes:

- `path` is required (trimmed, min length 1)
- `content` is required (string; pass the full file body)
- `clearLegacyPromptTemplate` is optional and defaults to `false` — set to `true` when you want to scrub any legacy `promptTemplate` adapter setting at the same time
- repeat the call once per file you sent in the original `instructionsBundle.files`
- after each PUT, re-run the GET and re-assert the required conditions

## Safety Notes

- Config read APIs redact obvious secrets.
- `pending_approval` agents cannot run heartbeats, receive assignments, or create keys.
- All actions are logged in activity for auditability.
- Use markdown in issue/approval comments and include links to approval, agent, and source issue.
- After approval resolution, requester may be woken with `PAPERCLIP_APPROVAL_ID` and should reconcile linked issues.
