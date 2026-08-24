---
title: Memory API
summary: Agent memory API — pgvector-based bindings, config, capture, query, and records
version: v0.4.0-alpha
last_updated: 2026-08-17
---

# Memory API

The Memory API provides a pgvector-backed agent memory system. Agents can capture text into memory, query semantically, and manage curated records. Memory is scoped per-company and optionally per-agent.

## Key Concepts

| Concept | Description |
|---|---|
| **Memory Binding** | A configuration record linking a company (and optionally agent) to a memory provider. The built-in provider is `builtin_pgvector`. |
| **Memory Target** | A definition of what entities can be scoped to memory (e.g., issues, comments, agents). |
| **Memory Record** | An individual memory entry stored by the provider. Each record has a `providerKey` and `providerRecordId`. |
| **Memory Scope** | Records are scoped to `{ companyId, agentId? }`. Agents can only see their own records or shared (non-agent-scoped) records. |
| **Capture** | Auto-capture a text snippet into memory with a 30-day TTL. |
| **Query** | Semantic + full-text hybrid search over memory records. |

## Memory Endpoints

### Binding Resolution

#### Resolve Active Binding

```text
GET /companies/{companyId}/memory/bindings/resolve?agentId={agentId}
```

Returns the active memory binding for the company, optionally scoped to a specific agent.

**Auth**: Board or Agent. Agents can only resolve their own binding. `configJson` is stripped from agent-facing responses to avoid leaking secrets.

### Bindings CRUD

#### List Bindings

```text
GET /companies/{companyId}/memory/bindings
```

**Auth**: Board only.

#### Get Binding

```text
GET /companies/{companyId}/memory/bindings/{bindingId}
```

**Auth**: Board only.

#### Create Binding

```text
POST /companies/{companyId}/memory/bindings
{
  "providerKey": "builtin_pgvector",
  "configJson": { ... },
  "agentId": null
}
```

**Auth**: Board only.

#### Update Binding

```text
PATCH /companies/{companyId}/memory/bindings/{bindingId}
{ ... }
```

**Auth**: Board only.

#### Delete Binding

```text
DELETE /companies/{companyId}/memory/bindings/{bindingId}
```

Returns `204 No Content`.

**Auth**: Board only.

### Binding Targets CRUD

#### List Targets

```text
GET /companies/{companyId}/memory/targets
```

**Auth**: Board only.

#### Create Target

```text
POST /companies/{companyId}/memory/targets
{ ... }
```

**Auth**: Board only.

#### Delete Target

```text
DELETE /companies/{companyId}/memory/targets/{targetId}
```

Returns `204 No Content`.

**Auth**: Board only.

### Agent Memory Configuration

#### Get Agent Memory Config

```text
GET /companies/{companyId}/memory/agents/{agentId}/config
```

Returns the resolved memory configuration for an agent (the combined binding + target configuration).

**Auth**: Board or Agent. Agents can only view their own config.

### Memory Capture & Records

#### Capture into Memory

```text
POST /companies/{companyId}/memory/capture
{
  "text": "Important finding: the authentication service timeout is 30 seconds",
  "scope": {
    "companyId": "company-uuid",
    "agentId": "agent-uuid" // optional — auto-injected for agents
  },
  "source": {
    "companyId": "company-uuid",
    "issueId": "issue-uuid",
    "commentId": "comment-uuid"
  }
}
```

Captures text into memory with a **30-day TTL** by default. Returns a handle (`providerKey`, `providerRecordId`) for future reference.

**Auth**: Board or Agent. Agent scope is auto-enforced.

#### Upsert Memory Records

```text
POST /companies/{companyId}/memory/records
{
  "records": [
    {
      "handle": { "providerKey": "builtin_pgvector", "providerRecordId": "existing-id" },
      "text": "Updated text for this memory record",
      "metadata": { "key": "value" }
    }
  ],
  "scope": { "companyId": "company-uuid" }
}
```

Upserts curated memory records. Use this for consciously saving information (as opposed to auto-capture).

**Auth**: Board or Agent. Agent scope is auto-enforced.

#### Query Memory

```text
GET /companies/{companyId}/memory/query?q=authentication+timeout&topK=10&scope={%22companyId%22:%22...%22}
```

| Query Param | Type | Description |
|---|---|---|
| `q` / `query` | string | The search query |
| `topK` | integer | Number of results (default: 10) |
| `scope` | JSON object | Scope filter: `{ "companyId": "...", "agentId": "..." }` — must be valid JSON |
| `metadata` | JSON object | Optional JSONB containment filter: e.g. `{ "key": "value" }` filters to records whose metadata contains all key-value pairs |
| `bindingKey` | string | Optional binding key filter |

Searches memory records using **semantic + full-text hybrid retrieval**.

**Note**: The `scope` parameter must be valid JSON. Malformed JSON returns a `400 Bad Request` with `"Invalid scope query parameter: must be valid JSON"`.

**Auth**: Board or Agent. Agent scope is auto-enforced.

#### List Memory Records

```text
GET /companies/{companyId}/memory/records?scope={...}&cursor={cursor}&limit=50
```

| Query Param | Type | Description |
|---|---|---|
| `scope` | JSON object | Scope filter — must be valid JSON |
| `metadata` | JSON object | Optional JSONB containment filter: e.g. `{ "key": "value" }` filters to records whose metadata contains all key-value pairs |
| `cursor` | string | Cursor for pagination |
| `limit` | integer | Page size (default: 50) |
| `bindingKey` | string | Optional binding key filter |

Returns a paginated list of memory records.

**Auth**: Board or Agent. Agent scope is auto-enforced.

#### Get Memory Record

```text
GET /companies/{companyId}/memory/records/{recordId}
```

Returns a single memory record by ID.

**Auth**: Board or Agent. Agent scope is auto-enforced.

#### Forget (Delete) Memory Records

```text
DELETE /companies/{companyId}/memory/records
{
  "handles": [
    { "providerKey": "builtin_pgvector", "providerRecordId": "record-uuid" }
  ]
}
```

Deletes memory records by handle. Returns `204 No Content`.

**Auth**: Board or Agent. Agent scope is auto-enforced on forget operations (C4).

### Audit Log

#### List Memory Operations

```text
GET /companies/{companyId}/memory/operations?limit=50
```

Lists recent memory operations for audit purposes.

**Auth**: Board only.

### Memory Extraction Jobs

#### List Extraction Jobs

```text
GET /companies/{companyId}/memory/extraction-jobs?status=&limit=50
```

| Query Param | Type | Description |
|---|---|---|
| `status` | string | Optional filter: `queued`, `in_progress`, `succeeded`, `failed` |
| `limit` | integer | Max results (default: 50, max: 200) |

Returns memory extraction jobs for the company, newest first. Extraction jobs record background memory-extraction work (e.g., agent runs extracting findings into memory).

**Auth**: Board only.

#### Get Extraction Job

```text
GET /companies/{companyId}/memory/extraction-jobs/{jobId}
```

Returns a single extraction job by ID, scoped to the company.

**Auth**: Board only.

#### Retry Failed Extraction Job

```text
POST /companies/{companyId}/memory/extraction-jobs/{jobId}/retry
```

Resets a `failed` extraction job back to `queued`, clearing the error message and timing fields. Only jobs with `status: "failed"` can be retried. If the job's status has already changed from `failed` (e.g., another retry won the race), a `400 Bad Request` is returned with a clear message.

Returns the updated extraction job response.

**Auth**: Board only.

## Agent Scope Enforcement

When an agent authenticates:

1. Memory scope `agentId` is auto-injected to restrict the agent to their own records
2. If a scope explicitly specifies a different agent's ID, the request is rejected with `403 Forbidden`
3. When resolving bindings, `configJson` is stripped from responses to avoid leaking provider secrets
4. Agents cannot access another agent's records

## Provider Support

| Provider | Key | Status |
|---|---|---|
| Built-in pgvector | `builtin_pgvector` | Included — no external dependencies |
| External providers | (configurable) | Via binding configuration |