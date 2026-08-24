# CTO Heartbeat — PRA-1097 (StandardSLABreach: conn.praesyn.com)

**Date:** 2026-08-20 ~11:30 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1097 [CRITICAL] StandardSLABreach: conn.praesyn.com
**Disposition:** ✅ Done — service recovered and verified stable; monitoring defect fixed

---

## Summary

SLA monitoring fired at 09:04 UTC: conn.praesyn.com 24h availability at 40.0%,
below the 99.5% Standard SLA target. Investigation confirmed the alert is the
residual of the Aug 20 08:50 UTC vps-2 OOM/recovery cascade (same wave as
PRA-1089, PRA-1091, PRA-1093, PRA-1107), plus a data-window artifact inflating
the 24h number. Service is now UP and stable; root-cause defect fixed.

## Verification Timeline (UTC)

| Time | Check | Result |
|------|-------|--------|
| 11:16 | https://conn.praesyn.com/health (external) | HTTP 200 ✅ |
| 11:16 | https://conn.praesyn.com/api/v1/health (external) | HTTP 401 — headscale API up (auth expected) ✅ |
| 11:17 | `docker ps` on vps-2 | headscale `Up`, OOMKilled=false, RestartCount=0 |
| 11:17 | headscale logs | serving on 0.0.0.0:8080; nodes connected: vps-1, vps-2, localhost, Ben's MacBook Pro |
| 11:20 | Prometheus probe_success (vps-1, vps-2) | 1, 1 ✅ |
| 11:20 | client:availability_1h{conn.praesyn.com} | 100% ✅ |
| 11:20 | client:availability_24h{conn.praesyn.com} | 50% (residual, recovering) |

## Root Cause Analysis

### Actual outage (real, SLA-impacting)
- **08:51 → 10:11 UTC (~1h20m):** conn.praesyn.com unreachable from both
  monitoring regions (probe failures 08:51–10:11 vps-2, 08:56–10:11 vps-1).
- Cause: vps-2 memory-pressure cascade (Aug 19–20 cAdvisor OOM incident,
  PRA-1047/PRA-1061, 112+ zombie wget processes) — headscale container
  `Exited (128)`, recovered ~10:11 UTC when container restarted.
- Real 24h availability ≈ 94.4% (1h20m down of 24h) — a genuine Standard-tier
  breach, but nowhere near the 40% the alert claimed.

### Alert inflation (monitoring artifact)
- The 40.0% figure is wrong. Prometheus itself restarted during the cascade
  (~08:15 UTC, container now `Up 3 hours`), so at alert-evaluation time the
  `avg_over_time(probe_success[24h])` window contained <1h of samples — most of
  them failures. This is the exact PRA-206 class of artifact (insufficient data
  in the 24h window → garbage availability number).
- Since 10:11 the 24h metric has been climbing: 20% (10:20) → 50% (11:20), and
  the 1h availability is back to 100%. It will normalize to ~99.4% as the
  outage window rolls out of the 24h horizon.

## Defect Fixed: headscale healthcheck permanently failing

- `docker inspect` showed headscale `(unhealthy)` with a FailingStreak of 132+
  consecutive failures: `exec: "curl": executable file not found in $PATH`.
- Root cause: `docker-compose.yml` declares a `CMD curl -sf ...` healthcheck,
  but the headscale image is **distroless Go** (`/ko-app/headscale` entrypoint)
  — no curl, no wget, no shell, no /dev/tcp. The healthcheck can never succeed,
  so Docker flagged a healthy service as unhealthy forever.
- Fix applied on vps-2 (`/docker/headscale/docker-compose.yml`, backup saved as
  `.bak`):
  - Removed the broken `CMD curl` healthcheck → `healthcheck: disable: true`.
  - Coverage instead: external Prometheus blackbox probes
    `https://conn.praesyn.com/health` every 5m from vps-1 AND vps-2, firing
    ServiceDown/ServiceDownAllRegions alerts on failure (verified configured in
    `/opt/monitoring/prometheus/prometheus.yml`).
  - Container recreated via `docker compose up -d`; now `Up`, no healthcheck,
    RestartCount=0, service verified 200 externally after restart.
- Service behavior unchanged: headscale serves fine (nodes connected, API
  responding). Only the false "unhealthy" Docker flag is gone.

## Related Issues (same incident)

- **PRA-1091** (ServiceDownAllRegions conn.praesyn.com) — already done (10:12 UTC).
- **PRA-1107** (ServiceDownAllRegions: unknown — headscale `Exited (128)`)
  — closed this heartbeat; container running and stable.
- **PRA-1122** (StandardSLABreach conn.praesyn.com 48.4%, 11:13 UTC)
  — duplicate re-fire of the same alert; covered by this issue, closed.
- **PRA-1096 / PRA-1121** (southeastaksupply.com SLA) — separate client,
  separate tracking.

## SLA / Service Credit Note

Per the PRA-305 framework and PRA-669 precedent: conn.praesyn.com is
**Standard tier** (99.5%). Real measured availability over the last 24h is
~94.4% due to the 1h20m outage — below target. CPA was already made aware of
the SLA alert storm (PRA-1123); service-credit communication, if any, is a
business decision for the board, not an automated credit.

## Actions Taken

1. Verified conn.praesyn.com externally: /health 200, headscale API 401 (up).
2. Confirmed headscale container healthy on vps-2 (running, no OOM, nodes
   connected, service logs clean).
3. Diagnosed the false `unhealthy` Docker status → distroless-image curl
   healthcheck defect.
4. Fixed `/docker/headscale/docker-compose.yml` (healthcheck disabled, external
   probing is the coverage), recreated container, verified 200 after restart.
5. Quantified the real outage window from Prometheus (08:51–10:11 UTC) and the
   metric artifact (Prometheus restart → <1h data in 24h window at eval time).
6. Closed PRA-1107 and PRA-1122 (same incident/duplicate) with disposition
   notes; PRA-1097 marked done.

## Files Written

- `doc/status/2026-08-20-1130-cto-pra-1097-conn-sla-breach.md` (this file)

## Disposition

**DONE** — PRA-1097 handled. conn.praesyn.com verified UP and stable
(1h availability 100%, both regions); real outage (1h20m) documented; alert
inflation explained; headscale healthcheck defect fixed on vps-2.

---

*CTO, PraeSyn, LLC*
