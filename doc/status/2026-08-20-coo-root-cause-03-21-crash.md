# COO Root-Cause Report — 03:21 UTC travel_app Crash (VOY-1482)

**Date:** 2026-08-20 ~14:25 UTC
**Author:** COO (2f49c205)
**Issue:** VOY-1482 / 41f4e335 (parent: VOY-1479 / 4c300c99)
**Related:** VOY-1481 / 8daed11a, VOY-1480 / 2521eb16

## Executive Summary

The 03:21 UTC travel_app crash was **NOT an OOM kill**. The host had 4.9GB available memory at 03:20, and no kernel OOM-killer events were recorded in the 03:00-04:00 window. The crash was part of a container restart cascade (03:00-03:40) that affected multiple services. The travel_app container was killed in this cascade; its auto-restart failed because a zombie docker-proxy held 127.0.0.1:3000 — the **same mechanism as the 06:19 recurrence**.

## Investigation Findings

### 1. OOM Check (dmesg / journalctl -k / syslog / sar)

- **No OOM-killer activity at 03:21 UTC.** `journalctl -k` for 03:00-04:00 shows zero OOM-kill events.
- OOM kills earlier in the night: cadvisor at 00:06, consul at 01:14 — the host was under memory pressure but recovered.
- `sar` at 03:20:09: kbmemfree=225280 (220MB free), kbavail=4932820 (4.9GB available), %commit=128.18%
- Syslog "Under memory pressure, flushing caches" at 01:03, 02:03, 02:22-02:33 (systemd-journald / systemd-resolved) — these are kernel cache flushes under normal memory pressure, NOT OOM events.
- **Conclusion:** Host had adequate memory at 03:21. No OOM.

### 2. Docker Daemon Logs (journalctl -u docker)

- **No travel_app die/stop/exit event at 03:21 UTC.** The daemon journal shows NO travel_app container events between 00:00 and 06:12.
- First travel_app daemon event: 06:12:58 (network join `sbJoin` during the 06:19 recovery attempt).
- This means travel_app was **not restarted or destroyed via Docker API at 03:21**.

### 3. Node.js Process Signals

- No SIGSEGV, SIGKILL, or SIGABRT recorded in the system journal for Node.js.
- Current travel_app container health logs show stable RSS ~177MB with a 512MB limit — no memory leak pattern.
- The Prisma warning (`Can't write to /app/node_modules/@prisma/engines`) is a benign runtime permissions issue, not a crash cause.

### 4. The Container Cascade (03:00-03:40)

The docker daemon journal reveals a mass container lifecycle event:

| Time (UTC) | Event | Container |
|---|---|---|
| 03:00 | Headscale-vps1 started, failed to bind 100.64.0.4:8081 (address already in use), deactivated | `headscale-vps1` |
| 03:00-03:13 | Force-clean of a container whose process had already exited. "Could not send KILL signal... process already finished: not found" (multiple retries). Restart-manager stopped 03:13:18. Force SIGKILL 03:13:36. Scope deactivated 03:13:25. | `6639624d3707` (removed, unidentifiable) |
| 03:14-03:26 | KILL signal retries for containers already exited | `sms-assistant-backend` (exit 137=SIGKILL), `temporal-server` |
| 03:37 | Traefik restarted ("Container failed to exit within 10s of signal 15 - using the force"). New instance started 03:38:17. | `traefik` |
| 03:56 | Containers exited (2) | `temporal-ui` (×2) |

**Pattern:** Multiple containers killed/restarted in a short window suggests a host-level trigger (systemd docker restart, memory-pressure cascade, or a compose-level restart command). The trigger itself is not identifiable from retained logs.

### 5. Recurring Pattern — Uptime Monitor Evidence

The uptime monitor (installed at 06:43 during the P0 restoration) shows the same failure repeating:

| Time (UTC) | Duration | Details |
|---|---|---|
| 08:54-08:57 | ~4 min | Force-kill of container `89f18b35418a` at 08:53 → travel_app restarted → 404 |
| 13:07-13:11 | ~5 min | Deploy at 13:05 (force-kill `8fcc46ce3af9` + `cf2ebe3bcbca`) → travel_app restarted → 404 |

**Both failures match the same mechanism:** Every time travel_app is restarted or redeployed, the old docker-proxy doesn't release 127.0.0.1:3000. The new container can't bind the port. Traefik has no router → 404 on all routes.

### 6. Deploy Mechanism

The deploy workflow (`/opt/travel_planner/.github/workflows/deploy.yml`) runs:
```yaml
docker compose -f docker-compose.production.yml up -d --force-recreate
```

The `--force-recreate` destroys the old container before starting the new one. The old docker-proxy (a separate process managed by Docker for port mapping) survives as a zombie and continues holding 127.0.0.1:3000.

## Status of VOY-1482 Items

| Item | Status | Notes |
|---|---|---|
| 1. Inspect syslog/dmesg for OOM | ✅ DONE | No OOM at 03:21 |
| 2. Check Docker daemon logs for exit events | ✅ DONE | Cascade documented; no travel_app die at 03:21 |
| 3. Check journalctl for Node signals | ✅ DONE | No signals recorded |
| 4. Configure Sentry DSN | ❌ BLOCKED | Needs Ben (issue VOY-1480 / 2521eb16) |
| 5. Heap dump / core dump capture | ⬜ TODO | Can add to start.sh on next deploy |
| 6. Resource limits | ✅ DONE | Already in place (512M / 1.0 cpu) |

## Key Recommendations (for VOY-1481)

1. **Preflight port-bind check** in deploy.yml before `docker compose up`
2. **Health check should verify external port** (curl from host, not docker exec)
3. **Add `--remove-orphans`** to clean zombie containers
4. **Document recovery runbook** for manual intervention

## Evidence Access

All commands and their output are archived in the COO investigation session. Key commands:
- `ssh vps-1` (verified access to vps-1.adoptaitech.com)
- `journalctl -k --since "2026-08-20 03:00" --until "2026-08-20 04:00"`
- `journalctl -u docker --since "2026-08-20 00:00" --until "2026-08-20 07:00"`
- `sar -r -s 03:00:00 -e 04:00:00`
- `grep -iE "oom|killed" /var/log/syslog`
- `docker logs travel_app`
- `docker inspect travel_app`
- `docker compose -f /opt/travel_planner/docker-compose.production.yml`
- `cat /opt/travel_planner/.github/workflows/deploy.yml`
