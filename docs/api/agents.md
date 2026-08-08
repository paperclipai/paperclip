---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

This route does not accept query filters. Unsupported query parameters return `400`.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

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
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Clear Agent Error

```
POST /api/agents/{agentId}/clear-error
```

Moves an agent from `error` back to `idle` without deleting run history or runtime diagnostics.
Only agents currently in `error` can be cleared.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Request body:

```json
{
  "name": "external-worker",
  "scope": { "kind": "standard" }
}
```

`scope` defaults to `standard`. A deterministic external task adapter can use a
bounded task-bridge scope:

```json
{
  "name": "content-task-bridge",
  "scope": {
    "kind": "task_bridge",
    "projectId": "<project-uuid>",
    "parentIssueId": "<optional-parent-issue-uuid>",
    "allowedAssigneeAgentIds": ["<specialist-agent-uuid>"]
  }
}
```

At least one project or parent issue is required. Plural `projectIds` and
`parentIssueIds` arrays are supported up to 50 entries, as is
`allowedAssigneeAgentIds`. All references are validated against the agent's
company before the key is created. If project and parent boundaries are both
present, every scoped parent must belong to one of the scoped projects. Parents
without a project cannot be combined with project boundaries; unassigned or
contradictory boundary sets are rejected before a token is minted.

The response includes key metadata, its normalized `scope`, and the plaintext
token. Store the token securely: the full value is shown only once. List-key
responses include the normalized scope but never the token. Scope is immutable;
revoke and replace a key to change its boundary.

Task-bridge keys do not confer board authority. They can create and operate only
on bridge-owned issues that remain inside the configured project/parent
boundary, and can assign only to the bridge actor or explicitly allowed agents.
See [Authentication](./authentication.md#task-bridge-enforcement) for the full
enforcement and recovery contract.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
