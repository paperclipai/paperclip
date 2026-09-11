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

This is the single most important decision for hire quality. Pick exactly one path:

- **Exact template** — the role matches an entry in the template index. Use the matching file under `references/agents/` as the starting point.
- **Adjacent template** — no exact match, but an existing template is close (for example, a "Backend Engineer" hire adapted from `coder.md`, or a "Content Designer" adapted from `uxdesigner.md`). Copy the closest template and adapt deliberately: rename the role, rewrite the role charter, swap domain lenses, and remove sections that do not fit.
- **Generic fallback** — no template is close. Use the baseline role guide to construct a new `AGENTS.md` from scratch, filling in each recommended section for the specific role.

Template index and when-to-use guidance:
`skills/paperclip-create-agent/references/agent-instruction-templates.md`

Generic fallback for no-template hires:
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

### 6b. Apply local-adapter governance gates (opt-in)

**This step is opt-in** and applies only when your Paperclip company maintains a governance directory with a deny-baseline policy. If your company does not have one, skip to Step 7.

For any new agent whose adapter is `claude_local`, `opencode_local`, or `codex_local`, two governance files should accompany the hire payload bundle when your company's hire-flow gates policy requires them. Both are blocking gates — do not submit if either is missing. The spec lives in your company's governance directory (typically a hostops or governance folder in your project root).

#### 6b.1 `claude-config/settings.json` — Gate 5a (locked deny baseline)

The bundle's `claude-config/settings.json` must contain a JSON object whose `permissions.deny` array is a **superset** of the company's approved baseline. Two acceptable paths:

- **(a) Apply baseline as-is** — copy the baseline JSON block from your company's `<governance-dir>/claude-permissions-baseline.md` verbatim. The hire-request comment must state `settings.json: applies baseline as-is`.
- **(b) Board-approved baseline override** — the bundle additionally contains `claude-config/baseline-override.md` naming the approval ID, the deviating entries, and the justification. The hire-request comment must reference the approval ID and quote the override clause.

Block the hire if neither (a) nor (b) is present.

#### 6b.2 `claude-config/justification.md` — Gate 5b (dangerouslySkipPermissions)

If `adapterConfig.dangerouslySkipPermissions` is `true` (the adapter default for `claude_local`), the bundle must include `claude-config/justification.md` covering:

1. **Why** the flag is in use for this agent.
2. **Which roles / workflows** depend on it.
3. **Compensating controls** that protect the agent (deny baseline entries, restricted skills, narrow allows).

Block the hire if `dangerouslySkipPermissions: true` and `claude-config/justification.md` is missing or does not cover all three required points. Setting `dangerouslySkipPermissions: false` removes Gate 5b; the hire-request comment should note that choice explicitly.

#### 6b.3 Pre-submit validation (mandatory when gates are active)

Before sending `POST /api/companies/:companyId/agent-hires`:

1. Confirm `claude-config/settings.json` exists in the payload bundle for any local-adapter hire.
2. Confirm its `permissions.deny` is a superset of the company baseline (paste-compare with your governance baseline doc).
3. Confirm exactly one of (a) "applies baseline as-is" or (b) baseline-override reference is named in the hire-request comment.
4. If `dangerouslySkipPermissions: true`, confirm `claude-config/justification.md` exists and covers Why / Which / Compensating-controls.

If any check fails, **do not submit**. Fix the payload, re-run the checklist.

**To enable these gates for your company:** create `<governance-dir>/hire-flow-gates.md` and `<governance-dir>/claude-permissions-baseline.md` in your project's governance directory, then reference them from your agents' AGENTS.md files so the gates are enforced on every local-adapter hire.

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

- Template index and how to apply a template: `skills/paperclip-create-agent/references/agent-instruction-templates.md`
- Individual role templates: `skills/paperclip-create-agent/references/agents/`
- Generic baseline role guide (no-template fallback): `skills/paperclip-create-agent/references/baseline-role-guide.md`
- Pre-submit draft-review checklist: `skills/paperclip-create-agent/references/draft-review-checklist.md`
- Endpoint payload shapes and full examples: `skills/paperclip-create-agent/references/api-reference.md`
- Local-adapter hire governance gates (opt-in): `<governance-dir>/hire-flow-gates.md` in your company's governance directory
- Deny-baseline source-of-truth (Gate 5a): `<governance-dir>/claude-permissions-baseline.md`
