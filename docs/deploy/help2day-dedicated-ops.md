# Help2day Dedicated Paperclip Operations

This runbook records the dedicated Help2day deployment model and the safe operating protocol for agent concurrency, Paperclip app runtime, and PostgreSQL tuning.

## Topology

- `paperclip01` runs the Paperclip app and local agent adapter processes.
- `paperclipdb1` runs the active PostgreSQL database.
- Help2day traffic should use PostgreSQL on `paperclipdb1`, not the loopback PostgreSQL cluster on `paperclip01`.
- `paperclip01` may still have a local PostgreSQL package installed for tooling or historical repair work. Treat it as unused unless live connections or config prove otherwise.

## Pre-Change Checks

Before touching runtime, service, or database settings:

1. Confirm host and path.
   - `hostname`
   - `pwd`
   - expected path: `/home/paperclipadmin/.paperclip/instances/default`
2. Confirm active company is Help2day.
3. Confirm current run pressure.
   - Active work below 5 is the preferred gate for restarts.
   - Do not restart or mass-cancel while active work is above that gate unless this is an outage recovery.
4. Confirm database target.
   - Paperclip config should be in `postgres` mode.
   - Established app connections should point from `paperclip01` to `paperclipdb1`.
5. Capture before-state.
   - Paperclip service state and PID.
   - live run counts.
   - DB settings being changed.
   - host load and available memory.

Never print database URLs, passwords, tokens, cookies, or webhook URLs in logs or issue comments.

## Approval Evidence Gate

No Help2day or Paperclip agent may request human approval for a merge, deploy, service restart, database restart, or runtime activation unless it can present current, machine-verifiable evidence tied to the exact commit and configuration being approved.

Before requesting approval, provide:

- exact git branch and commit SHA,
- upstream comparison showing whether the branch is ahead or behind,
- tracked working-tree state,
- changed-file summary for the approval scope,
- relevant local validation commands and results,
- live service health for runtime changes,
- database target and PostgreSQL pending-restart state for database changes,
- rollback path.

Use the local evidence helper when possible:

```bash
node scripts/approval-evidence-report.mjs --require-clean
```

If the working tree is intentionally dirty, the approval request must name the dirty files and explain why they are excluded from the approval scope. Approval requests without current evidence should be treated as incomplete, not ready for a human decision.

## Agent Concurrency Levels

Use the global premium/local adapter cap as the primary safety valve. Per-agent limits are secondary and should prevent one agent from monopolizing the host.

Recommended levels for `paperclip01`:

- 3 premium/local runs: conservative stable default.
- 4-5 premium/local runs: normal steady-state target after a clean observation window.
- 6-7 premium/local runs: supervised backlog drain only.
- 8+ premium/local runs: warning zone; do not leave unattended without fresh evidence.
- 20 premium/local runs: not a steady-state cap for this host. Use 20 as queue depth or theoretical upper bound only.

Back down immediately if any of these occur:

- active run count exceeds the configured cap,
- service restarts unexpectedly,
- active runs stop producing output for the watchdog window,
- API health fails,
- database connections or waits spike,
- sustained system load exceeds CPU capacity,
- available memory falls below 4 GiB.

## Stale Run Failure Mode

Observed failure mode on 2026-06-17:

- A run stayed `running` for hours with no process metadata and no output.
- The watchdog created recovery/evaluation work but did not terminate the source run.
- Because global premium concurrency was effectively 1, queued work accumulated behind that run.

Durable behavior:

- Critical silent runs with no process metadata, no process PID/group, no output, and no log metadata should be auto-cancelled by the watchdog.
- Cancelling must release the issue execution lock.
- The agent should be finalized back to idle/cancelled state.
- The scheduler should promote the next queued run for that agent when safe.

## Safe PostgreSQL Reload Tuning

These settings can be changed with `ALTER SYSTEM` plus `pg_reload_conf()` and do not require a PostgreSQL restart:

- `effective_cache_size = '10GB'`
- `work_mem = '16MB'`
- `maintenance_work_mem = '512MB'`
- `track_io_timing = 'on'`
- `random_page_cost = '1.1'`
- `effective_io_concurrency = '200'`
- `checkpoint_timeout = '15min'`
- `max_wal_size = '4GB'`
- `min_wal_size = '512MB'`
- `jit = 'off'`

Validate afterward:

- `pg_settings.pending_restart` should remain false for these settings.
- Paperclip API health should be OK.
- live run counts should remain within cap.
- PostgreSQL active/idle connections should remain normal.

Rollback:

Use `ALTER SYSTEM RESET <setting>; SELECT pg_reload_conf();` for each reload-only setting, or set the previous explicit values and reload.

## Restart-Gated PostgreSQL Tuning

Do these only during a planned window, preferably when active work is below 5 and a current backup has been verified:

- Increase `shared_buffers` from the small package default to an app-appropriate value, starting at `2GB`.
- Add `pg_stat_statements` to `shared_preload_libraries`.
- Restart PostgreSQL.
- Create the extension in the `paperclip` database if needed.

Validation after restart:

- PostgreSQL service is active.
- Paperclip API health is OK.
- Paperclip connects to `paperclipdb1`.
- `pg_settings.pending_restart` is false.
- `pg_stat_statements` is available.
- run queue resumes without a spike.

Rollback:

- Restore prior `shared_buffers` and `shared_preload_libraries`.
- Restart PostgreSQL.
- Verify API health and database connectivity.

## Paperclip App Runtime

The preferred steady state on a dedicated app host is a compiled server process, not a source `tsx` runtime.

Before switching:

- Ensure the repository builds cleanly.
- Resolve unrelated typecheck blockers.
- Confirm the service unit points to the intended working tree or release artifact.
- Keep a rollback path to the previous `ExecStart`.

Do not switch the service to compiled runtime while active work is above the restart gate unless it is needed for outage recovery.

## Backup Expectations

- `paperclipdb1` should have a current PostgreSQL backup path and timer.
- `paperclip01` guarded backup should continue to provide app-level safety evidence.
- Before restart-gated database changes, verify the latest backup timestamp and that the target backup volume has enough free space.

## Routine Stability Checks

During active operation, sample:

- Paperclip API health.
- `paperclip.service` active state, PID, and restart count.
- Help2day live run counts.
- active run `lastOutputAt` freshness.
- host load and memory on `paperclip01`.
- PostgreSQL active/idle connection counts and wait events on `paperclipdb1`.

If queued work rises while running count stays below cap, check:

- global premium/local cap,
- per-agent concurrency policy,
- stuck active runs,
- scheduler/watchdog logs,
- database connectivity,
- service restarts.
