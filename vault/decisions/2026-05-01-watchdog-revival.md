---
date: 2026-05-01
author: vardaan + claude
type: decision
status: locked
---

# Watchdog revival + cron de-duplication — root-cause fixes

## What was broken (2026-05-01 morning)

1. **Watchdog dead** — `runs=1139, last exit code = 78 (EX_CONFIG)`. macOS TCC denies launchd's `/bin/bash` access to `~/Documents/`. Even after the bash script existed, launchd couldn't exec it.
2. **Cost circuit-breaker offline** — same issue. 19 hours without cost runaway protection.
3. **Langfuse-web restart loop** — ClickHouse migration assumed clustered topology with Zookeeper; container is single-node.
4. **CEO routine duplication** — two parallel sets of CEO routines (TitleCase + kebab-case) firing the same cron schedule. Created KOEA-305 + KOEA-306 (today's EOD digest dupes).

## What we did

### 1. Relocated watchdog to escape ~/Documents TCC guard
- Runtime now at `~/Library/Application Support/koenig-watchdog/`:
  - `start-watchdog.sh` (uses `RUNTIME_DIR` resolved from `$0`, sources local `.env.koenig`)
  - `watchdog.mjs` (synced from repo, but the runtime is the live copy)
  - `.env.koenig` (local copy with the new watchdog-bot token)
  - `.state/` (per-agent crash-loop state)
- launchd plist (`~/Library/LaunchAgents/com.koenig.watchdog.plist`) updated to point at new path
- Logs at `~/Library/Logs/koenig/watchdog.{out,err}.log`
- **Repo source-of-truth stays in `koenig-ai-org/watchdog/`**. Sync procedure: when `watchdog.mjs` changes, copy to runtime location and `launchctl kickstart -k`. Future improvement: a one-line `make sync-watchdog` target.

### 2. Minted a watchdog-bot agent with cross-agent permissions
- POST `/api/companies/{id}/agents` — created `Watchdog Bot` agent (id `55ec4a3a-…`), role=`devops`, reports to CEO
- POST `/api/agents/{id}/keys` — minted API key (`pcp_…`) — replaces stale Chief-Engineering JWT in `.env.koenig`
- DB: `INSERT INTO principal_permission_grants (…)` — granted `agents:create` permission so the watchdog can PATCH cross-agent (the missing piece that made the old token return 403)
- Set `WATCHDOG_SELF_AGENT_ID=55ec4a3a-…` so the watchdog never pauses itself

### 3. Made watchdog code 403-tolerant + langfuse-fixed
- `watchdog.mjs` now: appends to `vault/_audit/cost-alerts.log`, posts Telegram alert, soft-flags `metadata.circuit_breaker_requested_at` if PATCH returns 403. Per-agent throttle prevents alert-spam. Self-pause guard via `WATCHDOG_SELF_AGENT_ID`.
- Langfuse fixed: `CLICKHOUSE_CLUSTER_ENABLED=false` + `CLICKHOUSE_MIGRATION_SSL=false` + quoted 64-hex `ENCRYPTION_KEY`. Both web + worker `Up`.

### 4. Killed duplicate CEO routines (the real root cause of the duplicate-ticket cluster)
- DB had 6 active CEO routines, not 3. Two parallel sets:
  - TitleCase: `CEO Daily Triage`, `CEO EOD Digest`, `CEO Weekly Retrospective`
  - kebab-case: `CEO daily-triage`, `CEO eod-digest`, `CEO weekly-retrospective`
- Both sets fired at the same cron times → 2× tickets per cycle.
- **TitleCase set cancelled** (`status='cancelled'`, all triggers `enabled=false`). Stale `30 1 * * *` extra trigger removed.
- Verified no other agent has duplicate routines.

## Why this happened

Two seed-time scripts created the same routines twice with slightly different naming conventions. No deduplication contract on routine creation. Same anti-pattern that drives the Claude Security Beta cluster (no sibling-check before child-ticket fan-out — fix: `check-sibling-tickets` skill landed earlier today).

## Live state after fixes

- Watchdog: `state=running, runs=1, polling 27 agents, last exit code = (never exited)`
- Langfuse: web + worker `Up`
- CEO routines: 3 active (one per real schedule), 3 cancelled
- Cost circuit-breaker: live, soft-escalates via Telegram + audit log

## Open follow-ups

- Image-gen skill rewrite (8 bugs surfaced today; sub-agent in flight)
- Blog-author model decision: keep GLM 5.1, or swap to Haiku 4.5 / Grok 4.2 (xAI is out-of-V1-scope risk; needs OPENROUTER_API_KEY uncommented for live bake-off)
- Sync OPENROUTER_API_KEY into `.env.koenig` (currently placeholder; OpenCode CLI has its own credentials so production agents work, but ad-hoc test scripts can't)
- Make repo `watchdog/start-watchdog.sh` mirror the new runtime contract (currently uses old `REPO/..` resolution; runtime copy uses `RUNTIME_DIR/$0`)
- One-line `make sync-watchdog` target to keep the runtime copy aligned with repo edits
