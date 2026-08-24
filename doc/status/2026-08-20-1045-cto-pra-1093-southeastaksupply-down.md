# CTO Heartbeat — PRA-1093 ServiceDownAllRegions: southeastaksupply.com

**Date:** 2026-08-20 ~10:45 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1093 [CRITICAL] ServiceDownAllRegions: southeastaksupply.com
**Disposition:** ✅ Done — site recovered, root cause addressed, durable hardening applied

---

## Summary

SLA monitoring fired at ~08:50 UTC: https://southeastaksupply.com/ unreachable from all
monitoring regions. Investigation revealed a stale container IP in the Traefik static config
after the container was recreated during the vps-2 memory-pressure cascade. The fix was
applied at 09:17 UTC (site recovered 09:20 UTC) — likely by a previous agent run or oncall
automation. This heartbeat verified recovery, documented the root cause, and applied durable
hardening to prevent recurrence.

## Verification Timeline

| Time (UTC) | Check | Result |
|------------|-------|--------|
| 09:15:26 | Uptime Kuma (#14 SE AK Supply) | HTTP 503 |
| 09:16:37 | Traefik health check (last failure) | connection refused to 172.19.0.4:3000 |
| 09:17:05 | southeastaksupply.yml modified | IP corrected (.4 → .3) |
| 09:20:29 | Uptime Kuma (#14) | HTTP 200 ✅ First recovery |
| 10:40 | https://southeastaksupply.com/ (external) | HTTP 200 ✅ |
| 10:41 | /healthz (through Traefik) | Redirect to /login (expected) |
| 10:45 | https://southeastaksupply.com/ (external) | HTTP 200 ✅ 0.45s |
| 10:51 | https://southeastaksupply.com/ (external) | HTTP 200 ✅ |

## Root Cause

The `southeastaksupply-alaska-supply` container (Next.js + PostgreSQL, deployed via
docker-compose at `/docker/southeastaksupply/`) was **recreated at ~08:46 UTC** as part of
the same vps-2 container restart cascade that affected crm.praesyn.com (PRA-1089),
conn.praesyn.com (PRA-1107), and others in the 08:50 UTC alert wave.

When Docker recreated the container, it was assigned a **new IP on the `traefik-public`
network** (172.19.0.3). The Traefik file-provider config at
`/docker/traefik/dynamic/southeastaksupply.yml` still pointed at the **old IP
(172.19.0.4)**, which now belonged to the infisical container (no process listening on
port 3000).

Because Traefik uses the **file provider** (`--providers.file.directory=/dynamic`, no
Docker provider) and runs with **host networking** (cannot resolve container DNS names),
all routing relies on hard-coded container IPs. When a container's IP changes on
recreation, the static file becomes stale → health checks fail → all requests return 503
→ monitoring alerts fire.

**Traefik health-check logs (pre-fix):**
```
WRN Health check failed: Get "http://172.19.0.4:3000/": connection refused
  serviceName=alaska-supply@file targetURL=http://172.19.0.4:3000
```

**Current container IP** (traefik-public): `172.19.0.3` (matches the corrected config)

## Why This Happened Now

The same vps-2 incident as PRA-1089 (crm.praesyn.com). That heartbeat documented the
root cause as "residual instability from the Aug 19–20 vps-2 cAdvisor OOM incident (112+
zombie wget processes)." Multiple containers (crm, alaska-supply, headscale) were affected.

The `/docker/traefik/dynamic/southeastaksupply.yml` config was corrected at **09:17:05
UTC** (file modification time). The monitoring recovered at 09:20 UTC. A `[RESOLVED]`
auto-generated issue (id `19f762a5`) was created at 10:15 UTC.

## Actions Taken

### Already Done (at 09:17 UTC, by prior agent/oncall)
- Corrected the stale container IP in `/docker/traefik/dynamic/southeastaksupply.yml`
  from `172.19.0.4` → `172.19.0.3`

### Done This Heartbeat (10:45 UTC)

1. **Verified recovery end-to-end**: 3 consecutive HTTP 200 checks from external network
   (10:40-10:51 UTC). Uptime Kuma monitor shows 200 OK continuously since 09:20 UTC with
   response times 100–800ms.

2. **Pinned container IP in docker-compose** (`/docker/southeastaksupply/docker-compose.production.yml`):
   Added `ipv4_address: 172.19.0.3` to the alaska-supply service on the `traefik-public`
   network. This ensures future container recreates (deployments, restarts) keep the same
   IP, preventing Traefik static-config drift.

3. **Fixed stale Grafana IP in monitor.yml** (`/docker/traefik/dynamic/monitor.yml`):
   The Grafana monitoring dashboard had the same class of bug — its Traefik config still
   pointed to `172.19.0.3:3000` (now the Alaska Supply container), while Grafana had
   moved to `172.19.0.5:3000` during the same container shuffle. This meant
   `https://monitor.praesyn.com/` was **serving the Southeast Alaska Supply website
   instead of Grafana**. Corrected to `172.19.0.5:3000` — verified Grafana health via
   `/api/health` — Traefik auto-reloaded (`providers.file.watch=true`) and
   `monitor.praesyn.com` now correctly serves Grafana (302 → /login).

4. **Backed up original configs** before modifying.

## Durable Hardening Applied

| Change | File | Effect |
|--------|------|--------|
| IP pinning | `docker-compose.production.yml` (alaska-supply) | Container keeps 172.19.0.3 on recreate |
| Grafana IP fix | `/docker/traefik/dynamic/monitor.yml` (.3 → .5) | monitor.praesyn.com serves correct backend |

### Remaining Risk: Same Class on Other Services

All Traefik file-provider configs using hard-coded container IPs are vulnerable to the
same drift. The full inventory:

| Service | Config File | Backend URL | Actual IP (2026-08-20) | Status |
|---------|------------|-------------|------------------------|--------|
| southeastaksupply | southeastaksupply.yml | 172.19.0.3:3000 ✅ | 172.19.0.3 ✅ | Fixed |
| monitor/grafana | monitor.yml | 172.19.0.5:3000 ✅ | 172.19.0.5 ✅ | Fixed this heartbeat |
| kineticwork.co | kineticwork.yml | 172.19.0.6:80 ✅ | 172.19.0.6 ✅ | OK |
| headscale | headscale.yml | 172.19.0.1:8080 | (gateway, stable) | PRA-1107 |
| crm | crm.yml | 127.0.0.1:3001 ✅ | host port (stable) | OK |
| paperclip | paperclip.yml | macbook.praesyn.int:3100 ✅ | MagicDNS (stable) | OK |
| travel/voyonder | travel.yml | 100.64.0.6:443 ✅ | Tailscale IP (stable) | OK |

The remaining container-service backends (kineticwork at .6) are currently matched but
would drift if those containers were recreated. A system-wide durable fix would be to
enable Traefik's Docker provider (the compose files already have the labels) or pin IPs
across all compose projects.

## Related Issues

- **PRA-1089** [CRITICAL] ServiceDownAllRegions: crm.praesyn.com — same 08:50 UTC wave,
  same root cause class (container OOM/recreate cascade)
- **PRA-1107** [CRITICAL] ServiceDownAllRegions: conn.praesyn.com — headscale container
  still down (separate issue, not addressed here)
- **PRA-1109** [RESOLVED] — auto-generated resolved notice for southeastaksupply.com
  (created 10:15 UTC)

## Files Written

- `doc/status/2026-08-20-1045-cto-pra-1093-southeastaksupply-down.md` (this file)

## Disposition

**DONE** — PRA-1093 handled.

- southeastaksupply.com verified UP (HTTP 200, stable, 3+ checks)
- Root cause identified and documented (stale Traefik IP after container recreate)
- Container IP pinned in docker-compose (durable, takes effect on next deploy/recreate)
- Stale Grafana IP in monitor.yml discovered and fixed (same class, actively misrouting)
- Backups created before all changes

Next: **PRA-1107** (conn.praesyn.com/headscale) remains open — the headscale container
is `Exited (128)` and `conn.praesyn.com` returns 502. That issue was in the same 08:50
UTC alert wave.

---

*CTO, PraeSyn, LLC*
