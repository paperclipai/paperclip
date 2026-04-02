# Roadmap: Paperclip AI — Production Deployment

## Overview

Three phases take the existing Docker Compose setup from a development skeleton to a hardened, publicly accessible deployment with agents connected. Phase 1 closes all the compose and security gaps so the stack runs safely on the host. Phase 2 wires Traefik, Cloudflare SSL, and Technitium DNS so the dashboard is reachable from a browser over HTTPS. Phase 3 loads provider API keys and verifies at least one agent session is live.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Compose Foundation** - Harden the Docker Compose stack so services start, stay up, and are not exposed insecurely
- [ ] **Phase 2: Network Exposure** - Route HTTPS traffic through Traefik + Cloudflare to the Paperclip container with a valid certificate
- [ ] **Phase 3: Agent Connectivity** - Load provider API keys and verify at least one agent session is live in the dashboard

## Phase Details

### Phase 1: Compose Foundation
**Goal**: The Paperclip stack starts with a single command, survives crashes, and has no insecure defaults
**Depends on**: Nothing (first phase)
**Requirements**: CONT-01, CONT-02, CONT-03, CONT-04, SEC-01, SEC-02, SEC-03, SEC-04
**Success Criteria** (what must be TRUE):
  1. `docker compose up -d` from the project directory starts both services without errors
  2. The server container's health check reports healthy (visible in `docker ps`)
  3. Both services restart automatically after a `docker kill` without manual intervention
  4. PostgreSQL port 5432 is not reachable from outside the Docker network
  5. A `.env.template` file exists with every required variable documented
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Harden docker-compose.yml and add HEALTHCHECK to Dockerfile
- [x] 01-02-PLAN.md — Create docker/.env.template with all variables documented
- [x] 01-03-PLAN.md — Human verification: start stack on docker-001 and confirm all success criteria

### Phase 2: Network Exposure
**Goal**: The Paperclip dashboard is accessible via a subdomain with a valid Let's Encrypt certificate
**Depends on**: Phase 1
**Requirements**: NET-01, NET-02, NET-03, NET-04
**Success Criteria** (what must be TRUE):
  1. Navigating to the Paperclip subdomain in a browser loads the dashboard login page over HTTPS
  2. The browser shows a valid certificate (no warnings)
  3. The subdomain resolves correctly from the internal network via Technitium
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — Join traefik-net network in compose + update PAPERCLIP_PUBLIC_URL on docker-001
- [x] 02-02-PLAN.md — Add paperclip router + service to Traefik's dynamic services.yml
- [x] 02-03-PLAN.md — Create Technitium A record + human verification of HTTPS dashboard access

### Phase 3: Agent Connectivity
**Goal**: At least one AI agent connects and is visible and working in the Paperclip dashboard
**Depends on**: Phase 2
**Requirements**: AGENT-01, AGENT-02
**Success Criteria** (what must be TRUE):
  1. An agent session is visible in the Paperclip dashboard after connecting
  2. The agent can receive and execute a task from the dashboard
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Compose Foundation | 2/3 | In Progress|  |
| 2. Network Exposure | 0/3 | Not started | - |
| 3. Agent Connectivity | 0/? | Not started | - |

## Backlog

### Phase 999.1: Integrate Front End with Authentik (BACKLOG)

**Goal:** Integrate Paperclip's frontend authentication with Authentik identity provider
**Requirements:** TBD
**Plans:** 2/3 plans executed

Plans:
- [ ] TBD (promote with /gsd:review-backlog when ready)
