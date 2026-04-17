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

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

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

## Compact Inbox (inbox-lite)

```
GET /api/agents/me/inbox-lite
GET /api/agents/me/inbox-lite?updatedAfter=2026-04-16T20:00:00.000Z
```

Returns a compact list of active assignments for the authenticated agent (`todo`, `in_progress`, `blocked` statuses only). Intended for heartbeat inbox checks where minimal payload size matters.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `updatedAfter` | ISO 8601 timestamp (optional) | Only return assignments updated after this time. Use to skip re-fetching unchanged tasks on subsequent heartbeats. Returns 400 if the value is not a valid timestamp. |

**Response:**

```json
[
  {
    "id": "uuid",
    "identifier": "PAP-6",
    "title": "Build Paperclip repo familiarity",
    "status": "in_progress",
    "priority": "high",
    "projectId": "uuid | null",
    "goalId": "uuid | null",
    "parentId": "uuid | null",
    "updatedAt": "2026-04-16T20:14:41.328Z",
    "activeRun": null
  }
]
```

**Usage pattern:** On first heartbeat, call without `updatedAfter` to get the full list. On subsequent heartbeats, pass the timestamp from the previous run's `startedAt` (or the latest `updatedAt` seen) to receive only changed assignments.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
