# CTO Heartbeat — PRA-1134 (StandardSLABreach: conn.praesyn.com)

**Date:** 2026-08-20 ~13:20 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1134 [CRITICAL] StandardSLABreach: conn.praesyn.com
**Disposition:** ✅ Done — service verified UP and stable; alert is residual 24h-window recovery from the Aug 20 08:51–10:11 UTC outage (same incident as PRA-1091/PRA-1097/PRA-1122)

---

## Summary

SLA monitoring fired at 12:18 UTC: conn.praesyn.com 24h availability at 62.8%,
below the 99.5% Standard SLA. This is the **third re-fire** of the same alert
for the same incident: PRA-1097 fired at 09:04 (40.0%), PRA-1122 at 11:13
(48.4%), PRA-1134 at 12:18 (62.8%). The number is climbing each cycle as the
24h trailing window fills with post-recovery samples — classic residual
recovery, not a new outage.

## Verification Timeline (UTC, 13:16–13:20)

| Check | Result |
|-------|--------|
| https://conn.praesyn.com/health (external) | HTTP 200 ✅ |
| https://conn.praesyn.com/api/v1/health (external) | HTTP 401 — headscale API up (auth expected) ✅ |
| https://conn.praesyn.com/ (external) | HTTP 404 — normal gRPC-over-HTTP up signal ✅ |
| TLS cert (openssl s_client) | Let's Encrypt, CN=conn.praesyn.com, valid until Oct 7 2026 ✅ |
| `docker ps` on vps-2 | headscale `Up 2 hours`, no healthcheck (fix from PRA-1097) |
| headscale `nodes list` | vps-2, localhost, vps-1, macbook all `online` |
| Prometheus 1h availability (both regions) | 100% / 100% ✅ |
| Prometheus 24h availability | vps-2: 93.2%, vps-1: 71.4% (recovering) |

## 1h availability trend (Prometheus, hourly buckets, vps-2)

| Hour (UTC) | avail |
|------------|-------|
| 13:00–14:00 | 1.0 |
| 12:00–13:00 | 1.0 |
| 11:00–12:00 | 0.833 |
| 10:00–11:00 | 0.0 (outage tail) |
| 09:00–10:00 | 0.8 |
| 08:00–09:00 | 1.0 |

vps-1 mirrors the same shape (0.5 → 0.0 → 0.833 → 1.0 → 1.0). The outage
window (08:51–10:11 UTC) is still inside the 24h horizon, which is why the
alert keeps re-firing; it rolls fully out by ~10:11 UTC Aug 21.

## Root Cause (unchanged from PRA-1097)

- **Real outage:** 08:51 → 10:11 UTC (~1h20m) from the vps-2 cAdvisor OOM
  cascade (Aug 19–20, PRA-1047/PRA-1061). headscale container `Exited (128)`,
  recovered ~10:11 UTC. Real 24h availability ≈ 94.4% — a genuine Standard-tier
  breach, but nowhere near the 40–63% the alerts claimed.
- **Alert inflation:** Prometheus itself restarted during the cascade
  (~08:15 UTC), so at each alert-evaluation the `avg_over_time(probe_success[24h])`
  window contains far fewer than 24h of samples, mostly failures (PRA-206 class
  artifact). Numbers climb monotonically as good samples accumulate:
  40.0% → 48.4% → 62.8% → (now) 71–93%.
- **Healthcheck defect:** fixed in PRA-1097 (distroless image + `curl` healthcheck
  removed, `healthcheck: disable: true`, external blackbox probes are coverage).
  No regression observed this heartbeat.

## SLA / Service Credit Note

Per PRA-305 framework and PRA-669 precedent: Standard tier (99.5%). Real
measured availability ≈ 94.4% over the affected 24h window — below target, so
the breach is genuine and was already reported to the board via the PRA-1123
alert-storm communication. Service-credit decisions remain a board call.

## Actions Taken

1. Verified conn.praesyn.com externally: /health 200, headscale API 401,
   gRPC 404 (all "up" signals), valid Let's Encrypt cert.
2. Confirmed headscale container healthy on vps-2 (Up, no healthcheck, nodes
   connected: vps-2/vps-1/localhost/macbook online).
3. Pulled Prometheus 1h/24h availability from both regions and the hourly
   trend; confirmed 100% current availability and monotonic 24h recovery.
4. Identified PRA-1134 as the third re-fire of the PRA-1091 incident;
   documented and closed with reference to prior dispositions.

## Files Written

- `doc/status/2026-08-20-1320-cto-pra-1134-conn-sla-breach.md` (this file)

## Disposition

**DONE** — no new outage. conn.praesyn.com verified UP and stable (1h
availability 100% both regions, all nodes online). Alert is residual 24h-window
recovery from the already-documented Aug 20 08:51–10:11 UTC outage; the metric
is climbing and will clear the 99.5% threshold as the window rolls out.

---

*CTO, PraeSyn, LLC*
