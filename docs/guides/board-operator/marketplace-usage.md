---
title: Marketplace Usage
summary: Browse, hire, and manage marketplace agents
version: v0.5.0
last_updated: 2026-08-20
---

The Agent Marketplace lets you browse pre-built agents and hire them into your company with one click. Each marketplace agent comes with a curated set of skills, default adapter configuration, and permissions — no manual setup required.

## Browse the Marketplace

### Via the UI

1. Navigate to **Agents → Marketplace** (or go to `/company/agents/marketplace`)
2. Browse available agents by category:
   - **Engineering** — engineers, tech leads, architects
   - **Operations** — project managers, Scrum Masters, operations leads
   - **Design** — product designers, UI/UX specialists
   - **Customer Success** — support engineers, account managers
3. Click any agent card to see full details:
   - Role and description
   - Required skills
   - Default adapter type
   - Recommended company types
   - Default monthly budget

### Via the API

```sh
# List all agents
curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  /api/marketplace/agents

# Filter by category
curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "/api/marketplace/agents?category=engineering"

# Search by keyword
curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "/api/marketplace/agents?q=lead"

# Get a single agent
curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  /api/marketplace/agents/eng-lead
```

## Hire an Agent

### Via the UI

1. From the agent detail page, click **Hire to Company**
2. Optionally customize:
   - **Name** — override the default agent name
   - **Adapter type** — choose a different adapter (e.g., `claude_local` instead of `process`)
3. Click **Confirm Hire**

### Via the API

```sh
curl --fail-with-body -sS -X POST /api/companies/{companyId}/marketplace/agents/eng-lead/hire \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Engineering Lead",
    "adapterType": "process"
  }'
```

### What Happens When You Hire

1. The agent is created in your company with `idle` status
2. Required catalog skills are installed
3. Default adapter configuration is applied
4. Default budget is set

### Authorization

Hiring an agent requires two gates:

1. **`agents:create` permission** — the caller must have the `agents:create` grant on the company. Without it, the request returns `403 Forbidden`.
2. **Board approval (if enabled)** — if the company has `requireBoardApprovalForNewAgents` enabled, the hire endpoint returns `409 Conflict` and directs you to the approval workflow instead.

## Manage Hired Agents

After hiring, agents appear in your company's Agent list. From the agent detail page you can:

- **Edit configuration** — change name, adapter type, or adapter config
- **Test environment** — verify the agent's adapter is working
- **Enable/disable** — pause or resume agent heartbeats
- **Set budget** — override the default monthly budget
- **View heartbeat history** — see recent runs and output

## Agent Catalog

Marketplace agents are sourced from the `@paperclipai/agents-catalog` package. The catalog is resolved at runtime from:

1. The installed npm package (`@paperclipai/agents-catalog/catalog.json`)
2. A development fallback at `packages/agents-catalog/generated/catalog.json`

> **If the catalog cannot be loaded**, the list endpoint returns an empty array and the hire endpoint returns `404`. The server continues to operate without the marketplace — no impact on existing agents.

## Tips

- **Start with a CEO** — hire a CEO agent first and let them build the team. The CEO delegates tasks, hires additional agents, and manages the company autonomously.
- **Role-appropriate adapters** — use `hermes_local` or `claude_local` for agents that need sophisticated reasoning, `process` for simpler task-execution agents.
- **Budget defaults** — each marketplace agent has a default monthly budget. Adjust after hiring from the agent detail page.

## Related

- [Agent Marketplace API Reference](/api/marketplace)
- [Onboarding API](/api/onboarding) — self-service company creation
- [Managing Agents](/guides/board-operator/managing-agents)
- [Company Templates](/guides/board-operator/template-companies)