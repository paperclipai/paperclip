# Switching agents from Claude Code to Codex

End-to-end checklist for migrating a Paperclip company's agents from the
`claude_local` adapter to the `codex_local` adapter. Covers signup, CLI
install, authentication, three execution paths (UI / API / "ask an agent
to do it"), and the field-by-field translation needed for an exact
functional match.

> Validated 2026-05-20 on the Harper Content company (9 agents: CEO,
> CMO, CTO, Content Creator, Graphics Creator, QA Engineer, Release
> Engineer, Researcher, Staff Engineer). Documented gotchas were all
> hit during that migration.

---

## 1. Prerequisites

### 1.1 Subscribe to a Codex-eligible OpenAI plan

The `codex` CLI uses your **ChatGPT** account login (not raw API keys) to
run sessions. You need an active ChatGPT plan that includes Codex
agent access:

- **Pricing & plans:** https://openai.com/chatgpt/pricing/
- **Plus** ($20/mo) and **Pro** ($200/mo) both include Codex use; Pro
  unlocks the higher rate limits agents actually need under load.
- **Business / Enterprise:** https://openai.com/business/

Sign up, sign in to https://chatgpt.com, and verify your plan is active
under **Settings → Subscription** before proceeding.

> Alternative path: an OpenAI **API key** (https://platform.openai.com/api-keys)
> works too — codex reads `OPENAI_API_KEY` from the environment and bills
> per-token instead of via your ChatGPT plan. The ChatGPT plan route is
> usually cheaper for heartbeat-style workloads.

### 1.2 Verify Paperclip is on a build with the fork patches

This fork (`harperaa/paperclip`) carries three codex-required patches
that upstream hasn't merged yet. They're already on `master` and
`steel-paperclip`:

| Carry | Commit | What it does |
|---|---|---|
| `--skip-git-repo-check` always-on | `79f2be66` | Bypasses codex's "not inside a trusted directory" abort — Paperclip workspace dirs are paperclip-managed, not git repos |
| `gpt-5.5` in model catalog + fast-mode allowlist | `304af710` | Lets you select `gpt-5.5` from the UI dropdown and honors `fastMode` |
| DrizzleQueryError unwrap in unique-violation predicates | `5691c80a` | Lets `POST /api/companies` retry past 3-letter prefix collisions (also affects plugins, routines) |

If you're on the fork's `steel-paperclip` distribution, you already have
all three. Confirm with:

```bash
git -C <paperclip-repo> log --oneline | grep -E "skip-git-repo-check|gpt-5.5|drizzle-unwrap" | head
```

---

## 2. Install the codex CLI

```bash
npm install -g @openai/codex
codex --version          # should print codex-cli 0.132.x or newer
which codex              # confirm it landed somewhere on PATH (e.g. /usr/local/bin/codex)
```

> If `pnpm dev` was running when you installed, restart it. The server
> captures `PATH` at spawn time — newly-installed binaries aren't visible
> to a server that booted before the install. The fork's
> [`server/src/index.ts`](../server/src/index.ts) refuses to adopt
> orphan postmasters on the wrong port, so you can `Ctrl+C` cleanly and
> re-`pnpm dev` without lock-file gymnastics.

---

## 3. Authenticate codex

```bash
codex login              # opens the browser; sign in with your ChatGPT account
codex doctor             # confirms creds + config + runtime health
```

`codex login` writes credentials to `~/.codex/`. Paperclip **seeds each
company's codex-home from `~/.codex` on first use** (per
`server/src/services/heartbeat.ts` — the per-company managed
codex-home lives at
`~/.paperclip/instances/<id>/companies/<companyId>/codex-home/`). If you
log in *after* a company has already attempted a codex run, you need to
nuke that company's stale seed so the next run re-seeds from your fresh
credentials:

```bash
rm -rf "~/.paperclip/instances/default/companies/<companyId>/codex-home"
```

New companies created after `codex login` pick up the credentials
automatically.

---

## 4. Migrate the agents

Pick one of the three paths below. They produce the same DB state; they
differ in audit/parallelism trade-offs.

### Path A — UI, per agent

Lowest risk, slowest. Good for small companies (1–3 agents) or
sanity-checking the first migration before scripting the rest.

For each agent:

1. Open the agent's detail page (sidebar → click the agent).
2. **Configuration** tab → **Adapter** dropdown → change `Claude (local)` → `Codex (local)`.
3. **Model** dropdown → pick `gpt-5.5` (or `gpt-5.4` / `gpt-5.3-codex` if
   you want a specific lane).
4. Toggle **"Dangerously bypass approvals and sandbox"** ON if the agent
   was previously running with claude's `dangerouslySkipPermissions: true`
   (the same intent — auto-approve every shell exec).
5. **Save**.
6. Repeat for each agent.

Activity log gets one `agent.updated` entry per agent. Heartbeat sessions
reset on next run (claude-side session IDs are no longer relevant).

### Path B — API, scripted

Recommended for >3 agents. Runs through the same `agentService.update()`
code path the UI uses, so activity log + in-memory invalidations fire
correctly.

The Paperclip API runs on port **3101** locally (per
`feedback_api_port.md`).

```bash
# List the agents you want to migrate, e.g. by company id:
COMPANY_ID="<company-uuid>"
psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tAc "
  SELECT id || '|' || name FROM agents WHERE company_id = '$COMPANY_ID';
" > /tmp/agents.tsv

# Migrate each:
while IFS='|' read -r AGENT_ID AGENT_NAME; do
  echo -n "$AGENT_NAME: "
  # Pull the agent's prior desiredSkills from the activity log
  DESIRED=$(psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -tAc "
    SELECT details->'desiredSkills'
    FROM activity_log
    WHERE entity_id::text = '$AGENT_ID' AND action = 'agent.skills_synced'
    ORDER BY created_at DESC LIMIT 1;
  ")
  [ -z "$DESIRED" ] && DESIRED="[]"

  curl -s -X PATCH "http://127.0.0.1:3101/api/agents/$AGENT_ID" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json
desired = json.loads('''$DESIRED''')
print(json.dumps({
  'adapterType': 'codex_local',
  'adapterConfig': {
    'cwd': '<workspace-cwd-or-omit>',
    'model': 'gpt-5.5',
    'search': False,
    'fastMode': False,
    'graceSec': 15,
    'timeoutSec': 0,
    'instructionsBundleMode': 'managed',
    'instructionsEntryFile': 'AGENTS.md',
    'instructionsFilePath': f'/Users/<you>/.paperclip/instances/default/companies/$COMPANY_ID/agents/$AGENT_ID/instructions/AGENTS.md',
    'instructionsRootPath':  f'/Users/<you>/.paperclip/instances/default/companies/$COMPANY_ID/agents/$AGENT_ID/instructions',
    'paperclipSkillSync': { 'desiredSkills': desired },
    'dangerouslyBypassApprovalsAndSandbox': True,
    'env': {}
  }
}))
")" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('adapterConfig',{}); print(f\"ok model={c.get('model')} skills={len(c.get('paperclipSkillSync',{}).get('desiredSkills',[]))}\")"
done < /tmp/agents.tsv
```

The script above:

1. Pulls each agent's **prior `desiredSkills` list from the activity log**
   (you only have one shot to grab this — `PATCH /api/agents/:id` with a
   replacement `adapterConfig` overwrites the old config in place; the
   prior values are not stored anywhere else queryable).
2. Sends the field-by-field translated config (see §5 for the mapping
   rationale).

> Replace `<workspace-cwd-or-omit>` with the agent's prior `cwd` if it
> had one. If not set, omit the field — Paperclip falls back to the
> per-agent managed workspace under
> `~/.paperclip/instances/default/workspaces/<agent-id>/`.

### Path C — Have an agent migrate itself

Useful if your CEO agent is configured with platform admin tools and you
want to keep it in the loop. Send the CEO a comment / issue with this
prompt:

> Migrate this company's agents from `claude_local` to `codex_local`.
>
> For each agent in the company (call `GET /api/companies/<COMPANY_ID>/agents`),
> issue a `PATCH /api/agents/<agentId>` with the body shape documented in
> `doc/SWITCHING-CLAUDE-TO-CODEX.md` §4 Path B. Preserve every prior
> field (`cwd`, `graceSec`, `timeoutSec`, `env`, all `instructions*`
> paths). For the new fields:
>
> - `adapterType`: `"codex_local"`
> - `adapterConfig.model`: `"gpt-5.5"`
> - `adapterConfig.search`: `false`
> - `adapterConfig.fastMode`: `false`
> - `adapterConfig.dangerouslyBypassApprovalsAndSandbox`: same boolean
>   as the prior `dangerouslySkipPermissions` (use `true` if the prior
>   claude config had it `true`, else `false`).
>
> Critically, you **must** recover each agent's prior
> `paperclipSkillSync.desiredSkills` from the activity log
> (`GET /api/companies/<COMPANY_ID>/activity?agentId=<agentId>&action=agent.skills_synced&limit=1`)
> and include it in the new `adapterConfig.paperclipSkillSync.desiredSkills`.
> Dropping that list silently un-enrolls the agent from every skill it
> had opted into.
>
> After every PATCH succeeds, post a comment on this ticket listing
> migrated agents with their new model. If any agent is in `status:
> error`, also `PATCH /api/agents/<agentId>` with `{"status": "idle"}`
> so the scheduler picks it back up.
>
> Do **not** touch agents whose `adapterType` is not `claude_local`. Do
> **not** modify routines, projects, or company config.

Risks: an agent doing this needs `agents.update` permission and access
to the activity-log endpoint. Has the advantage of putting a full audit
trail in the ticket comments.

---

## 5. Field-by-field translation (claude → codex)

| `claude_local` field | `codex_local` equivalent | Notes |
|---|---|---|
| `cwd` | `cwd` | Keep verbatim — both adapters honor it as the agent process working directory |
| `env` | `env` | Keep verbatim |
| `model: "claude-sonnet-4-6"` | `model: "gpt-5.5"` | Pick from `gpt-5.5` / `gpt-5.4` / `gpt-5.3-codex` / `gpt-5.3-codex-spark` (the "cheap" lane) |
| `graceSec`, `timeoutSec` | same names | Keep verbatim |
| `instructionsFilePath`, `instructionsRootPath`, `instructionsEntryFile`, `instructionsBundleMode` | same names | Keep verbatim — the managed AGENTS.md path is shared semantics |
| `dangerouslySkipPermissions: true` | `dangerouslyBypassApprovalsAndSandbox: true` | Semantic equivalent ("auto-approve every shell exec"). The fork's `security/codex-safe-default` backport defaults this to `false`; flip to `true` only if the prior claude config had `dangerouslySkipPermissions: true` |
| `maxTurnsPerRun: 1000` | *(no equivalent — drop)* | Codex sessions don't expose a per-run turn cap in `adapter_config` |
| `paperclipSkillSync.desiredSkills: […]` | **same field name, same shape** | **Critical — must carry over.** `resolvePaperclipDesiredSkillNames` reads this field; without it the agent loads only `required`-tagged skills (typically a small subset) |
| — *(new in codex)* | `search: false` | Required field; set to `false` unless you want codex run with `--search` |
| — *(new in codex)* | `fastMode: false` | Required field; only effective on `gpt-5.4` / `gpt-5.5` / manual model IDs |

### 5.1 Gotcha: per-agent `desiredSkills` recovery

The single most common mistake is dropping `paperclipSkillSync.desiredSkills`
during the PATCH. If you've already PATCH'd and forgot the list, recover
from the activity log:

```sql
-- Per agent
SELECT details->'desiredSkills'
FROM activity_log
WHERE entity_id::text = '<agent-id>' AND action = 'agent.skills_synced'
ORDER BY created_at DESC LIMIT 1;
```

Every `agent.skills_synced` event includes the full `desiredSkills` array
that was in effect at that moment. Use the most recent one *before* the
migration PATCH.

### 5.2 Gotcha: `CLAUDE.md` at the workspace cwd

Claude Code auto-loads `CLAUDE.md` from cwd. **Codex auto-loads
`AGENTS.md` instead.** If your workspace cwd has a `CLAUDE.md` (e.g.
seeded by a plugin or by hand), codex agents will silently miss it.

Fix at the workspace dir:

```bash
cd "<workspace-cwd>"
[ -f CLAUDE.md ] && [ ! -e AGENTS.md ] && ln -s CLAUDE.md AGENTS.md
```

The `harper-cmo` plugin's `scripts/install.ts` does this automatically
on every install (commit `57096e9`). If you use a different plugin or
seed CLAUDE.md manually, repeat the symlink at each workspace cwd.

---

## 6. Verify the migration

After a heartbeat tick on each migrated agent (≤ 30s or trigger one
manually with `POST /api/agents/<id>/heartbeat/invoke`):

```sql
-- Confirm adapter type + model
SELECT name, status, adapter_type, adapter_config->>'model' AS model
FROM agents WHERE company_id = '<COMPANY_ID>'
ORDER BY name;

-- Confirm desiredSkills survived
SELECT name, jsonb_array_length(adapter_config->'paperclipSkillSync'->'desiredSkills') AS skill_count
FROM agents WHERE company_id = '<COMPANY_ID>'
ORDER BY name;

-- Confirm the actual command codex was invoked with (after a heartbeat)
SELECT a.name, e.payload->'commandArgs' AS args
FROM heartbeat_run_events e
JOIN agents a ON a.id = e.agent_id
WHERE a.company_id = '<COMPANY_ID>'
  AND e.event_type = 'adapter.invoke'
  AND e.created_at > now() - interval '5 minutes'
ORDER BY e.created_at DESC LIMIT 5;
```

A healthy codex invocation looks like:

```json
["exec", "--json", "--skip-git-repo-check",
 "--dangerously-bypass-approvals-and-sandbox",
 "--model", "gpt-5.5", "-"]
```

(Or with `"resume", "<session-id>", "-"` instead of just `-` for
session-continuation runs.)

---

## 7. Clearing the `error` status

Agents that hit a heartbeat failure during the migration window will end
up in `status: error`. The scheduler won't dispatch new work to them
until the status clears. Two ways out:

**(a) UI:** Open the agent → top-right toolbar → **"Run Heartbeat"**
(the play-arrow button). This fires an on-demand run that bypasses the
scheduler's "skip error agents" gate. If the run succeeds, status flips
to `idle` automatically.

**(b) DB:**

```sql
UPDATE agents
  SET status = 'idle', pause_reason = NULL, paused_at = NULL, updated_at = now()
WHERE id IN ('<agent-id>', '<agent-id>');
```

---

## 8. Known recoveries (things that went wrong on 2026-05-20)

| Symptom | Cause | Fix |
|---|---|---|
| `Command not found in PATH: "codex"` | `pnpm dev` started before `codex` was installed | Restart `pnpm dev` so it picks up the new PATH |
| `Not inside a trusted directory and --skip-git-repo-check was not specified.` | The agent's workspace cwd isn't a git repo *and* isn't in codex's trust config | Already fixed by the fork's `79f2be66` carry (`--skip-git-repo-check` always passed) — confirm the carry is present |
| `HTTP 401 Unauthorized` from `api.openai.com/v1/responses` | Codex creds not present in the per-company managed codex-home | `codex login` once globally, then `rm -rf ~/.paperclip/instances/default/companies/<companyId>/codex-home` to force a re-seed |
| Agent runs but ignores skills | `paperclipSkillSync.desiredSkills` dropped during PATCH | Recover from activity log per §5.1, re-PATCH |
| Agent runs but ignores `CLAUDE.md` guidelines | Codex doesn't read `CLAUDE.md`, only `AGENTS.md` | Symlink per §5.2; for harper-cmo, re-run `paperclipai plugin install packages/plugins/harper-cmo` |
| Migration looks complete but new heartbeats never tick | Agent stuck in `status: error` from a prior claude failure | §7 |

---

## 9. Rollback

The migration is one-way at the field level (we don't preserve the
prior claude config when overwriting). To roll a single agent back to
claude:

1. Pull the prior config from the most recent `agent.skills_synced`
   activity log event (only the `desiredSkills` field is recoverable
   that way) — the rest of the prior claude `adapter_config`
   (`cwd`, `model`, `dangerouslySkipPermissions`, etc.) is **not**
   recoverable from any DB table.
2. Re-construct it manually from a sibling agent on the same company
   that hasn't been migrated, or from an older claude_local agent on
   another company.
3. `PATCH /api/agents/<id>` with `adapterType: "claude_local"` and the
   reconstructed config.

The safer rollback strategy is **don't migrate the whole company at
once** — start with one agent (e.g. a non-CEO test agent), verify a
heartbeat completes successfully under codex, then migrate the rest.

---

## See also

- `feedback_no_server_changes.md` — when changing the fork patches
- `feedback_check_upstream_before_filing.md` — before opening a PR
- `feedback_commit_before_release.md` — before building a release zip
- `project_security_backports.md` — codex-safe-default backport rationale
