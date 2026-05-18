---
name: paperclip-create-agent
description: >
  Create new agents in Paperclip with governance-aware hiring. Use when you need
  to inspect adapter configuration options, compare existing agent configs,
  draft a new agent prompt/config, and submit a hire request.
---

# Paperclip Create Agent Skill

Use this skill when you are asked to hire/create an agent.

## Preconditions

You need either:

- board access, or
- agent permission `can_create_agents=true` in your company

If you do not have this permission, escalate to your CEO or board.

## Workflow

### 1. Confirm identity and company context

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. Discover adapter configuration for this Paperclip instance

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# Then the specific adapter you plan to use, e.g. claude_local:
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. Compare existing agent configurations

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Note naming, icon, reporting-line, and adapter conventions the company already follows.

### 4. Choose the instruction source (required)

This is the single most important decision for hire quality. All hardened templates share the **unified ten-section structure** documented in `references/agents/template-base.md` — `STOP` / `Role` / `Done means …` / `Trigger and lifecycle` / `Scope — you may / you may not` / `Trigger map` / `Always-on minimums` / `Collaboration and hand-offs` / `References`, with three sections (`STOP`, `Done means …`, `Trigger map`) marked `[CONDITIONAL]` — present only when the role has earned them through incident-driven need.

Pick exactly one path:

- **Exact template** — the role matches Coder or QA. Use the matching file under `references/agents/` (`coder.md` or `qa.md`) verbatim and adapt company-specific values (agent name, company name, manager title, skill paths). These two files are the canonical filled-stamps with all ten sections rendered.
- **Adjacent template** — no exact match, but an existing template is close (for example, a "Backend Engineer" hire adapted from `coder.md`, or a "Content Designer" adapted from `uxdesigner.md`). Copy the closest template and adapt deliberately: rename the role, rewrite the role charter, swap domain lenses, and remove sections that do not fit. Preserve the ten-section structure where it applies.
- **Unified base** — no template is close, but the role is trigger-heavy and needs the full ten-section structure (e.g. ReleaseEngineer, DataEngineer, a new SecurityEngineer variant). Start from `references/agents/template-base.md`, fill in the seven `[REQUIRED]` sections, and add the three `[CONDITIONAL]` sections only when the role has earned them.
- **Generic fallback** — narrow-scope role with no trigger-driven workflow. Use the baseline role guide to construct a short `AGENTS.md` from the seven required sections, omitting all three conditionals.

Template index, decision tree, and when-to-use guidance:
`skills/paperclip-create-agent/references/agent-instruction-templates.md`

Unified ten-section skeleton (canonical starting point for new role types):
`skills/paperclip-create-agent/references/agents/template-base.md`

Generic fallback for narrow-scope no-template hires:
`skills/paperclip-create-agent/references/baseline-role-guide.md`

State which path you took in your hire-request comment so the board can see the reasoning.

### 5. Discover allowed agent icons

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 6. Draft the new hire config

- role / title / name
- icon (required in practice; pick from `/llms/agent-icons.txt`)
- reporting line (`reportsTo`)
- adapter type
- `desiredSkills` from the company skill library when this role needs installed skills on day one
- if any `desiredSkills` or adapter settings expand browser access, external-system reach, filesystem scope, or secret-handling capability, justify each one in the hire comment
- adapter and runtime config aligned to this environment
- leave timer heartbeats off by default; only set `runtimeConfig.heartbeat.enabled=true` with an `intervalSec` when the role genuinely needs scheduled recurring work or the user explicitly asked for it
- if the role may handle private advisories or sensitive disclosures, confirm a confidential workflow exists first (dedicated skill or documented manual process)
- capabilities
- managed instructions bundle (`AGENTS.md`) for adapters that support it; avoid durable `promptTemplate` config
- for coding or execution agents, include the Paperclip execution contract: start actionable work in the same heartbeat; do not stop at a plan unless planning was requested; leave durable progress with a clear next action; use child issues for long or parallel delegated work instead of polling; mark blocked work with owner/action; respect budget, pause/cancel, approval gates, and company boundaries
- instruction text such as `AGENTS.md` built from step 4; for local managed-bundle adapters, send this as top-level `instructionsBundle.files["AGENTS.md"]`. Do not set `adapterConfig.promptTemplate` or `bootstrapPromptTemplate` for new agents.
- source issue linkage (`sourceIssueId` or `sourceIssueIds`) when this hire came from an issue

### 7. Review the draft against the quality checklist

Before submitting, walk the draft-review checklist end-to-end and fix any item that does not pass:
`skills/paperclip-create-agent/references/draft-review-checklist.md`

### 8. Submit hire request

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CTO",
    "role": "cto",
    "title": "Chief Technology Officer",
    "icon": "crown",
    "reportsTo": "<ceo-agent-id>",
    "capabilities": "Owns technical roadmap, architecture, staffing, execution",
    "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
    "adapterType": "codex_local",
    "adapterConfig": {"cwd": "/abs/path/to/repo", "model": "o4-mini"},
    "instructionsBundle": {"files": {"AGENTS.md": "You are the CTO..."}},
    "runtimeConfig": {"heartbeat": {"enabled": false, "wakeOnDemand": true}},
    "sourceIssueId": "<issue-id>"
  }'
```

### 9. Handle governance state

- if the response has `approval`, the hire is `pending_approval`
- monitor and discuss on the approval thread
- when the board approves, you will be woken with `PAPERCLIP_APPROVAL_ID`; read linked issues and close/comment follow-up

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/<approval-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"## CTO hire request submitted\n\n- Approval: [<approval-id>](/approvals/<approval-id>)\n- Pending agent: [<agent-ref>](/agents/<agent-url-key-or-id>)\n- Source issue: [<issue-ref>](/issues/<issue-identifier-or-id>)\n\nUpdated prompt and adapter config per board feedback."}'
```

If the approval already exists and needs manual linking to the issue:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"approvalId":"<approval-id>"}'
```

After approval is granted, run this follow-up loop:

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

For each linked issue, either:
- close it if the approval resolved the request, or
- comment in markdown with links to the approval and next actions.

## References

- Template index, decision tree, and how to apply a template: `skills/paperclip-create-agent/references/agent-instruction-templates.md`
- Unified ten-section skeleton (canonical starting point for new role types): `skills/paperclip-create-agent/references/agents/template-base.md`
- Individual role templates (Coder, QA, UX Designer, SecurityEngineer): `skills/paperclip-create-agent/references/agents/`
- Generic baseline role guide (narrow-scope no-template fallback): `skills/paperclip-create-agent/references/baseline-role-guide.md`
- Pre-submit draft-review checklist: `skills/paperclip-create-agent/references/draft-review-checklist.md`
- Endpoint payload shapes and full examples: `skills/paperclip-create-agent/references/api-reference.md`
