---
phase: 02-network-exposure
plan: 01
subsystem: docker-networking
tags: [docker, traefik, networking, betterauth, compose]
dependency_graph:
  requires: [01-03-SUMMARY.md]
  provides: [traefik-net network attachment, PAPERCLIP_PUBLIC_URL HTTPS correction]
  affects: [02-02-PLAN.md, 02-03-PLAN.md]
tech_stack:
  added: []
  patterns: [external Docker network via traefik-net, PAPERCLIP_PUBLIC_URL env var correction]
key_files:
  created: []
  modified:
    - docker/docker-compose.yml
    - docker-001:/opt/paperclip/docker/.env (remote)
decisions:
  - "D-02: server container joins traefik-net as external network; db service stays on default only"
  - "D-07: PAPERCLIP_PUBLIC_URL updated to https://pc.thelaljis.com on docker-001"
metrics:
  duration: "3m"
  completed: "2026-04-02"
  tasks: 2
  files: 2
---

# Phase 2 Plan 1: Traefik Network Wiring + Public URL Correction Summary

**One-liner:** Attached Paperclip server container to traefik-net external network and corrected PAPERCLIP_PUBLIC_URL to https://pc.thelaljis.com so Traefik can route to it and BetterAuth accepts logins.

## What Was Done

### Task 1: Add traefik-net external network to docker/docker-compose.yml

Added two additive changes to `docker/docker-compose.yml`:

1. `networks: [default, traefik-net]` block under the `server` service (after `depends_on`)
2. Top-level `networks: traefik-net: external: true` block at end of file

The `db` service intentionally has no `traefik-net` attachment — the database must not be reachable from Traefik's network. The `default` network entry on the server service preserves db↔server communication.

**Commit:** `fe1df9a8`

### Task 2: Update PAPERCLIP_PUBLIC_URL on docker-001 and restart the stack

Three sequential steps executed via SSH:

1. Copied updated `docker/docker-compose.yml` to `root@docker-001:/opt/paperclip/docker/docker-compose.yml` via scp
2. Updated `PAPERCLIP_PUBLIC_URL` in `/opt/paperclip/docker/.env` from `http://192.168.50.117:3100` to `https://pc.thelaljis.com` via `sed -i`
3. Restarted stack via `docker compose up -d` — both containers recreated and came up healthy

**Verification results:**
- `PAPERCLIP_PUBLIC_URL=https://pc.thelaljis.com` confirmed in remote `.env`
- `docker-server-1` shows `Up (healthy)`, `docker-db-1` shows `Up (healthy)`
- `docker inspect docker-server-1` network list: `docker_default` and `traefik-net` (both present)

No local file changes for Task 2 (remote-only). Task 1 commit covers all local repo changes.

## Decisions Made

| Decision | Details |
|----------|---------|
| D-02 applied | server service joined traefik-net; db intentionally excluded |
| D-07 applied | PAPERCLIP_PUBLIC_URL=https://pc.thelaljis.com on docker-001 |
| Port 3100:3100 preserved | Removal deferred per CONTEXT.md (Traefik confirmation first) |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `docker/docker-compose.yml` contains `traefik-net` in server networks and top-level external declaration: CONFIRMED
- `docker-001:/opt/paperclip/docker/.env` contains `PAPERCLIP_PUBLIC_URL=https://pc.thelaljis.com`: CONFIRMED
- `docker-server-1` attached to `traefik-net`: CONFIRMED
- Both containers healthy: CONFIRMED
- Commit `fe1df9a8` exists: CONFIRMED
