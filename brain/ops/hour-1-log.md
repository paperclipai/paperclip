---
type: ops-log
title: Workshop Hour 1 setup log
tags: [workshop, setup, hour-1, 2026-04-22]
date: 2026-04-22
---

# Hour 1 — Workshop bootstrap log

Date: 2026-04-22
Operator: Janis Krums
Agent: Claude Code (opus-4-7)
Goal: Fork Paperclip → working control plane with Lobbi company + Hermes agent + MCP wired into Claude Code.

## Timeline

### Fork & clone
- Forked `paperclip-ai/paperclip` → `github.com/jkrums/workshop` (personal account, not Lobbi-Group org)
- Rationale: Workshop is personal infra that coordinates multiple companies; forking into an org would make the second tenant awkward.
- Cloned to `/Users/jkrums/workshop`

### Install & boot
- Node 24 already on PATH. pnpm not on PATH in current shell despite `.zshrc` edit — fixed per-command with `export PATH="$HOME/Library/pnpm:$PATH"`.
- `pnpm install` — clean, no warnings worth recording
- `pnpm dev` → server up at http://localhost:3100
- Embedded Postgres booted at `~/.paperclip/instances/default/db`, port 54330

### Onboarding wizard
- Created company **Lobbi** (UUID `5f8e4374-e127-4173-95cc-1125a73b5e6d`)
- Created agent **Hermes** with claude-code adapter (UUID `5a115338-72dd-4b7b-b1bf-b996937d1325`)
- Created smoke-test issue **LOB-1**
- Smoke test started and showed green in UI

### JWT / env fix
Initial run logged `local agent jwt secret missing or invalid` in the banner — smoke test ran but adapter callback couldn't authenticate to close the issue cleanly.

Traced `server/src/agent-auth-jwt.ts` → reads `PAPERCLIP_AGENT_JWT_SECRET` (falls back to `BETTER_AUTH_SECRET`) from `process.env`.

Traced `server/src/config.ts` + `server/src/paths.ts` + `server/src/home-paths.ts` → dotenv file location is `~/.paperclip/instances/default/.env`, NOT `~/.paperclip/.env`.

Fix:

```
openssl rand -hex 64 > /tmp/secret
# Write PAPERCLIP_AGENT_JWT_SECRET and BETTER_AUTH_SECRET (same value) to
# ~/.paperclip/instances/default/.env, then chmod 600.
```

Restart → banner flipped green: "Agent JWT: set." Smoke test re-ran. Hermes checked out LOB-1, ran via claude-code adapter, closed the issue. Janis confirmed: "Status is green. Everything is connecting."

### Process hygiene
First `pnpm dev:stop` left orphaned processes:
- Embedded Postgres PID 46925 holding port 54330 with stale `postmaster.pid` lock
- tsx watchers (PIDs 39078, 46856, 76916) from prior attempts

Cleaned with:

```
pkill -TERM -f "tsx@4.21.0.*watch"
pkill -TERM -f "embedded-postgres.*postgres -D"
rm -f ~/.paperclip/instances/default/db/postmaster.pid
```

File upstream as Paperclip bug: `dev:stop` should cascade to embedded Postgres and remove its lock file.

### API key + MCP wire
- Created per-agent API key in UI (Agent detail → API Keys → Create). Token displayed once; Janis saved it in 1Password.
- Wrote `/Users/jkrums/conductor/workspaces/lobbi/rabat-v3/.context/wire-paperclip-mcp.sh` — a one-shot script that:
  - Reads key from stdin (characters hidden)
  - Removes any existing `paperclip` MCP registration at local/project/user scope
  - Re-adds at **user scope** (`-s user`) with `PAPERCLIP_API_URL=http://localhost:3100` + `PAPERCLIP_API_KEY=<key>` env vars
  - Runs `claude mcp list` to confirm
  - Self-destructs on success
- First run used default `local` scope — mistake, since local is per-directory and Janis needs cross-workspace access. Fixed by updating script to `-s user` and re-running.

## End state

| Thing | Value |
|-------|-------|
| Fork | `github.com/jkrums/workshop` |
| Local server | http://localhost:3100 |
| Postgres | `~/.paperclip/instances/default/db` :54330 |
| Env file | `~/.paperclip/instances/default/.env` (600, gitignored, NOT committed) |
| Company | Lobbi — `5f8e4374-e127-4173-95cc-1125a73b5e6d` |
| Agent | Hermes (claude-code) — `5a115338-72dd-4b7b-b1bf-b996937d1325` |
| MCP scope | user (visible from every Conductor workspace) |
| Branch | `feat/workshop-bootstrap` |

## Bugs / papercuts to file upstream

1. `dev:stop` doesn't kill embedded Postgres or remove lock file → need to file issue on paperclip-ai/paperclip.
2. First-run docs don't mention `~/.paperclip/instances/default/.env` as the env location — they imply repo-local `.env`. Had to read `home-paths.ts` to discover. Doc PR candidate.

## Hour 2 handoff

Next Claude Code session should open a Conductor workspace on `jkrums/workshop`, pull branch `feat/workshop-bootstrap`, read `CLAUDE.md` + `brain/README.md`, and continue with:

1. Rerun MCP script at user scope if not already confirmed
2. Shallow rebrand PR (UI strings "Paperclip" → "Workshop" in titles, headers, sidebar)
3. Strip unused adapters (openclaw-gateway, gemini, opencode, pi, cursor)
4. Seed Tier 1 personas: Atlas (engineer) and Minerva (reviewer)
5. Write persona skill scaffolding under `skills/`
6. Port one routine — start with the daily morning briefing

Hour 3+: Fly.io deploy, Twilio SMS notifications, second-company scaffolding, CrabTrap security gateway.
