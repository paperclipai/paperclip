# Requirements: Paperclip AI — Production Deployment

**Defined:** 2026-04-01
**Core Value:** The Paperclip dashboard is running and accessible, with agents able to connect and receive tasks.

## v1 Requirements

Requirements for initial production deployment. Each maps to roadmap phases.

### Container Setup

- [x] **CONT-01**: Docker Compose builds and starts server + database services with a single `docker compose up`
- [x] **CONT-02**: Server container has HEALTHCHECK wired to `/health` endpoint
- [x] **CONT-03**: All services have restart policies for crash recovery
- [x] **CONT-04**: Template `.env` file documents all required environment variables with descriptions

### Security

- [x] **SEC-01**: `BETTER_AUTH_SECRET` is generated and injected via `.env`
- [x] **SEC-02**: PostgreSQL port 5432 is not exposed to the host network
- [x] **SEC-03**: `PAPERCLIP_PUBLIC_URL` is set to the actual browser-accessible URL
- [x] **SEC-04**: `USER_UID`/`USER_GID` build args configured for correct volume permissions

### Networking

- [ ] **NET-01**: Traefik file provider config routes traffic to the Paperclip server container
- [x] **NET-02**: Cloudflare DNS challenge configured for Let's Encrypt SSL via Traefik
- [ ] **NET-03**: Technitium internal DNS record points to Paperclip on docker-001
- [x] **NET-04**: Paperclip is accessible via its subdomain with valid HTTPS

### Agent Connectivity

- [ ] **AGENT-01**: API keys for AI providers (Anthropic, OpenAI, etc.) configured in `.env`
- [ ] **AGENT-02**: At least one agent session is visible and working in the Paperclip dashboard

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Operational Hardening

- **OPS-01**: Postgres credential rotation procedure documented
- **OPS-02**: Connection pool tuning for 20+ concurrent agents
- **OPS-03**: Image version pinning (beyond `:lts` tags)
- **OPS-04**: Volume backup/restore runbook

### Monitoring

- **MON-01**: Container resource monitoring (CPU, memory, disk)
- **MON-02**: Agent cost tracking configured in Paperclip UI
- **MON-03**: Alerting on service health degradation

## Out of Scope

| Feature | Reason |
|---------|--------|
| SSL/TLS termination in Paperclip | Handled by Traefik + Cloudflare |
| Monitoring/alerting stack | Deferred to post-launch |
| Backup automation | Deferred to post-launch |
| Custom plugins or extensions | Vanilla install first |
| Separate UI container (Nginx) | Server already serves compiled UI — anti-pattern per architecture |
| Multi-environment compose overrides | Single production environment for now |
| Kubernetes/Swarm | Docker Compose is sufficient for 5-20 agents |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONT-01 | Phase 1 | Complete |
| CONT-02 | Phase 1 | Complete |
| CONT-03 | Phase 1 | Complete |
| CONT-04 | Phase 1 | Complete |
| SEC-01 | Phase 1 | Complete |
| SEC-02 | Phase 1 | Complete |
| SEC-03 | Phase 1 | Complete |
| SEC-04 | Phase 1 | Complete |
| NET-01 | Phase 2 | Pending |
| NET-02 | Phase 2 | Complete |
| NET-03 | Phase 2 | Pending |
| NET-04 | Phase 2 | Complete |
| AGENT-01 | Phase 3 | Pending |
| AGENT-02 | Phase 3 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-04-01*
*Last updated: 2026-04-01 after roadmap creation (traceability complete)*
