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

If you do not have this permission, keep the current task assigned to yourself
and identify the missing hiring authority. A CEO or manager title does not grant
hiring permission. Do not reassign the task or create an escalation task to bypass
the denial. Use the applicable approval flow when available; otherwise save a
human-input interaction on the current task with `resolverPolicy: "human_only"`
and `continuationPolicy: "wake_assignee"`, then leave it `in_review`. Use the
complete human-input payload in the `paperclip` skill; when the requesting user
owns the decision, address it with their actual `addresseeUserId`. A human answer
does not itself grant permission: recheck authorization before any hire.

## Workflow

### Choose the API transport

On **Paperclip Runner**, use the advertised Paperclip tools. Use `get_task_context`
and `list_agents` for identity and team context, then `search_api` to discover the
configuration, instruction-template, icon, and `agent-hires` endpoints used below.
Call the discovered operations with `call_api`; the server supplies company and
authentication context. Read the returned schemas before drafting the hire.

The shell examples below apply to adapters that receive `PAPERCLIP_API_URL` and
`PAPERCLIP_API_KEY`. Paperclip Runner does not supply those variables. Do not
search workspace files for a server address or credentials to recreate that path.
If `search_api` / `call_api` are unavailable, report that hiring requires the
operator to enable runner API tools for this company. Preserve the proposed hire
in the conversation; do not claim an agent was created or substitute a temporary
subagent for the requested permanent hire.

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

### 4. Describe the role

Use a short role paragraph for a new agent: its identity and the responsibility
it owns. The [role examples](references/agent-instruction-templates.md) are
optional starting points; for other roles, use the
[baseline role guide](references/baseline-role-guide.md).

Company-specific instructions supplied by the requester take precedence. Do not
expand a role description into a generic operating manual. The harness supplies
Paperclip coordination, skill discovery, and task lifecycle guidance; repository
instructions and installed skills carry applicable work procedures. Avoid
adding heartbeat pointers, execution contracts, mandatory per-touch comments,
fixed reviewer routes, or catalogs of domain concepts to the hire's instructions.

Keep reporting lines in `reportsTo`, capabilities in `capabilities`, and skills
in `desiredSkills`. Add instruction detail only for a concrete company or role
requirement that those fields, the task, repository instructions, or installed
skills do not already express.

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
- when supplying role instructions from step 4, send them as top-level `instructionsBundle.files["AGENTS.md"]` for managed-bundle adapters. Otherwise use the server default. Do not set `adapterConfig.promptTemplate` or `bootstrapPromptTemplate` for new agents.
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

- Optional role examples: `skills/paperclip-create-agent/references/agent-instruction-templates.md`
- Individual role templates: `skills/paperclip-create-agent/references/agents/`
- Short role drafting guide: `skills/paperclip-create-agent/references/baseline-role-guide.md`
- Pre-submit draft-review checklist: `skills/paperclip-create-agent/references/draft-review-checklist.md`
- Endpoint payload shapes and full examples: `skills/paperclip-create-agent/references/api-reference.md`

## Harness and runner selection

Choose the underlying harness in `adapterType` (for example `codex_local` or
`claude_local`). New agents automatically use Paperclip Runner for qualified
Codex, Claude Code, OpenCode, Grok Build, and Cursor configurations. Unsupported
harnesses keep their legacy adapter. The saved response may therefore have
`adapterType: paperclip_runner`; use that returned configuration for later reads.

The optional creation field `runner` accepts `auto`, `paperclip`, or `legacy`.
Use `legacy` only when explicitly needed for custom CLI configuration. Native
setup errors do not silently fall back. Existing agents keep their saved runner
when edited. The dedicated `hire_agent` tool still inherits the caller's native
runtime and does not accept caller-supplied runtime or credential overrides.
