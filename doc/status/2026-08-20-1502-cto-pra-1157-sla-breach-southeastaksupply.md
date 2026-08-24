# CTO Heartbeat — PRA-1157 StandardSLABreach: southeastaksupply.com

**Date:** 2026-08-20 ~15:02 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1157 [CRITICAL] StandardSLABreach: southeastaksupply.com
**Disposition:** ✅ Done — residual re-fire of PRA-1093/PRA-1096 incident; site verified UP; dedup fix pending deploy

---

## Summary

SLA monitoring fired at 14:29 UTC: southeastaksupply.com 24h availability at 92.8%, below the 99.5% Standard SLA. Investigation confirms this is the **6th residual re-fire** of the same Aug 19–20 vps-2 OOM/cascade incident — no new downtime since the 09:20 UTC fix.

### Verification

| Check | Result |
|---|---|
| https://southeastaksupply.com/ (external, 14:58 UTC) | HTTP 200 ✅ 0.51s |
| https://southeastaksupply.com/ (external, 15:02 UTC) | HTTP 200 ✅ 1.10s (Next.js cache HIT) |
| https://southeastaksupply.com/healthz | HTTP 307 (expected redirect) ✅ |
| TLS certificate | Valid until Oct 10 2026 ✅ |

### Issue Lineage (southeastaksupply.com StandardSLABreach re-fire chain)

| Issue | Created (UTC) | Avail. | Status | Action Taken |
|---|---|---|---|---|
| PRA-1093 (ServiceDown) | ~08:50 | 0% | ✅ Done | Root cause fixed: Traefik IP + container IP pinned |
| PRA-1096 | 09:03 | 40.0% | ✅ Done | Residual re-fire, closed (prior CTO) |
| PRA-1110 | 10:08 | — | ✅ Done | Residual re-fire, closed (prior agent) |
| PRA-1121 | 11:13 | — | ✅ Done | Residual re-fire, closed (prior agent) |
| PRA-1135 | 12:18 | — | ✅ Done | Residual re-fire, closed (prior agent) |
| PRA-1145 | 13:24 | — | ✅ Done | Residual re-fire, closed (prior agent) |
| **PRA-1157** | **14:29** | **92.8%** | **This heartbeat** | Residual re-fire, closed — site UP |

Availability is recovering: 40.0% (09:03) → 92.8% (14:29). The remaining ~7.2% unavailability (~1h 44min) is the tail of the known outage blocks still within the trailing 24h window. Last block (08:50–09:15 UTC) exits the window at ~09:15 UTC on 2026-08-21.

## StandardSLA Dedup Status

PRA-1156 (14:56 UTC) implemented `server/src/services/standard-sla-dedup.ts` — a duplicate-suppression module for StandardSLABreach alerts, mirroring the Premium-tier dedup. The fix:
- ✅ Is written and wired in the working tree (`server/src/routes/issues.ts`, `server/src/services/standard-sla-dedup.ts`)
- ✅ Was verified in PRA-1156 (esbuild transpile clean, import resolves, pattern matches)
- ❌ **Not deployed** — the production server (PID 51526, `com.praesyn.paperclip` launchd service) started at 05:49 UTC, predating the fix. The fix requires a server restart to load.
- The working tree also contains in-progress Voyonder M2 work (VOY-1493, still under review per VOY-1520) — restarting now would deploy unreviewed unreleased code. Deployment is gated on M2 landing or a targeted deploy.

## Residual Risk

- PRA-1158, 1159, etc. will continue firing at ~55 min intervals until ~09:15 UTC Aug 21, when the last outage block exits the 24h window.
- The dedup fix will suppress these once deployed — but requires a server restart that also deploys M2 changes.
- Standard SLA credit: 92.8% < 99.5% threshold. Per policy, 5% credit per 30 min below threshold. Service credit is a business decision for the account owner (Ben).

## Actions Taken

1. Verified southeastaksupply.com externally: HTTP 200 × 2 (0.51s, 1.10s), TLS valid, Next.js serving normally.
2. Checked issue lineage: 6 consecutive southeastaksupply SLA re-fires since 09:03 UTC, all residual.
3. Confirmed StandardSLA dedup fix exists but is not deployed (server predates fix; working tree has mixed M2 changes preventing safe isolated restart).
4. Determined self-resolve ETA: ~09:15 UTC 2026-08-21 (last outage block exits 24h window).
5. Wrote this status doc.

## Files Written

- `doc/status/2026-08-20-1502-cto-pra-1157-sla-breach-southeastaksupply.md` (this file)

## Disposition

**DONE** — PRA-1157 is a residual re-fire of the Aug 19–20 incident fixed in PRA-1093. Site is UP and stable (HTTP 200, verified). The StandardSLA dedup fix (PRA-1156) exists but awaits server restart for deployment; the alert storm will self-resolve at ~09:15 UTC 2026-08-21. No new action required for this specific issue.

---

*CTO, PraeSyn, LLC*