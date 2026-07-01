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

## Restricted Views (`configRedacted`)

When a caller does **not** hold the `agents:create` permission, the agent read routes return a restricted projection that omits sensitive configuration and surfaces a self-describing flag:

- `adapterConfig` and `runtimeConfig` are **omitted** from the response (not set to `{}`).
- A `configRedacted: true` field is added so callers can distinguish a redacted projection from a genuinely-empty configuration.

The `isSelf` shortcut (`GET /api/agents/me`, and `GET /api/agents/{agentId}` when `agentId` matches the caller) is unaffected — callers always see their own full config.

Routes that apply this behavior:

- `GET /api/agents/{agentId}` — restricted-view shape when the caller lacks `agents:create` and is not the target agent.
- `GET /api/companies/{companyId}/agents` — every row uses the restricted-view shape when the caller lacks `agents:create`, including the caller's own row. Use `GET /api/agents/me` to read own full config from the list context.

The config-only redaction path used by configuration-listing routes (e.g. config revisions) carries `configRedacted: false` so consumers can use a single uniform flag across both response shapes.

**Restricted-view response example** (caller lacks `agents:create`):

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "status": "running",
  "configRedacted": true
}
```

**Privileged response example** (caller holds `agents:create`):

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "adapterConfig": { "...": "..." },
  "runtimeConfig": { "...": "..." }
}
```

Privileged responses do **not** carry the `configRedacted` flag.

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

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
