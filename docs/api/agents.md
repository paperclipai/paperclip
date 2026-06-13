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

## Hire Agent (with Idempotency-Key)

```
POST /api/companies/{companyId}/agent-hires
Idempotency-Key: <client-generated UUID v4>
Content-Type: application/json

{ "name": "Engineer", "role": "engineer", ... }
```

The `agent-hires` endpoint accepts a client-supplied `Idempotency-Key`
header to make hire retries safe under network failure. Behavior:

- **Same key, same body, within TTL** → server returns the original
  2xx response (same status code, same body) and sets
  `Idempotency-Key-Replay: true` on the response.
- **Same key, different body** → server returns `422` so callers cannot
  collapse two distinct hires into one cached result.
- **Same key after TTL expiry** → treated as a fresh request and runs
  the handler normally.
- **No `Idempotency-Key` header** → backward-compatible; no dedup.
- **Failed (non-2xx) responses** are not cached; the next retry with
  the same key runs the handler again.
- **Concurrent retries with the same key**: only the first request
  executes the handler; later concurrent requests block briefly and
  replay its response once it completes. If the in-flight request
  fails, concurrent followers receive `409` and the client should
  retry with the same key.

**Default TTL:** 10 minutes from the first successful response.

**Key scope:** Each cached response is scoped to
`(companyId, actorType, actorId, key)`. A different principal that
re-uses another principal's key sees a cache miss and runs through
the normal authorization path.

**Header constraints:** the `Idempotency-Key` value must be a
non-empty string up to 255 characters. Use a UUID v4 in practice.

**Route wiring constraint:** the middleware captures the response
body by intercepting `res.json(...)`. Any route protected by
`idempotency(...)` must produce its successful response via
`res.json`. Routes that bypass `res.json` — for example by streaming,
calling `res.send(buffer)`, or `res.end(string)` — will not have
their body cached and concurrent followers will see `409` instead of
a replay. New mutating endpoints adding `Idempotency-Key` support
must follow the same pattern.

### Client convention

Clients that may retry a hire (UI, harness, agent skills) SHOULD:

1. Generate a UUID v4 before the first attempt.
2. Send it as `Idempotency-Key` on the initial request.
3. On any transient failure (timeout, 5xx, network error), reuse the
   same key on retry.
4. Treat `Idempotency-Key-Replay: true` as the canonical result and
   do not re-submit.
5. Never reuse a key for a logically different hire.

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
