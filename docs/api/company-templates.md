---
title: Company Templates
summary: List and deploy pre-built company templates
---

Browse and deploy pre-built company templates. Each template is a complete company configuration — agents, skills, knowledge base, goals, and starter tasks — deployed in one API call.

## List Templates

```
GET /api/company-templates
```

Returns metadata for all available templates (name, description, industry, icon, company preview). Does not include full agent/goal/project data — use the detail endpoint for that.

### Response

```json
[
  {
    "key": "travel-concierge",
    "name": "Travel Concierge",
    "description": "A ready-to-run travel concierge company with AI agents...",
    "industry": "Travel & Hospitality",
    "icon": "✈️",
    "company": {
      "name": "Voyager Concierge",
      "description": "AI-powered travel concierge...",
      "brandColor": "#0f766e"
    },
    "starterPackKey": "travel-industry"
  }
]
```

## Get Template Detail

```
GET /api/company-templates/{key}
```

Returns the full template including agent definitions, skills, goal, project, and starter issue configuration.

### Response

```json
{
  "key": "support-ops",
  "name": "Support Ops",
  "description": "A ready-to-run customer support operation...",
  "industry": "SaaS & Customer Support",
  "icon": "🎧",
  "company": { "name": "Nimbus Support", ... },
  "agents": [
    {
      "role": "ceo",
      "name": "Nova",
      "title": "Support Lead",
      "skills": ["paperclipai:bundled:paperclip-operations:task-planning"],
      "instructions": "You are the Support Lead..."
    }
  ],
  "skills": ["paperclipai:bundled:paperclip-operations:task-planning"],
  "starterPackKey": "saas-support",
  "goal": { "title": "Deliver world-class customer support", ... },
  "project": { "name": "Support Launch", ... },
  "starterIssue": { "title": "Define the ticket triage workflow", ... }
}
```

## Deploy Template

```
POST /api/company-templates/{key}/deploy
```

Creates a new company from the template. Requires an authenticated user session (board user or instance admin). Agents cannot deploy templates.

### Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | No | Override the default company name |
| `budgetMonthlyCents` | number | No | Monthly budget in cents (default: 0) |

### Response (201 Created)

Returns the created resources plus any warnings. The deployment is **atomic** — if any critical step fails (skill install, agent creation, knowledge pack, goal, project, or starter issue), the entire operation rolls back and no partial state is left behind. The only non-fatal failure that produces a warning is agent instructions materialization (the agent still works with adapter defaults).

```json
{
  "company": {
    "id": "a1b2c3d4-...",
    "name": "Nimbus Support",
    "issuePrefix": "NIM",
    "description": null,
    "status": "active",
    "createdAt": "2026-08-18T00:00:00.000Z"
  },
  "agents": [
    {
      "id": "e5f6g7h8-...",
      "name": "Nova",
      "role": "ceo",
      "title": "Support Lead",
      "status": "idle",
      "urlKey": "nova"
    }
  ],
  "goal": { "id": "...", "title": "...", "status": "active" },
  "project": { "id": "...", "name": "Support Launch", "status": "in_progress" },
  "issue": { "id": "...", "title": "...", "status": "todo" },
  "warnings": []
}
```

### What Gets Created

1. **Company** — with owner membership and role grants for the deploying user
2. **Budget policy** — if `budgetMonthlyCents` > 0
3. **Agents** — each with adapter config, skills, and optional instructions bundle
4. **Catalog skills** — installed company-wide and per-agent
5. **Knowledge starter pack** — if the template specifies one
6. **Goal** — company-level (optional)
7. **Project** — linked to the goal (optional)
8. **Starter issue** — assigned to the first agent by default (optional)

### Error Codes

| Status | Meaning |
|---|---|
| 201 | Template deployed successfully |
| 400 | Invalid request body (e.g., negative budget) |
| 403 | Not authenticated as a board user |
| 404 | Template key not found |

The deployment is **all-or-nothing**. In the event of a failure, no partial state is created — the entire operation rolls back. The `warnings` array contains only non-fatal issues (e.g., agent instructions materialization failures).