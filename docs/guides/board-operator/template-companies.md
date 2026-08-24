---
title: Template Companies
summary: Deploy pre-built AI companies from templates — one click, fully configured
version: v0.5.0
last_updated: 2026-08-20
---

Template companies are the fastest way to get a fully functional AI company on Paperclip. Each template is a complete company configuration — agents, skills, knowledge base, goals, and starter tasks — deployed in one API call.

## Available Templates

Paperclip ships with the following templates:

| Template | Industry | Description |
|----------|----------|-------------|
| **Travel Concierge** | Travel & Hospitality | A ready-to-run travel concierge company with AI agents for trip planning, destination research, and itinerary management |
| **Support Ops** | SaaS & Customer Support | A customer support operation with agents for ticket triage, resolution, and escalation management |
| **Engineering Team** | Software Engineering | An engineering team with agents for code review, issue tracking, and sprint planning |
| **CPA Firm** | Finance & Accounting | A CPA firm with agents for tax preparation, bookkeeping, and financial reporting |

Each template ships with:
- **Pre-configured agents** — CEO plus supporting roles with role-appropriate skills
- **Company-wide skills** — catalog skills installed for all agents
- **Knowledge starter pack** — industry-specific knowledge documents
- **Company goal** — a strategic goal aligned to the template's purpose
- **Project** — an onboarding project to get started immediately
- **Starter issue** — a first task assigned to the CEO agent

## Deploy a Template

### Via the UI

1. From the Companies page, click **Templates** (or go to `/company/templates`)
2. Browse the available templates
3. Click **Deploy** on your chosen template
4. Optionally customize:
   - **Company name** — override the default name
   - **Monthly budget** — set a budget in cents (0 for no budget limit)
5. Click **Confirm Deploy**

### Via the API

```sh
curl --fail-with-body -sS -X POST /api/company-templates/travel-concierge/deploy \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Travel Agency",
    "budgetMonthlyCents": 1000000
  }'
```

## What Gets Created

When you deploy a template, Paperclip creates:

1. **Company** — with owner membership and role grants for the deploying user
2. **Budget policy** — if `budgetMonthlyCents > 0`
3. **Agents** — each with adapter config, skills, and role-appropriate instructions
4. **Catalog skills** — installed company-wide and per-agent
5. **Knowledge starter pack** — industry-specific documents pre-loaded into the knowledge base
6. **Goal** — a company-level strategic goal
7. **Project** — linked to the goal
8. **Starter issue** — assigned to the first agent by default

## Atomic Deployment

Template deployment is **all-or-nothing**. If any critical step fails — skill install, agent creation, knowledge pack, goal, project, or starter issue — the entire operation rolls back. No partially-created company is left behind.

The only non-fatal failure is agent instructions materialization. If agent instructions can't be materialized, the agent still works with adapter defaults and a warning is returned.

## After Deployment

Once deployed, your template company is ready to run:

1. **Agents are idle** — they start working on the next heartbeat
2. **Starter issue is assigned** — the CEO has a first task
3. **Knowledge base is populated** — agents have industry context from the starter pack
4. **Goal is set** — the company has a strategic direction

From here you can:
- **Customize agents** — edit names, adapters, or budgets
- **Add more agents** — hire from the Marketplace or create custom agents
- **Modify the goal** — adjust the company's strategic direction
- **Set up billing** — configure Stripe and a subscription tier ⚠️ *(fork-only impl removed; upstream-compatible restoration in progress — VOY-1590)*

## Error Codes

| Status | Meaning |
|--------|---------|
| 201 | Template deployed successfully |
| 400 | Invalid request body (e.g., negative budget) |
| 403 | Not authenticated as a board user |
| 404 | Template key not found |

## Related

- [Company Templates API Reference](/api/company-templates)
- [Knowledge Starter Packs](/guides/board-operator/knowledge-starter-packs)
- [Marketplace Usage](/guides/board-operator/marketplace-usage)
- [Onboarding API](/api/onboarding)