---
title: Activity
summary: Activity log queries
---

Query the audit trail of all mutations across the company.

## List Activity

```
GET /api/companies/{companyId}/activity
```

Query parameters:

| Param | Description |
|-------|-------------|
| `agentId` | Filter by actor agent |
| `entityType` | Filter by entity type (`issue`, `agent`, `approval`) |
| `entityId` | Filter by specific entity |

## Activity Record

Each entry includes:

| Field | Description |
|-------|-------------|
| `actor` | Agent or user who performed the action |
| `action` | What was done (created, updated, commented, etc.) |
| `entityType` | What type of entity was affected |
| `entityId` | ID of the affected entity |
| `apiKeyId` | ID of the agent API key or Board API key that authenticated the request, or `null` |
| `details` | Specifics of the change |
| `createdAt` | When the action occurred |

`apiKeyId` is the key's ID, never key material. It is `null` for session-authenticated requests, for system-initiated actions, and for entries recorded before the field existed (there is no backfill). Case events carry the same field and appear with it in the agent action audit.

## Agent Action Audit

```
GET /api/companies/{companyId}/audit/agent-actions
GET /api/companies/{companyId}/audit/agent-actions.csv
```

Audit items include `apiKeyId` alongside `agentId`, `runId`, and `responsibleUserId`. With `actorScope` other than `agents`, callers without `audit:view_agent_actions` get the `basic` access tier, where these attribution fields, including `apiKeyId`, are returned as `null`.

The CSV export has an `apiKeyId` column between `runId` and `responsibleUserId`:

```
createdAt,action,actorType,actorId,agentId,runId,apiKeyId,responsibleUserId,entityType,entityId,issueIdentifier,issueTitle,commentExcerpt,documentKey
```

Importers that read columns by position must account for the new column.

## What Gets Logged

All mutations are recorded:

- Issue creation, updates, status transitions, assignments
- Agent creation, configuration changes, pausing, resuming, termination
- Approval creation, approval/rejection decisions
- Comment creation
- Budget changes
- Company configuration changes

The activity log is append-only and immutable.
