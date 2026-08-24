# CTO Heartbeat — PRA-1096 StandardSLABreach: southeastaksupply.com

**Date:** 2026-08-20 ~11:14 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1096 [CRITICAL] StandardSLABreach: southeastaksupply.com
**Disposition:** ✅ Done — re-fire of resolved incident, no new downtime

---

## Summary

SLA monitoring fired at 09:03 UTC: southeastaksupply.com 24h availability at 40.0%, below the 99.5% Standard SLA.

### Assessment: Re-fire — No New Downtime Since Fix

This is a **re-fire** of the Aug 19–20 incident cascade, which was already resolved by PRA-1093. There is **no new downtime** since the Traefik config fix at 09:17 UTC.

## Verification

| Check | Result |
|-------|--------|
| https://southeastaksupply.com/ (external) | HTTP 200 ✅ 0.52s |
| /healthz (through Traefik) | HTTP 307 (expected redirect) |
| Container southeastaksupply-alaska-supply | Up 2h, RestartCount=0, IP 172.19.0.3 ✅ |
| Traefik config (`/docker/traefik/dynamic/southeastaksupply.yml`) | 172.19.0.3:3000 ✅ (matches pinned IP) |
| IP pinning (`docker-compose.production.yml`) | `ipv4_address: 172.19.0.3` ✅ |
| DB (southeastaksupply-db) | accepting connections ✅ |
| Uptime Kuma (#14 SE AK Supply) | 24 consecutive HTTP 200 since 09:20 UTC ✅ |

## Uptime Kuma Heartbeat Data (last 24h)

| Metric | Value |
|--------|-------|
| Successful checks (status=1) | 226 |
| Failed checks (status=0) | 13 |
| Last failure | 2026-08-20 09:15:26 UTC — HTTP 503 |
| First recovery | 2026-08-20 09:20:29 UTC — HTTP 200 |

**Downtime clusters:**
- Aug 19 18:57–22:52 — DB connection pool exhaustion, DNS resolution failures
- Aug 20 00:58–03:51 — DB connection pool exhaustion
- Aug 20 08:50–09:15 — HTTP 503 (Traefik misrouting to stale container IP)

## Root Cause

Same incident as PRA-1093/PRA-1089/PRA-1088: the Aug 19–20 cAdvisor OOM cascade caused Docker daemon restart → container network reattach → stale Traefik IP. Container IP was pinned and Traefik config corrected at 09:17 UTC.

## Known Gap

Standard-tier SLA alerts lack re-fire suppression (Premium has it per PRA-693). This issue will continue to re-fire as long as the sliding 24h window contains any of the Aug 19–20 outage blocks. The last block drops out at ~09:15 UTC on 2026-08-21.

## Files Written

- `doc/status/2026-08-20-1114-cto-pra-1096-sla-breach-southeastaksupply.md` (this file)

## Disposition

**DONE** — PRA-1096 handled. Root cause fixed by PRA-1093. No new action required. Site is UP and stable (HTTP 200, verified across 24 consecutive Uptime Kuma checks). Alert will self-resolve once the 24h window clears.

---

*CTO, PraeSyn, LLC*
