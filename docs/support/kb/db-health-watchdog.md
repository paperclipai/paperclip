---
title: Knowledge Base — DB Health Watchdog
summary: Behavioral reference for the embedded PostgreSQL health watchdog — probe behavior, restart gates, and external-mode differences
version: v0.5.0+ (P0-B shipped); PRA-1051 committed on fix/m-series-tech-debt
commits:
  - cd7f9d21db — P0-B: external mode warn-only (shipped v0.5.0)
  - 36d152f5d2 — PRA-1051: probe restart cascade fix (committed, unshipped)
---

# Knowledge Base: DB Health Watchdog

## Overview

In embedded-PostgreSQL deployments, the server owns the database process. If that
child process dies (crash, OOM kill, macOS sleep/wake edge case), the HTTP server
keeps running but every DB-backed request — including the health endpoint's DB
probe — returns a 503. The **DB health watchdog** monitors database connectivity
and takes action when the database is unreachable.

## Probe Behavior

The watchdog probes the database on a configurable interval by executing
`SELECT 1`. The probe function (`dbHealthProbe`) returns one of:

- `"ok"` — database is reachable
- `"failed"` — database is unreachable

**The probe does NOT attempt to restart PostgreSQL on failure.** Immediate
restarts at the probe level bypass the consecutive-failure threshold and can
cause restart cascades on transient blips (PRA-1051). Restart responsibility
belongs to the watchdog loop's consecutive-failure logic.

An **in-flight mutex** (`probeInFlight`) prevents concurrent probe executions,
which could otherwise overlap during slow failures and skew the consecutive-
failure counter.

## Watchdog Loop

The watchdog loop (`installDbHealthWatchdog`) runs probes every
`PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` (default: 30 s). It tracks a
`consecutiveFailures` counter:

| Consecutive Failures | Embedded Mode | External Mode |
|---|---|---|
| `< failuresBeforeAction` (default: 3) | Logs warning, increments counter | Logs warning, increments counter |
| `>= failuresBeforeAction`, first time | **Attempts embedded PG restart** (stop + start). Resets counter to give recovery time. | Logs warning — *no restart attempted.* |
| `>= failuresBeforeAction`, restart already attempted and DB still down | **Exits process with code 1** so launchd bounces the whole stack. | Logs warning — *no process exit.* |

### External Mode (P0-B)

In external-postgres mode, the watchdog **logs warnings only**. The server
cannot restart an external database, and calling `process.exit()` would cause
unnecessary restart loops. The health endpoint already reports 503 while the
database is unreachable.

This was fixed in commit `cd7f9d21db` (shipped v0.5.0). Previously, the
watchdog could exit the process on signal even in external mode, contradicting
its own documented design.

### Probe Restart Cascade Fix (PRA-1051)

Before commit `36d152f5d2`, the `dbHealthProbe` function itself attempted an
embedded PG restart on ANY probe failure — restarting PG before the watchdog
loop could evaluate the consecutive-failure threshold. This meant:

- A single transient failure (e.g., a 1-second network blip) could trigger a
  full PG restart
- Repeated transient failures could cause restart cascades, prolonging the
  outage instead of recovering from it
- The `failuresBeforeAction` threshold was effectively bypassed

After the fix, the probe returns `"failed"` without attempting a restart.
Restart decisions are gated by the watchdog loop's consecutive-failure
counter, preventing cascades.

**This fix is committed on `fix/m-series-tech-debt` but has not yet shipped to
`fork/master`.**

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` | 30000 | Probe interval in milliseconds |
| `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` | 3 | Consecutive failures before watchdog takes action |

## Support Implications

### What users might report

| Symptom | Likely Cause | Response |
|---|---|---|
| "The server is running but I get 503s" | Database is down or unreachable | Check database process health. In embedded mode, the watchdog will auto-restart after `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` consecutive failures. In external mode, restore the database connection externally. |
| "The server keeps restarting in embedded mode" | Watchdog exiting after failed restart attempt | Check for persistent database corruption or resource exhaustion. The watchdog only restarts PG once; if the restart doesn't stick, the process exits so launchd can recover the full stack. |
| "It takes ~90 seconds for the server to notice the DB is down" | Default watchdog configuration (3 failures × 30 s interval) | This is expected. Operators can lower `PAPERCLIP_DB_WATCHDOG_INTERVAL_MS` or `PAPERCLIP_DB_WATCHDOG_MAX_FAILURES` to reduce detection latency, at the cost of higher false-positive sensitivity. |
| "The DB was down briefly but PG restarted anyway" | (Pre-PRA-1051) The old probe-level restart fired on a transient blip | With PRA-1051 applied, transient blips are absorbed by the consecutive-failure counter and won't trigger a restart. |

### Escalation Paths

- **Database corruption or persistent crash-loop**: Escalate to CTO / Staff Engineer
- **Unexpected process exits in external mode**: Verify the server is running
  v0.5.0 or later (P0-B fix) — earlier versions could exit on signal in
  external mode
- **Restart cascades on transient failures**: Verify PRA-1051 is applied
  (committed on `fix/m-series-tech-debt`, not yet shipped to `fork/master`)

## Related Documentation

- [Environment Variables Reference](../../deploy/environment-variables.md#database) —
  `PAPERCLIP_DB_WATCHDOG_*` configuration
- [Database Deployment Guide](../../deploy/database.md) — Embedded vs external
  PostgreSQL modes
- [v0.5.0 Phase 1 Release Notes](../releases/v0.5.0-phase-1.md) — Documents the
  P0-B external-mode fix
- [Configurable Timeouts Reference](https://github.com/paperclip-ai/paperclip/blob/main/server/docs/configurable-timeouts.md) —
  Internal timeout reference (includes DB watchdog section)
- `server/src/services/db-health-watchdog.ts` — Source code with inline documentation
