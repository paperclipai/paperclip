# Support Case Assessment: Company Templates — Pre-Built Companies for One-Click Deploy

**Feature**: Pre-built company templates that create a full company (agents, skills, knowledge, goals, projects, starter issues) in one click
**Assessed by**: Support Engineer
**Date**: 2026-08-17 (updated 2026-08-19 — VOY-1403 atomic deploy)
**Related**: VOY-1340, VOY-1403
**Commits**: `e5276f9037`, `62d532d119`, `c067b8c494`, `ceaa429591` (VOY-1403)
**Release**: v0.4.0-alpha (post-hotfix), M-series tech debt release (VOY-1460)

## Feature Overview (User Perspective)

Company Templates let users choose a pre-configured company setup from a gallery and deploy it with one click. Each template includes:

- A **company** with a default name, description, and budget
- **Pre-configured agents** with roles, titles, skills, and custom instructions
- **Catalog skills** installed company-wide
- An optional **knowledge starter pack** (industry-specific knowledge base)
- A **company-level goal** and **project**
- A **starter issue** assigned to the first agent

### Available Templates

| Template | Key | Industry | Agents | Starter Pack |
|---|---|---|---|---|
| Travel Concierge | `travel-concierge` | Travel & Hospitality | CEO, Booking Agent, Support Agent | travel-industry |
| Support Ops | `support-ops` | SaaS & Customer Support | Support Lead, Tier 1, Tier 2 | saas-support |
| Engineering Team | `engineering-team` | Software Engineering | CTO, Senior Engineer, DevOps | engineering |
| CPA Firm | `cpa-firm` | Accounting & Tax | Managing Partner, Tax Specialist, Bookkeeper | finance-accounting |

### Deploy Flow

1. **Navigate** to the Companies page and click the **Templates** button (or go directly to `/company/templates`)
2. **Browse** the template gallery — each card shows the template name, industry, description, and a preview of the company it will create
3. **Click "Deploy {Template Name}"** on any card
4. **Optionally rename** the company in the deploy dialog (leave empty to use the template's default name)
5. **Confirm** — the system creates the company, all agents, installs skills, loads the knowledge starter pack, creates the goal + project, and creates the starter issue
6. The page **redirects** to the new company's dashboard automatically

### What Gets Created

Per deploy, the system creates:

- 1 company (with owner membership and role grants for the deploying user)
- 1 budget policy (if the template or deploy request specifies monthly cents)
- 1+ agents (each with adapter config, skills, and optional instructions bundle)
- N catalog skill installations (company-wide and per-agent)
- 1 knowledge starter pack (if specified)
- 1 company-level goal (optional)
- 1 project under the goal (optional)
- 1 starter issue (optional, assigned to the first agent by default)

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/company-templates` | List all templates (metadata only — no agents/goals) |
| `GET` | `/company-templates/:key` | Get a single template with full details |
| `POST` | `/company-templates/:key/deploy` | Deploy a template (creates company + all resources) |

### Deploy Request Body

```json
{
  "name": "Optional company name override",
  "budgetMonthlyCents": 0
}
```

### Deploy Response

Returns the created company, agents, goal, project, starter issue, and any warnings:

```json
{
  "company": { "id": "...", "name": "...", "issuePrefix": "...", ... },
  "agents": [{ "id": "...", "name": "...", "role": "ceo", ... }],
  "goal": { "id": "...", "title": "...", ... },
  "project": { "id": "...", "name": "...", ... },
  "issue": { "id": "...", "title": "...", ... },
  "warnings": []
}
```

## Potential User Confusion Points

1. **"I deployed a template but nothing happened"** — The page should auto-redirect to the new company's dashboard. If the redirect doesn't trigger, check the browser for JavaScript errors or network failures. The company was likely created — navigate to the Companies page to see it.

2. **"The template I want isn't available"** — Templates are loaded from JSON files on the server (`server/src/company-template-data/`). The list endpoint returns whatever is on disk. If no templates show, check the server logs for template load errors.

3. **"My agent is missing its skills"** — Skill installation from the catalog runs inside the deployment transaction. If a catalog skill ID doesn't exist on the server, the **entire deployment rolls back** (VOY-1403) — no company, agents, or partial state is left behind. The deploy request fails; the user must fix the underlying cause and retry. Since v0.5.0 production-stable, all bundled template skills are verified present at release time.

4. **"I can't edit the agent instructions"** — Agents deployed from templates have a materialized instructions bundle (AGENTS.md). These can be edited via the agent settings page or the instructions API.

5. **"The knowledge starter pack didn't load"** — Starter pack installation is now **fatal** (VOY-1403). If the pack key doesn't exist in the system, the deployment rolls back entirely. This is by design — the pack is part of the template contract. A `warnings` entry only appears for agent instructions materialization failures (non-fatal; the agent still works with adapter defaults).

## Known Limitations

1. **No budget customization in the UI** — The deploy dialog only allows overriding the company name. To set a monthly budget, use the API directly with `budgetMonthlyCents` in the request body.

2. **Agent adapter type defaults to "process"** — Templates can specify an adapter type override, but most use the default. If you need a different adapter (e.g., "hermes", "claude"), modify the agent after deployment.

3. **No template editing** — Templates are server-side JSON files. There is no UI for creating, editing, or deleting templates. Only the server operator can add/remove templates.

4. **Starter issue is always todo** — The starter issue is created with status `todo`. It must be assigned and started manually.

5. **Template icons are emoji** — The template icon is an emoji string (e.g., "✈️", "🎧"). No custom icon upload is supported.

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| "Template not found" error | Invalid template key | Check available templates via `GET /company-templates` |
| Deploy fails with 403 | Not authenticated as a board user | Ensure you're logged in as a board user with company creation permissions |
| Deploy fails (no company created) | A critical step failed (skill install, agent creation, pack, goal, project, or issue) | Deployment is atomic (VOY-1403): no partial state remains. Check server logs for the failing step, fix the cause, retry |
| Warnings in deploy response | Agent instructions materialization failed | The agent still works with adapter defaults; check the `warnings` array |
| Agents created but not waking | Agents created in "idle" status; need timer or manual wake | Check agent status; triggers should wake them on the next heartbeat cycle |
| Duplicate company name | No uniqueness check on company name | Companies can have the same name; rename in the UI or deploy with a custom name |

## Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Deploy rolls back entirely (no partial state) | High | This is expected behavior since VOY-1403 (atomic deploy). Check server logs for the failing step; escalate to Staff Engineer only if a *valid* template deployment fails |
| Template load failure on server startup | High | Check server logs for JSON parse errors in `server/src/company-template-data/` |
| Agent instructions not materialized | Medium | The agent still works with adapter defaults; instructions can be set manually via the API |
| Knowledge starter pack not available | Medium | Since VOY-1403 the deployment rolls back when the pack is missing — verify the pack exists in the system; escalate to CTO if missing |
| User wants to add a custom template | Low | Refer to server operator; templates are JSON files on disk |

## Related Documentation

- [Company Templates API Reference](/docs/api/company-templates) (if available)
- [Importing and Exporting Guide](/docs/guides/board-operator/importing-and-exporting) — for creating custom company setups
- [Companies API Reference](/docs/api/companies) — for post-deploy company management