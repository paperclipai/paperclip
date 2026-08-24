# CTO Incident Response: PRA-1078 — ServiceDownAllRegions: unknown

**Date:** 2026-08-20 ~07:50 UTC
**Agent:** CTO (cccf9a46)
**Issue:** PRA-1078 [CRITICAL] ServiceDownAllRegions: unknown
**Status:** 🟢 RESOLVED — HTTPS endpoint restored

---

## Summary

SLA monitoring reported `https://paperclip.praesyn.int/api/health` unreachable from all monitoring regions.

Investigation showed the Paperclip API server itself was **healthy** (HTTP 200 on `localhost:3100`, `100.64.0.7:3100`, and `paperclip.praesyn.int:3100`). The outage was at the **TLS termination layer**: Caddy (the reverse proxy that serves `paperclip.praesyn.int:443` → `localhost:3100`) was **not running**, and nothing was listening on port 443.

## Root Cause

| Component | State |
|-----------|-------|
| Paperclip API server (`com.praesyn.paperclip`, :3100) | ✅ Healthy (200 on all HTTP checks) |
| Caddy reverse proxy (`paperclip.praesyn.int:443` → `localhost:3100`) | ❌ **NOT RUNNING** — nothing listening on :443 |
| Caddy launchd service (`homebrew.mxcl.caddy`) | ❌ **NOT LOADED** — `brew services` showed "none"; no launchd agent registered |

Caddy is installed (Homebrew, v2.11.4) with a saved config (`/Users/benh/.paperclip/Caddyfile`, matching Caddy's `autosave.json`) but was never registered as a supervised service. After the last reboot/crash, nothing restarted it → HTTPS:443 went down → SLA monitor (which probes the HTTPS URL) saw DOWN from all regions.

## Remediation

1. **Verified server health** — `http://paperclip.praesyn.int:3100/api/health` → 200, `localhost:3100` → 200, `100.64.0.7:3100` → 200.
2. **Confirmed Caddy config** — `/Users/benh/.paperclip/Caddyfile` proxies `paperclip.praesyn.int` → `localhost:3100` with logging to `~/.paperclip/logs/caddy.log`. Added `tls internal` so Caddy serves a locally-issued cert for the Tailscale-only hostname (CGNAT 100.64.0.7 — not publicly resolvable, so no public CA cert is possible).
3. **Registered Caddy as a supervised launchd agent** — created `~/Library/LaunchAgents/homebrew.mxcl.caddy.plist` (KeepAlive + RunAtLoad + ThrottleInterval 10s), then `launchctl bootstrap gui/501`.
4. **Verified HTTPS restored** — `https://paperclip.praesyn.int/api/health` → **200 OK** (HTTP/2 via Caddy), confirmed in Caddy access log.

## Verification

```
https://paperclip.praesyn.int/api/health  -> 200 OK  (HTTP/2, TLS, Via: Caddy)
http://paperclip.praesyn.int:3100/api/health -> 200 OK
http://localhost:3100/api/health         -> 200 OK
lsof -i :443                              -> caddy LISTEN (PID 35928)
```

## Follow-up

- PRA-1082 (created): verify SLA monitor clears on its next probe cycle; consider adding Caddy process/port checks to the instance monitor so TLS termination is covered alongside the API server.

## Disposition

**PRA-1078:** ✅ Done — HTTPS endpoint restored, root cause (unsupervised Caddy) fixed with launchd supervision so it survives reboots.

---

*CTO, PraeSyn, LLC*
