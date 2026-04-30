# Secrets Checklist — One-Sitting Setup

> Generated 2026-04-30 after R5 MCP wiring lands. After re-import (R6), Paperclip prompts you for the secrets below. Type each value once → encrypted in `~/.paperclip` Postgres.

## Where you enter values

After running:

```bash
pnpm paperclipai company import companies/learnova-academy \
  --target existing \
  --company-id 1ce472ae-c3fe-47cb-ae1c-99cd79a43b8d \
  --collision skip --yes
```

Paperclip's UI at **http://localhost:3100** will surface a "secrets needed" panel for each agent. Click into each agent → fill the required fields. Or use the global secrets pane.

## Per-secret table

| Secret | Required by | Where to get it | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | All `opencode_local` agents (5 researchers + content-author) | https://openrouter.ai/keys | ✅ ALREADY SET 2026-04-29 in `~/.local/share/opencode/auth.json` — no action |
| `TAVILY_API_KEY` | All 4 researchers + content-author (optional) | https://app.tavily.com (free tier 1000 calls/mo) | Required — free tier is enough for V1 |
| `XAI_API_KEY` | researcher-anthropic (optional) + researcher-community (required) | https://console.x.ai | Only researcher-community NEEDS it (heavy x_search); others optional |
| `RESEND_API_KEY` | ceo (G4 approval emails) | https://resend.com/api-keys (free tier 3k emails/mo) | Required |
| `GH_TOKEN` | chief-engineering, planner, executor, code-reviewer (+ ceo optional) | https://github.com/settings/tokens (fine-grained PAT, repo scope) | Required for engineering harness; scope to `Koenig-Solutions-Private-Limited/learnovaBeast` + `koenig-ai-org` |
| `ACADEMY_AGENT_API_KEY` | content-author (Convex HTTP action auth) | NOT YET PROVISIONED — comes from R8 backend | Required AFTER R8 backend lands; can leave blank for V1 |
| `OPENAI_API_KEY` (Codex CLI) | code-reviewer | `codex auth login` (uses your ChatGPT subscription quota) | Login via terminal; not entered in Paperclip UI |

## Step-by-step (5-min sitting)

1. Open Paperclip UI: http://localhost:3100
2. Navigate to **Koenig AI Academy** (company id `1ce472ae-c3fe-47cb-ae1c-99cd79a43b8d`)
3. Click **Secrets** tab
4. For each row in the table above, paste the value
5. Click **Save** on each
6. Confirm the agent's "needs secret" badges clear

## Verification

After saving:
```bash
curl -s http://localhost:3100/api/companies/1ce472ae-c3fe-47cb-ae1c-99cd79a43b8d/agents \
  | python3 -c "import json,sys; data=json.load(sys.stdin); [print(a['name'], 'pause:', a.get('pauseReason') or 'OK') for a in data]"
```

Every agent should show `OK`. Anything paused = secret still missing.

## What changed in R5 (FYI for the curious)

- Added `cwd: /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org` to every agent's adapter config so Claude Code + OpenCode + Codex see the project's `.mcp.json` / `opencode.json`
- Created `.mcp.json` at repo root wiring 4 MCP servers (filesystem, github, tavily, fetch)
- Created `opencode.json` at repo root wiring the same 4 servers for OpenCode-driven agents
- Path discipline (which vault folder each agent writes to) enforced via SOUL/skill instructions, not at the MCP layer

## After secrets are set

Run R6 — smoke-test the new cohort by triggering one researcher → verify vault file lands on disk → trigger Research Editor → trigger CEO daily-triage → trigger engineering harness on a tiny ticket.
