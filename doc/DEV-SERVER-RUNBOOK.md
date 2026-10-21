# Local Dev Server Instances — Runbook

Diagnosis and recovery for local dev server drift: wrong/extra ports, stale code
against a migrated DB, and an empty board (no companies / issues).

## Symptoms

- `http://localhost:3100` refuses connections, but dev servers exist on other
  ports (3101, 3102, ...).
- Board UI loads but shows no companies / tasks.
- `GET /api/companies` returns `500 Internal server error`.

## Mechanism (why this happens)

- Requested port defaults to `3100`
  (`server/src/config.ts:314`: `PORT || fileConfig?.server.port || 3100`).
- `server/src/index.ts:620-622` runs `detectPort({ port: requested })`. If the
  requested port is busy it **silently moves to the next free port**
  (3100 → 3101 → 3102) and logs
  `Requested port is busy; using next free port`.
- `dev:once`-style servers (`pnpm dev:once`) spawn a `tsx src/index.ts` child
  that survives the runner (PPID=1) and **does not hot-reload**. It keeps
  running the code snapshot from its start time.
- If migrations are applied while such a server stays up, the server's schema
  query can reference columns/tables that no longer exist → 500.

## Diagnosis

```sh
# Which ports are actually listening, and by which repo process
lsof -iTCP -sTCP:LISTEN -P | grep -E "node" | grep -E "310[0-9]"
ps -o pid,ppid,lstart,command -p <pid>

# Registered dev-service records (may be stale / dead)
pnpm dev:list

# Server git/commit provenance from /api/health on each live port
curl -s http://localhost:<port>/api/health | grep -oE '"commit":"[0-9a-f]+"|"shortSha":"[0-9a-f]+"|"processStartedAt":"[^"]*"'

# DB-side schema vs server query drift
# (companies brand_color / attachment_max_bytes were removed by migration
#  0229_drop_company_brand_color_and_attachment_max_bytes)
psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c \
  "\d companies"
grep -n "drop_company_brand_color" packages/db/src/migrations/meta/_journal.json
```

A 500 whose SQL selects columns that the DB no longer has (check
`~/.paperclip/instances/default/logs/server.log`) means the running server code
is older than the applied migrations. Restart the server on current HEAD.

## Recovery

```sh
# 1. Terminate the stale dev server tree(s). Kill the tsx cli root; the server
#    child may not cascade, so verify and TERM leftovers, then KILL if needed.
kill -TERM <tsx-cli-pid>
pgrep -fl "src/index.ts"   # confirm none left; ports released

# 2. Clean stale dev-service registry records
pnpm dev:list && pnpm dev:stop   # safe: records reference dead pids

# 3. Start one instance on 3100 (now free), logging to the instance log dir
nohup pnpm dev:once > ~/.paperclip/instances/default/logs/dev-server-3100.log 2>&1 &

# 4. Verify: status ok + bootstrap ready + current HEAD commit + companies 200
for i in $(seq 1 30); do sleep 4; \
  curl -s -m 2 http://localhost:3100/api/health | grep -q '"status":"ok"' && break; done
curl -s http://localhost:3100/api/companies | head -c 300
```

## Prevent recurrence

- Use the watch runner (`pnpm dev`) when iterating on code, so the server
  restarts on file changes and never runs a stale snapshot against a migrated DB.
- Before starting a new dev instance, stop old ones (`pnpm dev:stop` or verify
  no leftover listener); a busy 3100 silently spawns drift on 3101/3102.
- After applying migrations (`pnpm db:generate`), restart the dev server.
- If 3100 is free but a newer instance landed on 3101/3102 anyway, prefer
  consolidating back to a single 3100 instance instead of changing bookmarks.

## Related

- Codex adapter session leak (many idle `codex-acp` wrappers with no `running`
  heartbeat run) is monitored read-only by
  `~/.paperclip/scripts/check-codex-leak.sh` (crontab every 30 min; log:
  `~/.paperclip/instances/default/logs/codex-leak-check.log`). Symptom map and
  cleanup are tracked against branch `fix/acpx-stale-watchdog`.
