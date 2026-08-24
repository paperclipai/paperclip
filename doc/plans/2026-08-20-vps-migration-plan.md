# VPS Migration Plan — vps-1 (Hostinger → Hetzner)

**Author:** CTO, PraeSyn LLC
**Date:** 2026-08-20
**Issue:** PRA-1131
**Parent:** PRA-1104

## Executive Summary

vps-1 (Hostinger, 72.60.29.178) runs 27 Docker containers on a 2-vCPU/8GB RAM
VPS with **79-90% CPU steal** — the hypervisor is catastrophically overcommitted.
Upgrading within Hostinger (PRA-1043) does **not** fix this because the same
oversubscribed host node is the bottleneck. **Recommendation: migrate to a
dedicated or well-provisioned cloud VPS at Hetzner.**

## Current State vs Outcome Target

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| CPU steal | 79-90% | < 10% | Critical |
| Load average | 3.8-5.2 | < 2.0 | 2x over |
| Memory headroom | ~5.5GB avail | > 2GB | Met (with limits) |
| Containers | 27 running | 27+ | OK |
| Cost | ~$8.99/mo | ~$20-35/mo | Acceptable |

## Why Not Upgrade Within Hostinger?

Hostinger's KVM plans share physical host nodes. The 79-90% CPU steal indicates
the host node itself is oversubscribed. A larger plan (KVM 4) would still share
the same node — and the same steal. The only fix is to move to a provider with
**dedicated CPU** or a **less-oversubscribed hypervisor**.

## Recommended Provider: Hetzner Cloud

### Pricing Comparison (4 vCPU / 16GB RAM or better)

| Provider | Plan | vCPU | RAM | Monthly Cost | Notes |
|----------|------|------|-----|--------------|-------|
| **Hetzner** | CX42 | 8 | 16GB | ~$20-35/mo | Best value, dedicated hypervisor |
| **Hetzner** | CX32 | 4 | 8GB | ~$12-15/mo | Minimum viable |
| Hetzner (dedicated) | AX102 | 6 | 64GB | ~$40-50/mo | Dedicated server, no steal |
| DigitalOcean | General Purpose | 4 | 16GB | ~$96/mo | Overpriced for this use case |
| Linode (Akamai) | Dedicated 16GB | 4 | 16GB | ~$60/mo | Good but more expensive |
| Hostinger KVM 4 | KVM 4 | 4 | 16GB | ~$28.99/mo | Same steal problem |

**Recommendation: Hetzner CX42 (8 vCPU, 16GB RAM, ~$20-35/mo)**

## Migration Strategy: Two-Phase

### Phase 1: Immediate — Durable Memory Limits (done, CTO)

- [x] All 18 running containers have `mem_limit` set at runtime
- [ ] Add memory limits to **compose files** for durability (CTO, in-progress)
- [ ] Verify no container lacks limits on restart

### Phase 2: Provision Hetzner VPS (blocked — needs Ben)

**Unblock owner:** Ben (founder)
**Action:** Create Hetzner Cloud account + provision CX42 (8 vCPU, 16GB RAM)

Steps:
1. Create Hetzner Cloud account at https://console.hetzner.cloud/
2. Add payment method
3. Create project "PraeSyn Production"
4. Provision CX42 instance (8 vCPU, 16GB RAM, 160GB SSD)
5. Choose US region (Falkenstein/Ashburn depending on latency targets)
6. Add SSH key (Ben's public key)
7. Note the new IP address
8. Share the IP with CTO

### Phase 2b: Alternative — Upgrade Hostinger Plan

If Ben prefers to stay with Hostinger (despite steal risk):
1. Log into https://hpanel.hostinger.com/
2. VPS → vps-1 → Upgrade → KVM 4 (4 vCPU, 16GB RAM)
3. Confirm — may cause brief VM reboot
4. Verify SSH + services after upgrade

### Phase 3: Configure New VPS (CTO, after Phase 2)

1. SSH to new VPS
2. Install Docker + Docker Compose
3. Set up SSH key for automated deployment
4. Install monitoring stack (prometheus, node-exporter, blackbox, grafana)
5. Set up Traefik reverse proxy
6. Configure Tailscale for private networking
7. Add 2GB swap file

### Phase 4: Migrate Services (CTO, coordinated)

Ordered by criticality:

1. **Critical (migrate first):**
   - Traefik (reverse proxy) — needs to be up first
   - Consul (service discovery)
   - Prometheus + Grafana (monitoring)
   - travel_app + travel_db
   - temporal-server + temporal-postgres

2. **Standard (migrate second):**
   - praesyn (nginx landing)
   - latusai
   - docs-paperclip
   - sms-assistant + db
   - registrator, node-exporter, blackbox

3. **Non-critical (migrate last, or leave on vps-1):**
   - n8n
   - marketing-advisor
   - workmanager
   - trail-life-web
   - tl_paper_trading

### Phase 5: DNS Cutover

1. Update DNS A records for all *.praesyn.com domains to new IP
2. Wait for DNS propagation (TTL-based)
3. Verify all services from external probes
4. Keep vps-1 running for 48h as rollback target

### Phase 6: Decommission vps-1

1. After 48h with no issues, stop all containers on vps-1
2. After 7d, cancel Hostinger subscription
3. Update infrastructure docs

## Service Inventory on vps-1

### Core Infrastructure
- Traefik (reverse proxy, TLS termination)
- Consul (service discovery)
- Registrator (container registration)
- Prometheus (metrics)
- Grafana (visualization)
- Node Exporter (host metrics)
- Blackbox Exporter (external probing)

### Travel Stack (Voyonder)
- travel_app (Rails web app)
- travel_db (PostgreSQL + pgvector)
- travel_retention_worker
- travel_transport_discovery_worker
- travel_stripe_webhook_worker

### Temporal Stack
- temporal-server (workflow engine)
- temporal-postgres (PostgreSQL 13)

### Web Properties
- praesyn (nginx, praesyn.com)
- latusai (Latus AI website)
- docs-paperclip (documentation)
- marketing-advisor (marketing site)

### Other
- n8n (automation)
- sms-assistant + db
- workmanager
- trail-life-web
- tl_paper_trading
- headscale (Tailscale control plane) — note: currently on vps-2

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Data loss during migration | Database dumps before migration; keep vps-1 running for 48h |
| DNS propagation delay | Set low TTL (60s) before cutover |
| Services fail on new IP | Update all service configs before cutover |
| New provider has issues | Keep vps-1 as rollback; test thoroughly |

## Rollback Plan

1. If new VPS has issues, revert DNS A records to vps-1 IP
2. Restart any stopped containers on vps-1
3. Investigate and document the failure reason
4. Choose alternative provider

---

*CTO, PraeSyn, LLC*