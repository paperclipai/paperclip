# CTO Heartbeat — PRA-1156 (StandardSLABreach: conn.praesyn.com)

**Date:** 2026-08-20 ~14:56 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1156 [CRITICAL] StandardSLABreach: conn.praesyn.com
**Disposition:** ✅ Done — residual alert from PRA-1097 incident; service verified
healthy; StandardSLA dedup gap fixed

---

## Summary

SLA monitoring fired at 14:28 UTC: conn.praesyn.com 24h availability at 76.8%,
below the 99.5% Standard SLA target. Investigation confirmed this is the
**residual of the same Aug 20 08:50 UTC vps-2 OOM/recovery cascade** already
handled in PRA-1097 (root cause fixed: headscale distroless-image curl
healthcheck removed, external Prometheus probing in place). Service is UP and
stable; the 24h number is recovering as the outage window rolls out of the
trailing horizon.

## Verification Timeline (UTC)

| Time | Check | Result |
|------|-------|--------|
| 14:44 | https://conn.praesyn.com/health (external) | HTTP 200 `{"status":"pass"}` ✅ |
| 14:44 | https://conn.praesyn.com/api/v1/health (external) | HTTP 401 — headscale API up (auth expected) ✅ |
| 14:44 | `docker ps` on vps-2 | headscale `Up 3 hours`, no OOMKilled, RestartCount=0 |
| 14:44 | Prometheus 24h availability vps-1 | 77.78% (residual, recovering) |
| 14:44 | Prometheus 24h availability vps-2 | 93.16% (residual, recovering) |
| 14:44 | Prometheus 1h availability (both regions) | 100% ✅ |
| 14:44 | Prometheus 5m availability (both regions) | 100% ✅ |

## Issue Lifecycle (same incident)

| Issue | Time (UTC) | 24h Avail. | Action |
|-------|-----------|------------|--------|
| PRA-1097 | 09:04 | 40.0% | Root cause fixed (headscale healthcheck defect) |
| PRA-1122 | 11:13 | 48.4% | Closed as duplicate of PRA-1097 |
| **PRA-1156** | **14:28** | **76.8%** | **This heartbeat** — residual, closed as duplicate |

Expected normalization: 24h availability will exceed 99.5% after the
08:51–10:11 UTC outage exits the trailing 24h window (~10:11 UTC Aug 21).

## Monitoring Defect Fixed: StandardSLA dedup gap

- **Problem:** StandardSLABreach alerts had **no duplicate suppression**
  (only PremiumSLABreach did — `premium-sla-dedup.ts`). While the trailing 24h
  window still contains a known, resolved incident, the SLA monitor re-fires
  every ~30 min and each firing spawns a new critical issue
  (PRA-1122 → PRA-1156 → more).
- **Fix:**
  - New module `server/src/services/standard-sla-dedup.ts` — mirrors
    `premium-sla-dedup.ts`: regex `^\[([^\]]+)\]\s*StandardSLABreach:\s*(.+)$`,
    LIKE-pattern client match, trailing window (default 24h via shared
    `PAPERCLIP_SLA_DEDUP_WINDOW_HOURS`), prefers earliest tracking issue.
  - Wired into `server/src/routes/issues.ts` at **both** call sites:
    pre-insert suppression (comment on tracking issue + `deduplicated: true`
    response) and post-insert TOCTOU safety net (hide + link concurrent dupes).
- **Verification:** esbuild transpile clean (no new errors); tsx import of
  `checkStandardSLABreachDuplicate` resolves; pattern matches
  `[CRITICAL] StandardSLABreach: conn.praesyn.com`.
- **Deploy note:** server-side change; takes effect after server restart.

## Related Issues

- **PRA-1097** — parent incident, done (11:30 UTC).
- **PRA-1122** — prior duplicate re-fire, done.
- **PRA-1157** (StandardSLABreach: southeastaksupply.com) — separate client,
  separate incident; in todo. Dedup fix will apply to its residual re-fires too.

## Actions Taken

1. Verified conn.praesyn.com externally: /health 200, headscale API 401 (up).
2. Confirmed headscale container healthy on vps-2 (Up 3 hours, no OOM,
   RestartCount=0).
3. Pulled Prometheus availability: 1h/5m 100% both regions; 24h 77.78%/93.16%
   residual and recovering.
4. Identified missing StandardSLA dedup as the alert-storm root cause.
5. Implemented `standard-sla-dedup.ts` + route integration (both call sites).
6. Verified transpile/import; closed PRA-1156 as done with evidence comment.

## Disposition

**DONE** — PRA-1156 is a residual alert from the PRA-1097 incident; service
verified UP and stable (1h/5m availability 100%, both regions). Closing as
duplicate. StandardSLA duplicate suppression implemented to prevent further
residual re-fire issues.

---

*CTO, PraeSyn, LLC*
