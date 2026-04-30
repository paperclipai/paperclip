# Runbook — koenig-ai-org

What to do when X breaks.

## Daily smoke test

```bash
# Paperclip alive?
curl -s http://localhost:3000/healthz | jq .

# Langfuse alive?
curl -s http://localhost:3100/api/health | jq .

# Watchdog running?
launchctl list | grep koenig

# Latest research note exists?
ls -lt ~/Documents/Paperclip/koenig-ai-org/vault/research/_daily/ | head -3

# CEO produced an EOD digest yesterday?
ls -lt ~/Documents/Paperclip/koenig-ai-org/vault/decisions/ | head -3
```

## Cost spike

1. Open Langfuse → Costs by agent
2. Identify the offender
3. In Paperclip UI → pause that agent
4. Read its last 5 heartbeats: is it looping (same prompt, no progress)?
5. If looping: tighten the SOUL.md "what they never do" section, lower its per-task cap, restart
6. If genuinely big work: raise its per-task cap deliberately and resume

## Loop detection (no progress)

The watchdog auto-pauses agents that have 5 consecutive heartbeats with no status delta. To tune:

- Lower threshold (more aggressive): edit `watchdog/watchdog.mjs` `HEARTBEAT_NO_DELTA_LIMIT`
- Whitelist a long-running task: tag the task `long-running` in Paperclip; watchdog skips it

## Mac restart / kernel panic

After reboot:

```bash
# 1. Verify Docker is up
docker ps

# 2. Restart Langfuse
cd ~/Documents/Paperclip/koenig-ai-org/observability && docker compose up -d

# 3. Restart Paperclip (launchd handles caffeinate already)
cd ~/Documents/Paperclip/koenig-ai-org && pnpm dev &

# 4. Watchdog
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.koenig.watchdog.plist 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.koenig.watchdog.plist
```

## Agent stuck "in progress" forever

```bash
# Find the task ID in Paperclip UI, then:
paperclip task cancel <task-id>
# Restart its agent in the UI (or via API)
```

## Convex agent API returns 401

- Check `ACADEMY_AGENT_API_KEY` matches in both `.env` and Convex deployment env vars
- Verify the WorkOS service token is fresh (M2M tokens expire; the publish adapter caches for 50 min)

## Course publish failed

1. Look at the agent's last vault note in `vault/courses/<slug>/`
2. Check Langfuse for the trace
3. If Zod schema rejected, the validation error is in the agent's heartbeat output
4. Most often: Author missed a required field (e.g., `learning_objectives`); Reviewer should have caught it. Update Reviewer's SOUL or add a stricter checklist skill pack

## Backup / restore

```bash
# Backup
./scripts/backup-paperclip-db.sh
# Stored as scripts/backups/paperclip-YYYYMMDD-HHMMSS.tar.gz

# Restore
tar -xzf scripts/backups/paperclip-YYYYMMDD-HHMMSS.tar.gz -C /
# Restart Paperclip
```

## Upstream merge conflict

Almost always in `adapter-plugins.json` (we add entries). Merge: keep both upstream's adapters and ours.

```bash
./scripts/upstream-rebase.sh
# If conflicts:
git status
# Open conflicted files; usually JSON or markdown
git add . && git rebase --continue
```

## CEO routines (daily-triage + EOD digest)

Two launchd jobs fire the CEO agent heartbeat automatically:

| Job | Local time | UTC | Label |
|---|---|---|---|
| Daily triage | 07:00 IST | 01:30 | `com.koenig.ceo-daily-triage` |
| EOD digest | 18:00 IST | 12:30 | `com.koenig.ceo-eod-digest` |

Plists live in `infra/launchd/`. To reload after editing: `./scripts/load-launchd-agents.sh`

To disable one: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.koenig.ceo-daily-triage.plist`

To re-enable: `./scripts/load-launchd-agents.sh ceo-daily-triage`

Logs: `infra/launchd/.logs/ceo-{daily-triage,eod-digest}.out.log` (HTTP 202 = OK, 4xx/5xx = Paperclip offline)

## Common red flags

- Watchdog reports more than 3 paused agents at once → human intervention needed
- Daily research note missing past 09:00 IST → at least one researcher is stuck
- Langfuse cost graph hockey-sticks → loop / runaway. Pause everything; investigate.
- G4 backlog > 48 hours → either the bottleneck is approval surface or content quality has dropped
