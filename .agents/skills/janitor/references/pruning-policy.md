# Janitor Pruning Policy

This file defines what the Janitor may inspect, prune, skip, and escalate.

## Default Schedule

- Cadence: daily
- Window: overnight
- Preferred time: 02:15 server-local time
- Acceptable time range: 02:00-03:00 server-local time
- Normal timeout: 300000 ms
- First-run/heavy-cleanup timeout: 900000 ms

## Retention Windows

| Category | Minimum age before cleanup |
|----------|----------------------------|
| Terminal heartbeat logs/artifacts | 14 days |
| Orphaned workspaces | 48 hours |
| Codex temp homes | 24 hours |
| Stale lock files | 10 minutes |
| Dry-run manifests | 7 days |
| Janitor reports | 30 days |

## Allowed Cleanup Paths

The Janitor may only delete files or directories under these path patterns:

- `/tmp/codex-*`
- `/tmp/codex-test-*`
- `/tmp/paperclip-janitor-*`
- `/paperclip/instances/default/data/workspaces/<workspace-id>` when confirmed orphaned
- `/paperclip/instances/default/data/**/.lock` when confirmed stale and ownerless
- `/paperclip/instances/default/data/heartbeat-runs/**/artifacts/*` when the run is terminal and older than retention
- `/paperclip/instances/default/data/heartbeat-runs/**/logs/*` when the run is terminal and older than retention

## Forbidden Paths

Never delete these paths directly:

- `/`
- `/tmp`
- `/paperclip`
- `/paperclip/instances`
- `/paperclip/instances/default`
- `/paperclip/instances/default/data`
- Any database directory
- Any storage bucket/root containing assets or documents
- Any Git checkout root
- Any path containing company, project, issue, approval, activity, or document data unless the approved Paperclip API performs the pruning

## Heartbeat Cleanup

The Janitor may prune logs/artifacts for heartbeat runs only when all are true:

- Run status is terminal: `succeeded`, `failed`, `cancelled`, or `timedout`
- Run age is greater than 14 days
- Run record remains intact
- Cleanup is done via Paperclip CLI/API if available
- If no CLI/API exists for log pruning, report the missing capability instead of deleting unknown DB-backed data

## Workspace Cleanup

A workspace directory is considered orphaned only when all are true:

- Directory age is greater than 48 hours
- No heartbeat run is currently using it
- No active project workspace record points to it
- No process has it as current working directory
- The directory name/path matches the expected workspace root pattern

If any check cannot be performed, skip the workspace and report it.

## Lock Cleanup

A lock file is considered stale only when all are true:

- It is older than 10 minutes
- It is under an approved Paperclip/Codex data path
- No process appears to own or reference it
- Removing it will not interrupt a running heartbeat

## Temp Cleanup

The Janitor may remove only scoped temp homes:

- `/tmp/codex-*`
- `/tmp/codex-test-*`
- `/tmp/paperclip-janitor-*`

Never remove all of `/tmp`, never use broad shell globs without an explicit prefix, and never follow symlinks.

## Database Maintenance

Database maintenance is report-first unless a supported Paperclip command exists.

Allowed actions:

- Report database/WAL size
- Run a documented Paperclip CLI command for safe checkpoint/vacuum if present
- Open a `needs-review` issue when WAL or DB growth exceeds thresholds

Forbidden actions:

- Manually deleting WAL files
- Manually editing database files
- Running destructive SQL
- Dropping tables, records, indexes, or schemas
