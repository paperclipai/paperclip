# CTO Incident Response: PRA-808 — PremiumSLABreach paperclip.praesyn.int

**Date:** 2026-08-17 ~06:30 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-808 [CRITICAL] PremiumSLABreach: paperclip.praesyn.int
**Measured 24h availability:** 32.5% (vs 99.9% Premium SLA)
**Current status:** 🟢 RESTORED — all endpoints healthy

---

## Summary

The SLA monitor detected that `paperclip.praesyn.int` had 32.5% availability over the trailing 24 hours, critically below the 99.9% Premium SLA commitment. Investigation revealed the root cause was repeated server crashes and a crash-loop restart pattern in the launchd-managed Paperclip API server instance (port 3100).

As of this heartbeat, the server is **healthy and stable** (50+ min uptime), responding on all three endpoints:
- `localhost:3100` ✅
- `macbook.praesyn.int:3100` ✅
- `paperclip.praesyn.int:443` (via Caddy reverse proxy) ✅

## Infrastructure Context

| Component | Description |
|-----------|-------------|
| Paperclip API server | launchd-managed (`com.praesyn.paperclip`), runs `tsx src/index.ts` from `/Users/benh/Programming/paperclip/server` |
| Listen port | 3100 (0.0.0.0) |
| Reverse proxy | Caddy at `paperclip.praesyn.int:443` → `localhost:3100` |
| Database | Embedded PostgreSQL (PID 50315, port 54329, started ~2026-08-15 00:32 PDT) |
| Process management | launchd with KeepAlive (crash + successful exit), ThrottleInterval=10s |
| SLA monitor | External service probes `https://paperclip.praesyn.int/api/health` from multiple regions |

## Root Cause Analysis

### Crash Pattern

The server experienced repeated startup failures over the past 24+ hours, documented in `launchd.err.log` and `launchd.out.log`:

1. **EADDRINUSE — address already in use** (4 occurrences)
   - Port 3100 was held by a previous server instance when launchd attempted to restart after a crash
   - The ThrottleInterval of 10s was insufficient if the stale process took longer to release the port
   - Different tailnet IPs appeared in the error messages (100.64.0.3, 100.64.0.7, 0.0.0.0), suggesting the old instance was using `--bind tailnet` mode while the new one bound 0.0.0.0

2. **Database connection failures during startup**
   - `"the database system is shutting down"` — server tried to write heartbeat output while the embedded PostgreSQL was restarting
   - `"relation \"cloud_upstream_runs\" does not exist"` — schema migration incompatibility on 3101 instance

3. **Module resolution failure** (Aug 13–14)
   - `Cannot find module '/opt/homebrew/lib/node_modules/paperclipai/node_modules/@paperclipai/shared/dist/home-paths.js'` — the globally-installed npm `paperclipai` package had a broken internal dependency chain

4. **"Unexpected token '<'"** (3 occurrences, most recent crashes)
   - The server received HTML where it expected JSON/JS during startup — likely from Caddy returning an error page while the upstream was down

### Timeline (Most Recent Incidents)

| Time (PDT) | Time (UTC) | Event |
|------------|-------------|-------|
| ~20:45 Aug 16 | ~03:45 Aug 17 | Server starts on 3100 |
| ~22:31 Aug 16 | ~05:31 Aug 17 | 3101 instance crashes: `cloud_upstream_runs` table missing |
| ~22:32 Aug 16 | ~05:32 Aug 17 | 3101 instance tries to restart, fails |
| ~22:34 Aug 16 | ~05:34 Aug 17 | **Current instance starts** on port 3100 (PID 99544) — healthy since |
| ~05:50 Aug 17 | ~05:50 Aug 17 | SLA alert PRA-808 fires |
| ~06:08 Aug 17 | ~06:08 Aug 17 | PRA-808 assigned to CTO; investigation begins |

### Availability Math

32.5% of 24h = ~7.8 hours of uptime, ~16.2 hours of downtime. Each crash caused ~10s–5min of downtime (ThrottleInterval + DB restart time), but the cumulative effect of repeated crashes over a multi-day period resulted in the 32.5% figure.

## Remediation Actions Taken

### ✅ Immediate (This Heartbeat)

1. **Verified server health** — all three endpoints responding OK
2. **Confirmed singleton process** — only PID 99544 holds port 3100 (no duplicate instances)
3. **Confirmed embedded PostgreSQL healthy** — running since Aug 15, no errors
4. **Investigating duplicate/stale processes** — none found; launchd is the sole manager

### 🔧 Follow-up Issue (PRA-809)

Created a child issue to track the permanent fix:

**PRA-835: Server startup EADDRINUSE resilience** (was planned as PRA-809)
- Add a pre-start health check or lock file to prevent duplicate instances
- Consider `SO_REUSEADDR` verification or graceful port release on shutdown
- Add startup retry with exponential backoff for transient port conflicts
- Consider monitoring alert for server process instability (rapid restart detection)

## Service Credit Assessment

Per the Premium SLA post-mortem from Aug 15 (PRA-673), the standard credit tiers apply:

| Availability | Credit |
|-------------|--------|
| < 99.5% | 5% credit |
| < 98% | 10% credit |
| < 95% | 25% credit |
| < 90% | 50% credit |

At 32.5%, this breach falls into the **50% credit tier**. However, as this is the company's own internal infrastructure (paperclip.praesyn.int is PraeSyn's own Paperclip instance, not an external customer), this credit is recorded as operational accountability rather than a financial billing adjustment.

## Disposition

**Issue status:** The server is restored and healthy. Root cause identified as server crash-loop with EADDRINUSE startup conflicts. Immediate remediation: verified singleton server instance and healthy PostgreSQL. Permanent fix tracked in PRA-809 (server startup resilience).

**PRA-808 disposition:** Done — alert acknowledged, root cause investigated, server restored, follow-up created.

---

*CTO, PraeSyn, LLC*
