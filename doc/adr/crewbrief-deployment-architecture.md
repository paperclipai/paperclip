# ADR-002: CrewBrief Production Deployment Architecture

**Date:** 2026-05-22
**Status:** Accepted
**Author:** Hunter (CTO)
**Supersedes:** ADR-001

## Context

CrewBrief is a permanent production application for aviation crew briefing delivery.
Its API routes, landing page, blog engine, email nurture sequences, HubSpot CRM sync,
and PostHog analytics all run as services within the existing Paperclip monorepo.

This ADR documents the actual production deployment architecture as it exists today,
replacing the Railway-centric proposal in ADR-001 that was never implemented.

## Architecture Overview

```
                         ┌──────────────────────┐
                         │     Cloudflare DNS    │
                         │  crewbrief.avva.aero  │
                         └──────────┬───────────┘
                                    │
                         ┌──────────┴───────────┐
                         │    Hostinger VPS      │
                         │   (Ubuntu / Docker)   │
                         │                      │
                         │  ┌────────────────┐   │
                         │  │    nginx        │   │
                         │  │  (port 443/80)  │   │
                         │  │  TLS via certbot │   │
                         │  └───────┬────────┘   │
                         │          │            │
                         │  ┌───────┴────────┐   │
                         │  │ Paperclip Server │   │
                         │  │ (port 3100)     │   │
                         │  │                 │   │
                         │  │ /api/crewbrief/* │   │
                         │  │ crewbrief.avva   │   │
                         │  │ .aero landing    │   │
                         │  │   + blog         │   │
                         │  └─────────────────┘   │
                         │                        │
                         │  ┌────────────────┐   │
                         │  │ PostgreSQL      │   │
                         │  │ (port 5432)     │   │
                         │  └────────────────┘   │
                         │                        │
                         │  ┌────────────────┐   │
                         │  │ Umami Analytics │   │
                         │  │ (port 3456)     │   │
                         │  └────────────────┘   │
                         └────────────────────────┘
```

## Components

### 1. Hostinger VPS (Infrastructure Host)

- **Provider:** Hostinger (VPS)
- **OS:** Ubuntu
- **Deployment:** Docker Compose (see `docker/docker-compose.yml`)
- **Docker services:** `server` (Paperclip + CrewBrief), `db` (PostgreSQL 17)

### 2. nginx (Reverse Proxy / TLS Termination)

- Terminates TLS via Let's Encrypt (certbot)
- Reverse proxies `crewbrief.avva.aero` → `localhost:3100`
- Reverse proxies the main Paperclip domain → `localhost:3100`
- Handles HTTP/2, security headers, rate limiting

### 3. Paperclip Server (Application Host)

- **Port:** 3100
- **Image:** Built from the repo root `Dockerfile` (full Paperclip server, not `Dockerfile.crewbrief`)
- **CrewBrief routes mounted at:** `/api/crewbrief` (Express router)
- **CrewBrief landing page:** Served at `crewbrief.avva.aero/` (virtual hosting by `Host` header)
- **CrewBrief blog:** Served at `crewbrief.avva.aero/blog/*`
- **Umami proxy:** `/umami/*` → `localhost:3456`
- **Nurture scheduler:** Runs in-process via `setInterval` (60s poll)

### 4. PostgreSQL (Database)

- **Version:** 17 (Alpine)
- **Port:** 5432
- **Runs as:** Docker container (`postgres:17-alpine`) co-located on the VPS
- **Managed by:** Drizzle ORM (schema definitions in `packages/db/src/schema/crewbrief_waitlist.ts`)
- **Backups:** Handled by VPS-level backup strategy

### 5. Umami Analytics

- **Port:** 3456
- **Purpose:** Privacy-preserving analytics for the CrewBrief landing page
- **Access:** Proxied through the Paperclip server to avoid CORS/ad-blocker issues

## Key Differences from ADR-001 (Railway Proposal)

| Aspect | ADR-001 Proposal | Actual Implementation |
|--------|-----------------|----------------------|
| Hosting platform | Railway (standalone) | Hostinger VPS (co-located) |
| Container | `Dockerfile.crewbrief` (slim, API-only) | Root `Dockerfile` (full server) |
| Database | Railway PostgreSQL | Co-located PostgreSQL container |
| Secrets | Railway encrypted store | VPS environment / `.env` file |
| TLS | Railway automatic | nginx + Let's Encrypt (certbot) |
| Deployment CI | GitHub Actions → Railway `railway up` | Manual Docker Compose deploy |
| Cron | Railway Cron Jobs | GitHub Actions scheduled workflow |
| Monitoring | Sentry + Better Stack | Umami + server logs |
| HubSpot env vars | Railway CLI (`set-hubspot-env-vars.yml`) | SSH-based `.env` update (`set-hubspot-env-vars.yml`, updated 2026-05-22) |

## Deployment Model

The CrewBrief API is **not deployed as a separate service**. It shares the same Node.js
process, the same database connection pool, and the same Express server instance as the
Paperclip application. This simplifies operations at the cost of:
- No independent scaling of CrewBrief traffic
- Coupled release cycle (CrewBrief changes ship with Paperclip server deploys)
- Shared resource contention (CPU, memory, DB connections)

If CrewBrief traffic grows to warrant separation, the `Dockerfile.crewbrief` and
`railway.json` files exist as a reference implementation for extraction.

## DNS & Domains

- **CrewBrief:** `crewbrief.avva.aero` → VPS IP (Cloudflare DNS)
- **Main Paperclip:** Separate domain → same VPS IP (nginx virtual hosting)

The application-level routing is hostname-aware:
- `crewbrief.avva.aero` → CrewBrief landing page, blog, Umami proxy
- Other hostnames → Paperclip UI (if served) or 404

## Scheduled Tasks

- **Daily nurture enrollment check:** GitHub Actions (`crewbrief-daily-cron.yml`) calls
  `POST https://crewbrief.avva.aero/api/crewbrief/nurture/check-enrollments`
- **Daily scheduled email processing:** Same workflow calls
  `POST https://crewbrief.avva.aero/api/crewbrief/nurture/process-scheduled`
- **In-process scheduler:** The nurture service runs a `setInterval` every 60s in
  production to process time-sensitive email sends (not reliant solely on the daily cron)

## Future Extraction Path

If CrewBrief requires independent scaling or deployment:

1. Create a separate Railway/Fly.io project (or another VPS)
2. Use the existing `Dockerfile.crewbrief` (already in repo) to build a slim API-only image
3. Point a subdomain (e.g., `api.crewbrief.app`) to the new deployment
4. Share the existing PostgreSQL database (or provision a dedicated one)
5. Update `CREWBRIEF_BASE_URL` and related env vars to point to the new deployment
6. Migrate the GitHub Actions cron to target the new API URL

The reverse path (scaling down/consolidation) is also straightforward since no
Railway-specific APIs are used.
