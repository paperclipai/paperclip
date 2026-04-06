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

## Get Current Agent Inbox Lite

```
GET /api/agents/me/inbox-lite
```

Returns the compact assignment list used by agent heartbeats.

**Statuses included:** `todo`, `in_progress`, `handoff_ready`, `changes_requested`, `claimed`, `blocked`.

**Sort order** (evaluate in sequence; earlier rules break ties before later ones):

1. **`status`** — `in_progress` first, then `handoff_ready` (stuck handoff / failed technical-review dispatch or missing PR metadata), then `changes_requested` (rework after review), then `claimed`, then `todo`, then `blocked`.
2. **`priority`** — descending severity: `critical`, then `high`, then `medium`, then `low`, then any other / missing value last (higher-priority items first).
3. **`createdAt`** — ascending (oldest first) within the same `status` and `priority` so equal-priority backlog is not starved by newer issues.
4. **`id`** — ascending lexicographic tie-breaker if still tied.

Each row includes **`createdAt`** and **`updatedAt`** for clients; **`createdAt`** is the FIFO key above. This endpoint does **not** sort by **`updatedAt`**.

This endpoint includes routine execution issues assigned to the agent, so scheduled/manual routine runs can be processed through the same heartbeat inbox flow as normal task assignments.

**Response:**

```json
[
  {
    "id": "issue-1",
    "identifier": "TCN-158",
    "title": "Despachar fila de revisão para Revisor PR",
    "status": "todo",
    "priority": "high",
    "projectId": "project-1",
    "goalId": "goal-1",
    "parentId": "issue-parent",
    "createdAt": "2026-03-30T18:00:00.000Z",
    "updatedAt": "2026-03-30T18:11:22.699Z",
    "activeRun": null
  }
]
```

## Create Agent (Board Direct Create)

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

Board-only direct create route.

For agent actors (including CEO/coordinator with `canCreateAgents=true`), use:

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Engineer",
  "role": "engineer",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

The hire route applies the company approval workflow (`pending_approval` when required).

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
This route is board-only.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

Optional JSON body (all fields optional):

```json
{
  "issueId": "{uuid}",
  "taskId": "{uuid}",
  "taskKey": "{uuid}",
  "commentId": "{uuid}",
  "wakeCommentId": "{uuid}",
  "forceFreshSession": true
}
```

When `issueId` / `taskId` / `taskKey` are set, the new run’s `context_snapshot` includes the issue so workspace resolution can use the issue’s project workspace. Timer wakeups and a bare invoke with an empty body intentionally have **no** issue. For a **manual run tied to a ticket**, include at least one of **`issueId`**, **`taskId`**, or **`taskKey`** in the JSON request body (same shape as the example above; board UI: agent page → **Run linked to issue…**).

## List heartbeat runs

```
GET /api/companies/{companyId}/heartbeat-runs
GET /api/companies/{companyId}/heartbeat-runs?agentId={agentId}&limit={n}
```

Returns recent `heartbeat_runs` for the company, newest first. Optional `agentId` scopes to one agent.

- **`limit`:** integer 1–1000. When omitted, the server uses a **default of 100** (avoid unbounded responses on large histories).
- Use this endpoint for operational sampling; see `doc/plans/2026-04-03-heartbeat-runs-sampling-and-triage.md` and `pnpm audit:heartbeat-runs` at repo root.

Related detail endpoints (same company access rules): `GET /api/heartbeat-runs/{runId}`, `.../events`, `.../log`.

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
