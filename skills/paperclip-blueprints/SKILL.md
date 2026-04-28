---
name: paperclip-blueprints
description: >
  Query and use instance-wide agent blueprints when hiring. Use this skill
  when you are asked to hire a new agent and a blueprint was referenced or
  suggested, or when you want to discover available role templates before
  drafting a hire request. Blueprints are reusable configuration presets
  (adapter type, model, capabilities, default instructions) that you adapt
  for the organization's specific needs.
---

# Paperclip Blueprints Skill

Use this skill **before or during** the `paperclip-create-agent` workflow when:

- The board or a task mentions a blueprint by name or asks you to hire from a template
- You want to check if a ready-made config exists for a role before building from scratch
- You need to adapt a known config pattern to a specific stack or project context

Blueprints are **starting points, not final configs**. Always read the blueprint, understand it, then adapt fields like `adapterConfig.cwd`, `adapterConfig.model`, `capabilities`, and `adapterConfig.promptTemplate` to the org's actual setup before submitting the hire request.

---

## 1. List available blueprints

```sh
curl -sS "$PAPERCLIP_API_URL/api/blueprints" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Filter by role:

```sh
curl -sS "$PAPERCLIP_API_URL/api/blueprints?role=engineer" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Search by name, description, or capabilities:

```sh
curl -sS "$PAPERCLIP_API_URL/api/blueprints?search=react" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Combine both:

```sh
curl -sS "$PAPERCLIP_API_URL/api/blueprints?role=engineer&search=frontend" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Each item in the response has: `id`, `name`, `description`, `role`, `title`, `capabilities`, `tags`, `adapterType`, `adapterConfig`, `runtimeConfig`, `budgetMonthlyCents`, `instructionsContent`.

---

## 2. Get a specific blueprint

```sh
curl -sS "$PAPERCLIP_API_URL/api/blueprints/<blueprint-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

---

## 3. Adapt the blueprint for this organization

A blueprint is a **template** — you must customize it before hiring. Go through each field:

| Field | What to adapt |
|---|---|
| `name` | Give the agent a company-specific name (e.g. "Alice" or "Frontend Bot") if needed, or keep generic |
| `capabilities` | Add org-specific tools, repos, or domain knowledge to the description |
| `adapterConfig.cwd` | Set to the actual repo or workspace path on this machine |
| `adapterConfig.model` | Override if a different model is preferred or available on this instance |
| `adapterConfig.promptTemplate` | Add org-specific context: stack, coding standards, team conventions |
| `instructionsContent` | Expand with org-specific AGENTS.md content: project structure, key contacts, conventions |
| `runtimeConfig` | Adjust heartbeat settings for this agent's actual workload |
| `budgetMonthlyCents` | Set per the company budget policy, not the blueprint default |
| `reportsTo` | Always set to the correct reporting agent for this company |

Fields you generally **keep as-is**: `adapterType`, `role`, `title`, `icon`, `tags`, `permissions`.

---

## 4. Submit the hire using the adapted config

After adapting, proceed with step 7 of the `paperclip-create-agent` skill:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<adapted-name>",
    "role": "<from-blueprint>",
    "title": "<from-blueprint>",
    "icon": "<from-blueprint>",
    "reportsTo": "<correct-agent-id-for-this-company>",
    "capabilities": "<adapted-capabilities>",
    "adapterType": "<from-blueprint>",
    "adapterConfig": {
      "<key>": "<adapted-value>"
    },
    "runtimeConfig": { "heartbeat": { "enabled": false, "wakeOnDemand": true } },
    "budgetMonthlyCents": 0,
    "sourceBlueprintId": "<blueprint-id>",
    "sourceIssueId": "<issue-id-if-applicable>"
  }'
```

**Always include `sourceBlueprintId`** when hiring from a blueprint. This links the agent to its template in the UI ("Hired from blueprint: …") and creates a traceable lineage for future reference.

---

## 5. Reference the blueprint in your approval comment

When posting to the approval thread, mention which blueprint was used and what you changed:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "body": "## Hire request from blueprint\n\n**Blueprint used:** <blueprint-name> (`<blueprint-id>`)\n\n**Adaptations made:**\n- `cwd` → set to `/path/to/repo`\n- `model` → changed to `claude-sonnet-4-6`\n- `capabilities` → added: Next.js, Tailwind, our monorepo structure\n- `promptTemplate` → added company coding standards section\n\nAll other fields kept from blueprint defaults."
  }'
```

This creates a clear audit trail of what was customized versus what came from the template.

---

## 6. Save an existing agent as a blueprint

Use this when you hire a new agent from scratch (not from a blueprint) and the board asks you to save it as a reusable template, or when an existing agent's config is worth preserving instance-wide.

### Fetch the agent's current config

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents/<agent-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### Create the blueprint from the agent's config

Strip org-specific fields (`name`, `cwd`, `promptTemplate`) before saving so the blueprint stays portable:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/blueprints" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<descriptive template name, e.g. Senior Frontend Engineer>",
    "description": "<what this role does>",
    "role": "<from-agent>",
    "title": "<from-agent>",
    "icon": "<from-agent>",
    "capabilities": "<from-agent, remove org-specific details>",
    "tags": ["<relevant-tags>"],
    "adapterType": "<from-agent>",
    "adapterConfig": {
      "model": "<from-agent>",
      "cwd": "",
      "dangerouslySkipPermissions": true,
      "promptTemplate": ""
    },
    "runtimeConfig": {},
    "budgetMonthlyCents": 0,
    "permissions": {},
    "instructionsContent": "<generalized AGENTS.md content without org-specific paths or secrets>",
    "metadata": { "sourceAgentId": "<agent-id>", "sourceCompanyId": "<company-id>" }
  }'
```

**Key cleanup rules before saving:**
- Clear `adapterConfig.cwd` — every org has a different workspace path
- Clear `adapterConfig.promptTemplate` — remove org-specific context; keep only generic role instructions
- Strip secrets from `adapterConfig` (API keys, tokens)
- Generalize `capabilities` — remove specific repo names, keep role-level skills
- Set `budgetMonthlyCents: 0` — budget is org-specific

If the agent was itself hired from a blueprint, note the lineage in `metadata.sourceBlueprintId`.

---

## Quality bar

- Never use a blueprint verbatim — at minimum set `cwd`, `reportsTo`, and org-specific prompt context
- If the blueprint `instructionsContent` is set, use it as the base for the new agent's AGENTS.md but expand it with org context
- If no blueprint matches the role, fall back to the standard `paperclip-create-agent` workflow from scratch
- If the board mentioned a specific blueprint by name, list all blueprints first and find the exact match before proceeding

For API payload shapes, see:
`skills/paperclip-blueprints/references/api-reference.md`
