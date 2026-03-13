---
title: Nodes
summary: Remote node registration, API keys, and runner endpoints
---

Manage remote compute nodes that execute agent runs.

## List Nodes

```
GET /api/companies/{companyId}/nodes
```

Returns all registered nodes for the company.

## Get Node

```
GET /api/companies/{companyId}/nodes/{nodeId}
```

Returns node details including status, capabilities, and last seen time.

## Register Node

```
POST /api/companies/{companyId}/nodes
{
  "name": "my-mac",
  "capabilities": { "browser": true, "macos": true }
}
```

Creates a node and a default API key. The response includes the raw key (shown only once):

```json
{
  "node": { "id": "...", "name": "my-mac", "status": "offline" },
  "apiKey": { "id": "...", "key": "pnk_..." }
}
```

## Update Node

```
PATCH /api/companies/{companyId}/nodes/{nodeId}
{
  "name": "new-name",
  "status": "draining",
  "capabilities": { "browser": true }
}
```

## Delete Node

```
DELETE /api/companies/{companyId}/nodes/{nodeId}
```

Deregisters the node and revokes all its API keys.

## Create API Key

```
POST /api/companies/{companyId}/nodes/{nodeId}/keys
{
  "name": "secondary"
}
```

Returns a new API key for the node. Keys use the `pnk_` prefix and are stored as SHA-256 hashes.

---

## Runner Endpoints

These endpoints are authenticated with a node API key (`Bearer <pnk_...>`) instead of session auth.

### Heartbeat

```
POST /api/nodes/{nodeId}/heartbeat
```

Keepalive signal. Updates `last_seen_at` and sets status to `online`. Returns pending run count:

```json
{ "ok": true, "pendingRuns": 2 }
```

### Claim Run

```
POST /api/nodes/{nodeId}/claim
```

Claims the next queued run for any agent assigned to this node. Returns run context or `204 No Content` if nothing is queued.

**Response (200):**

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "contextSnapshot": { "wakeReason": "...", "prompt": "..." },
  "adapterConfig": { "localAdapterType": "claude_local", "localAdapterConfig": {} },
  "sessionIdBefore": "session-abc",
  "runtime": {}
}
```

### Stream Logs

```
POST /api/nodes/{nodeId}/runs/{runId}/log
{
  "stream": "stdout",
  "chunk": "..."
}
```

Forwards log output to the waiting `execute()` function. Returns `409` if the run has been cancelled.

### Report Completion

```
POST /api/nodes/{nodeId}/runs/{runId}/report
{
  "exitCode": 0,
  "usage": { "inputTokens": 1000, "outputTokens": 500 },
  "sessionId": "session-abc",
  "costUsd": 0.05,
  "summary": "Task completed successfully"
}
```

Resolves the deferred adapter promise and finalizes the run.

---

## Live Events

| Event | Payload | Purpose |
|-------|---------|---------|
| `node.run.available` | `{ runId, agentId, nodeId }` | Notifies runner that a run is queued |
| `node.run.cancelled` | `{ runId, nodeId }` | Tells runner to stop a run |
| `node.status` | `{ nodeId, status }` | Broadcast on node status change |
