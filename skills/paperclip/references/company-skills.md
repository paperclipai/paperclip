# Company Skills Workflow

Use this reference when a board user, CEO, or manager asks you to find, install, update, repair, propagate, or prove a company skill or SOP, or assign it to an agent.

## What Exists

- Company skill library: install, inspect, update, and read imported skills for the whole company.
- Agent skill assignment: add or remove company skills on an existing agent.
- Hire/create composition: pass `desiredSkills` when creating or hiring an agent so the same assignment model applies immediately.

The canonical model is:

1. install the skill into the company
2. assign the company skill to the agent
3. optionally do step 2 during hire/create with `desiredSkills`

## Permission Model

- Company skill reads: any same-company actor
- Company skill mutations: board, CEO, or an agent with the effective `agents:create` capability
- Agent skill assignment: same permission model as updating that agent

## Core Endpoints

- `GET /api/companies/:companyId/skills`
- `POST /api/companies/:companyId/skills/refresh`
- `GET /api/companies/:companyId/skills/:skillId`
- `GET /api/companies/:companyId/skills/:skillId/files?path=SKILL.md`
- `PATCH /api/companies/:companyId/skills/:skillId/files`
- `POST /api/companies/:companyId/skills/import`
- `POST /api/companies/:companyId/skills/scan-projects`
- `POST /api/companies/:companyId/skills/:skillId/install-update`
- `GET /api/agents/:agentId/skills`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`

## Install A Skill Into The Company

Import using a **skills.sh URL**, a key-style source string, a GitHub URL, or a local path.

### Source types (in order of preference)

| Source format | Example | When to use |
|---|---|---|
| **skills.sh URL** | `https://skills.sh/google-labs-code/stitch-skills/design-md` | When a user gives you a `skills.sh` link. This is the managed skill registry — **always prefer it when available**. |
| **Key-style string** | `google-labs-code/stitch-skills/design-md` | Shorthand for the same skill — `org/repo/skill-name` format. Equivalent to the skills.sh URL. |
| **GitHub URL** | `https://github.com/vercel-labs/agent-browser` | When the skill is in a GitHub repo but not on skills.sh. |
| **Local path** | `/abs/path/to/skill-dir` | When the skill is on disk (dev/testing only). |

**Critical:** If a user gives you a `https://skills.sh/...` URL, use that URL or its key-style equivalent (`org/repo/skill-name`) as the `source`. Do **not** convert it to a GitHub URL — skills.sh is the managed registry and the source of truth for versioning, discovery, and updates.

### Example: skills.sh import (preferred)

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://skills.sh/google-labs-code/stitch-skills/design-md"
  }'
```

Or equivalently using the key-style string:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "google-labs-code/stitch-skills/design-md"
  }'
```

### Example: GitHub import

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/import" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "https://github.com/vercel-labs/agent-browser"
  }'
```

You can also use source strings such as:

- `google-labs-code/stitch-skills/design-md`
- `vercel-labs/agent-browser/agent-browser`
- `npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser`

If the task is to discover skills from the company project workspaces first:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/scan-projects" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Inspect What Was Installed

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Read the skill entry and its `SKILL.md`:

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>/files?path=SKILL.md" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Before editing, inspect the detail response for `key`, `sourceType`, `editable`, `editableReason`, `sourcePath`, `fileInventory`, and `usedByAgents`. Resolve the existing skill by its responsibility and contents; do not create a duplicate merely because the newest request uses different wording.

## Update An Existing Company SOP Or Skill

An explicit instruction from the board or an authorized manager to update/fix/add a company SOP is an implementation directive unless they asked for discussion or planning only.

1. List and inspect the installed skills as shown above.
2. Read every affected `SKILL.md` and any referenced file needed for the procedure.
3. Confirm `editable: true`. Only `local_path` company skills can be edited in place. Bundled Paperclip, skills.sh, GitHub, and URL sources are read-only in the company library; update their real source or use an explicitly approved local replacement.
4. Patch the canonical file through the API. Do not edit an agent's `$CODEX_HOME/skills` entry, adapter staging directory, or the managed `__runtime__` copy.

Encode multiline content from a file so markdown is preserved:

```sh
jq -n \
  --arg path "SKILL.md" \
  --rawfile content /tmp/edited-SKILL.md \
  '{path: $path, content: $content}' \
| curl -sS -X PATCH \
    "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/<skill-id>/files" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary @-
```

5. Read the file back through `GET .../files?path=SKILL.md` and verify the returned content, parsed name/description, and `updatedAt` rather than trusting the write response alone.
6. Refresh the content-aware inventory after filesystem/source edits or when immediate propagation proof is required:

```sh
curl -sS -X POST \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/skills/refresh" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

7. Verify propagation. Use `usedByAgents` from skill detail plus `GET /api/agents/:agentId/skills`; sync only when an intended agent is missing the canonical key. On a subsequent heartbeat, use `paperclipSkillTelemetry` as preparation evidence. Do not claim a skill was invoked solely because it was available or prepared.

Completion evidence must name the exact skill key/id and edited file, show the binding diff or revision, record validation/read-back results, and inventory every affected agent assignment. A plan, TRD, wiki entry, issue comment, repository adapter, or runtime-copy edit is not proof that the SOP changed.

## Assign Skills To An Existing Agent

`desiredSkills` accepts:

- exact company skill key
- exact company skill id
- exact slug when it is unique in the company

The server persists canonical company skill keys.

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills/sync" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "desiredSkills": [
      "vercel-labs/agent-browser/agent-browser"
    ]
  }'
```

If you need the current state first:

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/<agent-id>/skills" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Include Skills During Hire Or Create

Use the same company skill keys or references in `desiredSkills` when hiring or creating an agent:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

For direct create without approval:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "QA Browser Agent",
    "role": "qa",
    "adapterType": "codex_local",
    "adapterConfig": {
      "cwd": "/abs/path/to/repo"
    },
    "desiredSkills": [
      "agent-browser"
    ]
  }'
```

## Notes

- Built-in Paperclip runtime skills are still added automatically when required by the adapter.
- Normal inventory reads use a short bounded cache and content fingerprint so repeated heartbeats do not rescan and rewrite every bundled skill. After changing skill files on disk, an authorized operator can call `POST /api/companies/:companyId/skills/refresh` for an immediate content-aware refresh.
- Heartbeat run context records `paperclipSkillTelemetry` with distinct `requestedKeys`, effective `desiredKeys`, inventory `availableKeys`, and the available `preparedKeys` intersection. `unavailableDesiredKeys` stays visible. This pre-adapter telemetry does not claim a skill was activated or invoked.
- If a reference is missing or ambiguous, the API returns `422`.
- Prefer linking back to the relevant issue, approval, and agent when you comment about skill changes.
- Use company portability routes when you need whole-package import/export, not just a skill:
  - `POST /api/companies/:companyId/imports/preview`
  - `POST /api/companies/:companyId/imports/apply`
  - `POST /api/companies/:companyId/exports/preview`
  - `POST /api/companies/:companyId/exports`
- Use skill-only import when the task is specifically to add a skill to the company library without importing the surrounding company/team/package structure.
