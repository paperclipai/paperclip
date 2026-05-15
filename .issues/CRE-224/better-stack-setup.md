# Better Stack Monitoring Setup

## Monitor 1: Basic Health (uptime check)

- **URL:** `https://paperclip.avva.aero/api/health`
- **Type:** HTTP(s)
- **Check every:** 1 minute
- **Timeout:** 10 seconds
- **Trigger:** Alert if down for 2 consecutive checks

This verifies the Paperclip server process is running and reachable through nginx.

## Monitor 2: Deep Health (full system check)

- **URL:** `https://paperclip.avva.aero/api/health/deep`
- **Type:** HTTP(s)
- **Check every:** 5 minutes
- **Timeout:** 15 seconds
- **Expected status code:** 200
- **Trigger:** Alert if response is 503 or non-200

A 503 response means one or more critical components are unhealthy.

## Recovery Hints

### `database: "failed"`
- Paperclip cannot connect to Postgres
- **Check:** Is the Postgres service running? Any network issues between app and DB?
- **Recovery:** `sudo systemctl restart postgresql` or verify `PAPERCLIP_DATABASE_URL`

### `migrations: "failed"`
- Database migrations are missing or incomplete
- **Check:** Was the deployment interrupted mid-migration?
- **Recovery:** Run `pnpm db:migrate` from the packages/db directory

### `background: "failed"` (no_recent_heartbeat_runs)
- No heartbeat runs in the last 5 minutes — the scheduler may be stalled
- **Check:** Is the `RoutinesService` (cron scheduler) running? Check server logs for scheduler errors
- **Recovery:** Restart the Paperclip server process

### `background: "failed"` (background_check_error)
- The heartbeat runs query itself failed
- **Check:** Database connection, `heartbeat_runs` table integrity
- **Recovery:** Investigate server logs for the underlying query error

### UI works but health check fails
- If the app UI loads but `/api/health/deep` returns 503, the issue is likely the background scheduler or migrations. The basic web server + nginx are fine.
- If even the UI fails, start with the basic health check.
