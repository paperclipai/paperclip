# Paperclip Team Setup Guide — Medicodio

> This document covers how to set up Paperclip on a new developer machine, what to commit to GitHub, what not to, why embedded Postgres is the right choice, and how parallel development works across the team.

---

## Table of Contents

1. [Architecture: What Lives Where](#1-architecture-what-lives-where)
2. [Why Embedded Postgres is the Right Choice](#2-why-embedded-postgres-is-the-right-choice)
3. [One-Time Setup: New Developer Onboarding](#3-one-time-setup-new-developer-onboarding)
4. [GitHub: What to Commit and What Not To](#4-github-what-to-commit-and-what-not-to)
5. [Parallel Development: How Two Devs Work Together](#5-parallel-development-how-two-devs-work-together)
6. [The sync-mcp.sh Script](#6-the-sync-mcpsh-script)
7. [Daily Workflow Cheatsheet](#7-daily-workflow-cheatsheet)
8. [Troubleshooting Common Issues](#8-troubleshooting-common-issues)

---

## 1. Architecture: What Lives Where

Understanding this split is the foundation of everything. There are three distinct layers, and confusing them is the source of all the problems we solved.

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1 — GitHub Repo (shared, version-controlled)     │
│                                                         │
│  agents/           instruction bundles (SOUL, AGENTS,   │
│                    HEARTBEAT, TOOLS, mcp.json)          │
│  skills/           SKILL.md files                       │
│  packages/         custom MCP server source code        │
│  .mcp.json         MCP server definitions (portable)    │
│  paperclip-templates/  company export JSON              │
│  scripts/          setup.sh, sync-mcp.sh                │
│  .env.example      documents required env vars          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  LAYER 2 — Each dev's ~/.paperclip/ (per-laptop)        │
│                                                         │
│  Paperclip runtime DB (embedded Postgres / PGlite)      │
│  Agent rows, company rows, org chart                    │
│  Heartbeat run history, transcripts, cost logs          │
│  Claimed API keys                                       │
│  instances/workspace/<id>/agents/<name>/mcp.json        │
│    → symlinked to repo via sync-mcp.sh                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  LAYER 3 — Shared remote Postgres (team data only)      │
│                                                         │
│  t_kb_icd_code_details  (Medicodio ICD knowledge base)  │
│  Any other shared application data                      │
│                                                         │
│  NOT Paperclip's runtime DB. Never mix these.           │
└─────────────────────────────────────────────────────────┘
```

**The golden rule:** If a value differs between two developers' laptops, it belongs in Layer 2 (local DB) or `.env`, never in a tracked file.

---

## 2. Why Embedded Postgres is the Right Choice

This is not a limitation — it is a deliberate architectural decision and the right one for Paperclip.

### Paperclip's DB is per-user runtime state, not shared team data

The Paperclip database stores things that are fundamentally per-laptop:

- Agent working directories (`/Users/soham/...` vs `/Users/jatin/...`)
- Heartbeat run history and transcripts
- Per-dev API keys and auth tokens
- Claimed task locks (which agent owns which ticket right now)
- Cost and token spend per agent per dev session

None of these should be shared. If two developers pointed at the same Paperclip DB:

- They would race on heartbeats — two laptops firing the same agent simultaneously, double-spending tokens, conflicting on task status
- Working directory paths would be wrong for one of them always
- Run transcripts and costs would be commingled with no way to separate them
- One dev restarting their Paperclip would affect the other

### What actually needs to be shared is in the repo, not the DB

The things you want all devs to share — agent roles, skills, org structure, instruction files — live in the GitHub repo and are synced via `git pull`, not via a shared database. The company template export is a one-time bootstrap mechanism, not an ongoing sync channel.

### Embedded Postgres (PGlite) gives each dev a zero-config local database

No dev needs to install, configure, or manage a local Postgres server. Paperclip handles it automatically inside `~/.paperclip/`. The only Postgres that needs external management is your Medicodio knowledge base (the ICD KB), which is application data, not Paperclip runtime state.

### Summary

| Database | Who owns it | What's in it | Shared? |
|---|---|---|---|
| `~/.paperclip/` embedded PGlite | Each dev's laptop | Paperclip runtime state | No — per laptop |
| Remote Postgres | Team | ICD KB, application data | Yes — shared |

---

## 3. One-Time Setup: New Developer Onboarding

Every new dev follows these steps exactly once per laptop.

### Step 1 — Clone the repo

```bash
git clone <your-org-fork-url>
cd paperclip   # or whatever your repo root is
```

### Step 2 — Set up environment variables

```bash
cp .env.example .env
# Open .env and fill in:
#   ANTHROPIC_API_KEY=...
#   BRAVE_API_KEY=...
#   DATABASE_URL=...   (your local Medicodio ICD KB connection)
#   PROJECT_ROOT=...   (absolute path to this repo on your machine)
```

If you use `direnv`, add `export PROJECT_ROOT=$(pwd)` to your `.envrc` so it loads automatically.

### Step 3 — Install dependencies and build internal MCP servers

```bash
pnpm install
pnpm -r --filter "./packages/mcp-*" build
npx playwright install chromium
```

### Step 4 — Start Paperclip and complete onboarding

```bash
npx paperclipai onboard --yes
```

This creates `~/.paperclip/` with a fresh embedded Postgres. When it asks you to create your first company, create a **throwaway company** (name it "temp" or "delete-me") — you need to get past the onboarding screen to access the import feature.

### Step 5 — Import the company template

Once inside the Paperclip dashboard:

1. Open the company switcher (top left or top right)
2. Select **Import Company**
3. Point it at `paperclip-templates/medicodio-org.json`
4. Delete the throwaway company after import

### Step 6 — Activate agents

The imported agents will be in `pending_approval` status. Either:

**Option A — Approve via UI:** Go to Approvals page in the sidebar → approve each agent.

**Option B — Approve via DB directly** (faster if many agents):

```bash
# Connect to embedded PGlite or run via Paperclip's API
# First get your company ID
psql $PAPERCLIP_DB_URL -c "SELECT id, name FROM companies;"

# Then activate all pending agents
psql $PAPERCLIP_DB_URL -c "
  UPDATE agents 
  SET status = 'active' 
  WHERE status = 'pending_approval' 
  AND company_id = '<your-company-id>';
"
```

### Step 7 — Run the MCP sync script

This symlinks each agent's `mcp.json` from the repo into `~/.paperclip/` where Paperclip expects to find it:

```bash
./scripts/sync-mcp.sh
```

### Step 8 — Fix agent working directories

In the Paperclip UI, go to each agent's settings and set the **Working Directory** to your local repo root:

```
/Users/yourname/path/to/your/repo
```

This is the one value that cannot be automated — it's always different per developer.

### Step 9 — Fix skill references (if needed)

If any agent's skill list contains `local/<hash>/...` or `company/<uuid>/...` references from the original dev, clean them up. In the agents table, the `adapter` JSONB column has a `paperclipSkillSync.desiredSkills` array. Replace any `local/` or `company/` references with their official `paperclipai/paperclip/` equivalents:

```sql
UPDATE agents
SET adapter = jsonb_set(
  adapter,
  '{paperclipSkillSync,desiredSkills}',
  '["paperclipai/paperclip/browser-automation",
    "paperclipai/paperclip/outlook",
    "paperclipai/paperclip/paperclip",
    "paperclipai/paperclip/paperclip-create-agent",
    "paperclipai/paperclip/paperclip-create-plugin",
    "paperclipai/paperclip/para-memory-files",
    "paperclipai/paperclip/sharepoint",
    "paperclipai/paperclip/web-research"]'::jsonb
)
WHERE company_id = '<your-company-id>';
```

### Step 10 — Test

Run a heartbeat on the CEO agent. If it completes without MCP errors or skill warnings, setup is complete.

---

## 4. GitHub: What to Commit and What Not To

### ✅ Commit these

```
agents/
├── ceo/
│   ├── SOUL.md               agent identity and personality
│   ├── AGENTS.md             agent instructions
│   ├── HEARTBEAT.md          what to do each heartbeat
│   ├── TOOLS.md              tool usage rules
│   └── mcp.json              MCP config for this agent (portable paths only)
├── coder/
├── qa/
└── ...

skills/
├── outlook/
│   └── SKILL.md
├── sharepoint/
│   └── SKILL.md
├── browser-automation/
│   └── SKILL.md
└── web-research/
    └── SKILL.md

packages/
├── mcp-sharepoint/
│   └── src/                  source only, not dist/
└── mcp-outlook/
    └── src/

paperclip-templates/
└── medicodio-org.json         company export, re-exported after major org changes

scripts/
├── setup.sh                  one-shot bootstrap script
└── sync-mcp.sh               symlinks mcp.json files into ~/.paperclip/

.mcp.json                      root MCP config using relative paths + env vars
.env.example                   documents all required env vars, no actual values
```

### ❌ Never commit these

```
.env                           contains real secrets
.paperclip/                    per-laptop runtime state, unique IDs, absolute paths
packages/*/dist/               compiled output, generated from source
node_modules/
*.log
```

### .gitignore (minimum required)

```gitignore
.env
.paperclip/
node_modules/
packages/*/dist/
*.log
```

### The absolute path rule

Run this check before every commit. If any of these return results, fix before pushing:

```bash
git grep -nE "/Users/|/home/[^/]+/|C:\\\\Users\\\\"
git grep -nE "postgres://.*@localhost"
```

Any hardcoded machine path in a tracked file will break another developer's setup.

---

## 5. Parallel Development: How Two Devs Work Together

### The mental model

Think of it like this:

- **The repo is the source of truth** for what agents are and how they behave
- **`~/.paperclip/` is a running process** — live state, per-laptop, never shared
- **Company template import is like `npm install`** — done once to bootstrap, not on every change

### Day-to-day scenarios

**Dev B improves an agent's instructions:**

```
Dev B edits agents/coder/SOUL.md or HEARTBEAT.md
Dev B commits and pushes
Dev A does git pull
→ Done. Dev A's next heartbeat picks up the new instructions automatically.
   No import, no DB change, no sync needed.
```

**Dev B adds a new MCP server:**

```
Dev B adds entry to .mcp.json (relative path, no absolute paths)
Dev B adds source to packages/mcp-newserver/
Dev B commits and pushes
Dev A does git pull
Dev A runs: pnpm -r --filter "./packages/mcp-newserver" build
Dev A runs: ./scripts/sync-mcp.sh
→ New MCP server available on Dev A's machine.
```

**Dev B creates a brand new agent type:**

```
Dev B creates agents/newagent/ with instruction files and mcp.json
Dev B adds agent to their Paperclip via UI
Dev B commits agents/newagent/ to repo
Dev B re-exports company template → commits paperclip-templates/medicodio-org.json

Dev A does git pull
Dev A adds the agent in their Paperclip UI (30 seconds) pointing at ./agents/newagent/
Dev A runs ./scripts/sync-mcp.sh
→ New agent available. No full re-import needed.
```

**Dev B changes company-level org structure (rare):**

```
Dev B makes org changes in their Paperclip UI
Dev B exports updated company template → commits it
Dev A does git pull
Dev A does a partial re-import (additive — existing agents preserved by ID)
→ Org changes reflected on Dev A's instance.
```

### What two devs should never do simultaneously

- Point at the same Paperclip DB — ever
- Run heartbeats for the same agent at the same time
- Commit `.paperclip/` or `.env`
- Commit `dist/` folders

### Two devs working on the same agent's instructions

This is just a normal git workflow. Both devs edit `agents/ceo/SOUL.md` in separate branches, open a PR, review, merge. The merged `SOUL.md` is what the agent runs on the next heartbeat on both machines after `git pull`. No special handling needed.

---

## 6. The sync-mcp.sh Script

Save this as `scripts/sync-mcp.sh` and make it executable (`chmod +x scripts/sync-mcp.sh`).

```bash
#!/usr/bin/env bash
set -euo pipefail

PAPERCLIP_DIR="$HOME/.paperclip"
WORKSPACE_DIR="$PAPERCLIP_DIR/instances/workspace"

# Find the workspace ID
if [ ! -d "$WORKSPACE_DIR" ]; then
  echo "Error: ~/.paperclip/instances/workspace not found."
  echo "Run 'npx paperclipai onboard' first."
  exit 1
fi

WORKSPACE_ID=$(ls "$WORKSPACE_DIR" | head -1)

if [ -z "$WORKSPACE_ID" ]; then
  echo "Error: No workspace ID found. Complete Paperclip onboarding first."
  exit 1
fi

AGENTS_TARGET="$WORKSPACE_DIR/$WORKSPACE_ID/agents"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Syncing MCP configs..."
echo "  Workspace: $WORKSPACE_ID"
echo "  Repo root: $REPO_ROOT"

for agent_dir in "$REPO_ROOT"/agents/*/; do
  agent_name=$(basename "$agent_dir")
  src="$agent_dir/mcp.json"
  dst="$AGENTS_TARGET/$agent_name/mcp.json"

  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    # Symlink so repo changes are immediately live in .paperclip
    ln -sf "$src" "$dst"
    echo "  linked: $agent_name/mcp.json"
  fi
done

echo ""
echo "Done. Re-run this script any time a new agent is added to the repo."
```

**Why symlinks instead of copying:** When you edit `agents/ceo/mcp.json` in the repo, the change is immediately live in `~/.paperclip/` — no need to re-run the script. The file is the same inode on disk.

---

## 7. Daily Workflow Cheatsheet

### Starting a new day

```bash
git pull
# If new packages were added:
pnpm install
pnpm -r --filter "./packages/mcp-*" build
# If new agents were added:
./scripts/sync-mcp.sh
# Start Paperclip
npx paperclipai dev
```

### Making changes to an agent

```bash
# Edit the instruction file directly in the repo
vim agents/ceo/HEARTBEAT.md

# Commit and push — no other steps needed
git add agents/ceo/HEARTBEAT.md
git commit -m "refine CEO heartbeat: tighten task delegation logic"
git push

# Your teammate just needs to git pull — no import, no sync
```

### Adding a new agent

```bash
# 1. Create instruction files in repo
mkdir -p agents/new-agent
touch agents/new-agent/{SOUL.md,AGENTS.md,HEARTBEAT.md,TOOLS.md,mcp.json}

# 2. Add agent in Paperclip UI → set working dir to repo root

# 3. Run sync
./scripts/sync-mcp.sh

# 4. Test heartbeat

# 5. Commit, push, re-export company template
git add agents/new-agent/
npx paperclipai company export > paperclip-templates/medicodio-org.json
git add paperclip-templates/medicodio-org.json
git commit -m "add new-agent to org"
git push
```

### Onboarding a new teammate (their steps)

```bash
git clone <repo>
cd <repo>
cp .env.example .env           # fill in keys
pnpm install
pnpm -r --filter "./packages/mcp-*" build
npx playwright install chromium
npx paperclipai onboard --yes
# In UI: create throwaway company → import paperclip-templates/medicodio-org.json
# In UI or DB: activate all pending agents
./scripts/sync-mcp.sh
# In UI: set working directory per agent to your local repo path
```

---

## 8. Troubleshooting Common Issues

### Heartbeat fails with "Invalid MCP configuration"

1. Check working directory is set to the **repo root**, not a subfolder like `server/`
2. Run the debug command from the repo root:
   ```bash
   cd <repo-root>
   claude --print - --output-format stream-json --verbose
   # type: Respond with hello
   ```
3. Check that `packages/mcp-*/dist/stdio.js` exists — run the build step if not

### Agent stuck in `pending_approval` after import

Turn off the approval toggle in Settings is not retroactive. Fix via DB:

```sql
UPDATE agents SET status = 'active'
WHERE status = 'pending_approval' AND company_id = '<id>';
```

### Skill "not available" errors in heartbeat output

Agent has `local/<hash>/...` or `company/<uuid>/...` skill references from another machine. Update the `adapter.paperclipSkillSync.desiredSkills` array in the agents table to use `paperclipai/paperclip/<skillname>` format only.

### PAPERCLIP_API_KEY not injected

Adapter type must be set to a `_local` variant (e.g. `claude_local`, not `claude`). Check agent adapter config in the UI.

### Another dev's absolute paths in a file I just pulled

Someone violated the no-absolute-paths rule. Find the offending file:

```bash
git grep -nE "/Users/|/home/[^/]+"
```

Replace with relative paths or env vars, commit the fix.

### sync-mcp.sh says "No workspace ID found"

You haven't completed Paperclip onboarding yet. Run `npx paperclipai onboard` first, create at least one company, then re-run the script.

---

*Last updated after full Medicodio Paperclip setup — April 2026*