# Lessons Learned — Ironworks Fork & Deployment

This file tracks everything we learn while installing, configuring, deploying, and running Ironworks.
When we productize this and replicate it at scale, this becomes the playbook.

---

## VPS Requirements

### Minimum Specs (Solo Use)
- **CPU:** 2 cores minimum
- **RAM:** 2GB minimum (1GB is too tight with embedded Postgres)
- **Disk:** 20GB+ (Postgres data, agent workspaces, Docker images)
- **OS:** Ubuntu 22.04+ or Debian 12+
- **Software:** Docker Engine + Docker Compose v2

### Our VPS (Hostinger KVM 2) — Confirmed Specs
- **CPU:** 2 cores
- **RAM:** 8 GB (plenty for Ironworks + agents)
- **Disk:** 100 GB SSD (~93GB free after OS)
- **OS:** Ubuntu 24.04 (came with n8n, Docker pre-installed)
- **IP:** 76.13.99.74
- **SSH:** root@76.13.99.74
- **Hostname:** srv1292354.hstgr.cloud
- **Expires:** 2028-03-23
- **Note:** n8n will be stopped/removed to free resources for Ironworks

### Recommended Specs (Solo + Few Agents)
- **CPU:** 4 cores
- **RAM:** 4GB
- **Disk:** 40GB SSD

### Production Multi-Tenant Specs (Future)
- Dedicated server (Hetzner/OVH auction: ~$40/mo for 32GB/8-core)
- Docker container per client with resource limits
- External Postgres (dedicated instance or managed)
- Reverse proxy (Caddy/Traefik) for multi-tenant routing

---

## Architecture Decisions

### Decision: Run entirely in Docker from day one
- **Why:** Reproducible, portable, easy to replicate for clients later
- **How:** Use `docker-compose.quickstart.yml` as the base, customize for our needs
- **Data persistence:** Volume mount from container to VPS filesystem

### Decision: Tailscale for private access
- **Why:** No need to expose Ironworks to the public internet for personal use
- **How:** `authenticated/private` mode, access via Tailscale IP on any device
- **Mobile:** Safari on iPhone via Tailscale + PWA (Add to Home Screen)

### Decision: lessons-learned.md as living playbook
- **Why:** When we productize, we need a checklist of what works and what breaks
- **How:** Update this file every time something unexpected happens

---

## Installation Checklist (Docker on VPS)

### Prerequisites
- [ ] Docker Engine installed
- [ ] Docker Compose v2 installed
- [ ] Tailscale installed and connected to tailnet
- [ ] Firewall configured (allow Tailscale, block public 3100)
- [ ] At least 2GB RAM available

### Ironworks Setup
- [ ] Clone fork to VPS
- [ ] Configure `.env` with secrets
- [ ] Run `docker compose -f docker-compose.quickstart.yml up --build`
- [ ] Verify health: `curl http://localhost:3100/api/health`
- [ ] Access UI via Tailscale IP
- [ ] Complete onboarding (create first company)
- [ ] Generate bootstrap CEO invite
- [ ] Wire in OpenClaw (Atlas) as first agent

### Post-Setup
- [ ] Add PWA manifest for mobile home screen icon
- [ ] Configure automatic DB backups
- [ ] Set up agent heartbeat schedules
- [ ] Test agent task execution end-to-end

---

## Known Issues & Fixes

(Add entries as we encounter them)

### Template
```
### Issue: [Brief description]
- **Date:** YYYY-MM-DD
- **Symptoms:** What happened
- **Root cause:** Why it happened
- **Fix:** What we did
- **Prevention:** How to avoid next time
```

---

## Scaling Notes

### Single-User (Current Phase)
- One Docker Compose stack on Hostinger KVM
- Embedded Postgres inside container OR external Neon/Supabase Postgres
- Tailscale for private access
- 2-4GB RAM sufficient

### Multi-User Product (Future Phase)
- Dedicated server with more resources
- One Docker container per client (isolated data, isolated Postgres)
- Traefik/Caddy reverse proxy for routing `client1.ironworks.steelmotionllc.com`
- Resource limits per container (CPU/RAM quotas)
- Billing integration for usage tracking
- Company import/export for onboarding new clients from templates

---

## Cost Tracking

| Item | Monthly Cost | Notes |
|------|-------------|-------|
| Hostinger KVM 2 | ~$7/mo | Current VPS — 8GB RAM, 100GB disk, prepaid to 2028 |
| Tailscale | Free | Up to 100 devices on free tier |
| Neon Postgres (free) | $0 | If using external DB to save RAM |
| Domain (optional) | ~$1/mo | For custom access URL |
