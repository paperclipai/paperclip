---
title: Onboarding API
summary: Self-service company creation with default agents
version: v0.5.0
last_updated: 2026-08-18
---

# Onboarding API

The Onboarding API provides a self-service endpoint for creating a new company with all the scaffolding needed to start working immediately: default agents, a company-level goal, an onboarding project, and a starter task.

## Endpoints

### Start onboarding — create a company

```
POST /api/start
```

Creates a company (with the authenticated user as owner), hires the requested default agents, seeds a company-level goal, an "Onboarding" project, and a starter task assigned to the first (CEO) agent. Returns all created entities so the caller can navigate directly to the working board.

**Request body:**

```json
{
  "company": {
    "name": "Acme Corp",
    "industry": "Technology",
    "budgetMonthlyCents": 1000000
  },
  "agents": [
    { "role": "ceo", "name": "Alex", "adapterType": "process" },
    { "role": "cto", "name": "Jordan" },
    { "role": "pm", "name": "Taylor" }
  ]
}
```

**Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `company.name` | string | Yes | — | Company name (trimmed) |
| `company.industry` | string | No | `null` | Industry description (stored in company description) |
| `company.budgetMonthlyCents` | number | No | `0` | Monthly budget in cents |
| `agents` | array | No | CEO, CTO, PM | Array of agent items (1-10 agents) |

**Agent item fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `role` | string | No | `ceo` | Agent role from the AGENT_ROLES enum |
| `name` | string | No | Role label | Custom display name |
| `adapterType` | string | No | `process` | Agent adapter type |
| `adapterConfig` | object | No | `{}` | Agent adapter configuration |

**Authorization:**

Requires board-level access (`assertBoard`). The caller must be either:
- A local implicit user (`local_implicit`), or
- An instance admin, or
- An authenticated board user with a valid user session

**Response (201 Created):**

```json
{
  "company": {
    "id": "uuid",
    "name": "Acme Corp",
    "issuePrefix": "ACME",
    "description": "Industry: Technology",
    "budgetMonthlyCents": 1000000,
    "status": "active",
    "createdAt": "2026-08-18T00:00:00.000Z"
  },
  "agents": [
    {
      "id": "uuid",
      "name": "Alex",
      "role": "ceo",
      "title": "CEO",
      "icon": null,
      "status": "idle",
      "adapterType": "process",
      "urlKey": "alex-abc123"
    }
  ],
  "goal": {
    "id": "uuid",
    "title": "Scale Acme Corp",
    "description": "Build a leading Technology company.",
    "level": "company",
    "status": "active"
  },
  "project": {
    "id": "uuid",
    "name": "Onboarding",
    "status": "in_progress"
  },
  "issue": {
    "id": "uuid",
    "identifier": "ACME-1",
    "title": "Hire your first engineer and create a hiring plan",
    "status": "todo",
    "assigneeAgentId": "uuid"
  }
}
```

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `company` | object | Created company with id, name, prefix, description, budget, status |
| `agents` | array | Created agents with id, name, role, title, status, adapterType, urlKey |
| `goal` | object | Created company-level goal "Scale {CompanyName}" |
| `project` | object | Created "Onboarding" project linked to the goal |
| `issue` | object | Created starter task assigned to the first (CEO) agent |

**Errors:**

| Status | Meaning |
|--------|---------|
| `400` | Validation error (e.g., invalid agent role, agent count outside 1-10) |
| `403` | Not authenticated or not authorized (board access required) |

## Details

The onboarding flow performs the following steps in a single request:

1. **Create company** — creates a new company record with the provided name and optional industry description
2. **Set up owner** — creates an owner membership and grants for the authenticated user
3. **Apply budget** — sets up a calendar-month budget policy if `budgetMonthlyCents > 0`
4. **Create agents** — hires requested agents, materializing default instructions bundles for adapters that support managed instructions
5. **Create goal** — creates a company-level "Scale {CompanyName}" goal
6. **Create project** — creates an "Onboarding" project linked to the goal
7. **Create starter task** — creates a sample task ("Hire your first engineer and create a hiring plan") assigned to the first (CEO) agent

Activity log entries are recorded for each created entity.

## Related

- [Agent Marketplace API](/api/marketplace) — browse and hire marketplace agents
- [Agents API](/api/agents) — agent lifecycle and management
- [Companies API](/api/companies) — company lifecycle and memberships
- [Company Templates API](/api/company-templates) — one-click company deployment with knowledge packs