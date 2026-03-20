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

## Hook configuration

Hooks live under `runtimeConfig.hooks` and are intended for event-driven handoffs.

Supported lifecycle events:

- `heartbeat.run.started`
- `heartbeat.run.finished`
- `heartbeat.run.succeeded`
- `heartbeat.run.failed`
- `heartbeat.run.cancelled`
- `heartbeat.run.timed_out`

Supported actions:

- `command`
- `webhook`
- `wake_agent`
- `assign_issue`

Security model:

- only board-managed create/update flows — including config rollbacks that would change hooks — can add, remove, or change `runtimeConfig.hooks`
- `wake_agent` and `assign_issue` targets must be explicitly allow-listed via `permissions.allowedAgentRefs`
- `command`, `webhook`, and `assign_issue` each require explicit permission flags

Example: benchmark finished -> wake CTO.

```json
POST /api/companies/{companyId}/agents
{
  "name": "BenchWorker",
  "role": "engineer",
  "adapterType": "process",
  "adapterConfig": {
    "command": "./bin/bench-worker"
  },
  "runtimeConfig": {
    "heartbeat": {
      "intervalSec": 0
    },
    "hooks": {
      "enabled": true,
      "permissions": {
        "allowedAgentRefs": ["CTO"]
      },
      "rules": [
        {
          "id": "benchmark-finished-wake-cto",
          "event": "heartbeat.run.succeeded",
          "match": {
            "run.contextSnapshot.workflow": "benchmark"
          },
          "actions": [
            {
              "type": "wake_agent",
              "agentRefs": ["CTO"],
              "reason": "benchmark_finished",
              "payload": {
                "issueId": "{{event.issueId}}",
                "sourceRunId": "{{run.id}}",
                "completedBy": "{{agent.name}}"
              },
              "contextSnapshot": {
                "issueId": "{{event.issueId}}",
                "source": "agent_hook.benchmark_finished",
                "wakeReason": "benchmark_finished"
              }
            }
          ]
        }
      ]
    }
  }
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

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
