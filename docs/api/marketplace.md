---
title: Agent Marketplace API
summary: Browse and one-click hire marketplace agents
version: v0.5.0
last_updated: 2026-08-18
---

# Agent Marketplace API

The Agent Marketplace lets board operators browse available marketplace agents and hire them into their company with a single call. Each marketplace agent comes from the **agents catalog** — a curated set of pre-configured agent roles with default skills, adapter config, and permissions.

## Endpoints

### List marketplace agents

```
GET /api/marketplace/agents
```

Returns all available marketplace agents. Supports optional filters.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `category` | string | Filter by category (e.g., `engineering`, `operations`) |
| `role` | string | Filter by role (e.g., `engineer`, `pm`, `designer`) |
| `q` | string | Free-text search against name, description, and tags |

**Response:**

```json
{
  "agents": [
    {
      "id": "agent-001",
      "key": "eng-lead",
      "kind": "bundled",
      "category": "engineering",
      "slug": "engineering-lead",
      "name": "Engineering Lead",
      "description": "Leads engineering efforts, writes code, reviews PRs",
      "icon": null,
      "role": "engineer",
      "title": "Engineering Lead",
      "recommendedForCompanyTypes": ["startup", "agency"],
      "tags": ["engineering", "leadership"],
      "requiredSkills": [
        { "catalogSkillKey": "github-integration", "required": true }
      ],
      "defaultAdapterType": "process",
      "defaultBudgetMonthlyCents": 50000
    }
  ]
}
```

### Get a single marketplace agent

```
GET /api/marketplace/agents/:ref
```

Returns a single marketplace agent by its `id`, `key`, or `slug`.

**Response:** Same structure as a single agent in the list endpoint.

**Errors:**

| Status | Meaning |
|--------|---------|
| `404` | Agent not found |

### Hire a marketplace agent into a company

```
POST /api/companies/:companyId/marketplace/agents/:ref/hire
```

Creates the marketplace agent in the specified company with its default configuration and installs all required catalog skills. The agent is created as an `idle` agent with the catalog entry's default permissions and budget.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Custom name (defaults to the catalog entry name) |
| `adapterType` | string | No | Override adapter type (defaults to catalog default) |
| `adapterConfig` | object | No | Override adapter configuration (defaults to catalog default) |

**Authorization:**

This endpoint enforces two layers of authorization:

1. **`agents:create` permission** — the caller must have the `agents:create` grant on the company. This is the same permission check used by the standard `POST /api/companies/:companyId/agents` endpoint. Callers without this grant receive a `403 Forbidden` with an explanation.
2. **Board approval gate** — if the company has `requireBoardApprovalForNewAgents` enabled, the endpoint returns `409 Conflict` with a message directing the caller to use the agent-hire approval flow instead. This prevents bypass of the board approval workflow.

**Response (201 Created):**

```json
{
  "agentId": "uuid",
  "agentName": "Engineering Lead",
  "agentRole": "engineer",
  "agentSlug": "eng-lead-abc123",
  "skillsInstalled": 3,
  "warnings": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | UUID of the created agent |
| `agentName` | string | Name of the created agent |
| `agentRole` | string | Role of the created agent |
| `agentSlug` | string | URL-friendly slug for the agent |
| `skillsInstalled` | number | Count of required catalog skills installed |
| `warnings` | string[] | Non-fatal warnings during installation |

**Errors:**

| Status | Meaning |
|--------|---------|
| `403` | Caller lacks `agents:create` permission, or agent key belongs to a different company |
| `404` | Company or marketplace agent not found |
| `409` | Company requires board approval for new agents |

## Agent Catalog

Marketplace agents are sourced from the `@paperclipai/agents-catalog` package. The catalog is resolved at runtime from either:

1. The installed npm package (`@paperclipai/agents-catalog/catalog.json`)
2. A development fallback at `packages/agents-catalog/generated/catalog.json`

If the catalog cannot be loaded, the list endpoint returns an empty array and the hire endpoint returns a `404` — the server continues to operate without the marketplace.

## Related

- [Onboarding API](/api/onboarding) — self-service company creation
- [Agents API](/api/agents) — agent lifecycle management
- [Approvals API](/api/approvals) — hire approval workflow