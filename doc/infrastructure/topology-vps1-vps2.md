# PraeSyn Infrastructure Topology — vps-1 / vps-2

Last updated: 2026-08-20 ~20:50 UTC (PRA-1044 rebalance)

## Hosts

| Host | Public IP | Tailnet | Specs | Role |
|---|---|---|---|---|
| vps-1 | 72.60.29.178 | 100.64.0.6 | 2 vCPU / 7.8GiB / 96GB | Production primary |
| vps-2 | 187.124.148.97 | 100.64.0.2 | 2 vCPU / 7.8GiB / 96GB | Production secondary + non-critical |

## vps-1 (production primary)

### Running containers (Aug 20 ~20:40 UTC)
| Container | Image | Purpose | Tier |
|---|---|---|---|
| traefik | traefik:v2.11 | Reverse proxy (praesyn.com, travel.praesyn.com, latusai.com, voyonder.com) | Production |
| travel_app | travel_app:latest | Voyonder travel app | Production |
| travel_db | pgvector/pgvector:pg16 | Travel Postgres | Production |
| travel_retention_worker | travel_app:latest | Batch (retention) | Batch |
| travel_transport_discovery_worker | travel_app:latest | Batch (transport discovery) | Batch |
| travel_stripe_webhook_worker | travel_app:latest | Payments webhook | Production |
| praesyn | nginx:alpine | praesyn.com static | Production |
| latusai | latusai-website:latest | latusai.com | Production |
| grafana | grafana:10.2.2 | Monitoring dashboards | Production monitoring |
| prometheus | prom/prometheus:v2.48.0 | Metrics | Production monitoring |
| blackbox | prom/blackbox-exporter:latest | SLA probing | Production monitoring |
| node-exporter | prom/node-exporter:v1.7.0 | Host metrics | Production monitoring |
| consul-server | hashicorp/consul:latest | Service discovery | Infrastructure |
| registrator | gliderlabs/registrator:master | Docker→Consul bridge | Infrastructure |
| temporal-server | temporalio/auto-setup:1.25.1 | Workflow engine | Production |
| temporal-postgres | postgres:13-alpine | Temporal DB | Production |
| sms-assistant-db-prod | pgvector/pgvector:pg16 | SMS assistant DB | Production (DB only) |

### Traefik routes (vps-1, post-cleanup 2026-08-20)
- praesyn.com / www.praesyn.com → praesyn container
- travel.praesyn.com → travel_app
- latusai.com / www.latusai.com → latusai
- voyonder.com (docker provider) → travel-planner
- flow.adoptaitech.com → flow-landing
- latus.flow.adoptaitech.com → temporal-ui-latus (basicAuth)
- monitor.adoptaitech.com → grafana (basicAuth)

### Removed routes (PRA-1044 cleanup, 2026-08-20)
- crm.praesyn.com → migrated to vps-2 (DNS already pointed at vps-2; route pointed at dead 100.64.0.3:3000)
- assistant.praesyn.com → containers stopped; no replacement on vps-1
- marketing.praesyn.com → containers stopped; no replacement on vps-1
- workmanager.praesyn.com → containers stopped; no replacement on vps-1
- seo.praesyn.com → containers stopped; no replacement on vps-1
- 0337.praesyn.com → trail-life-web stopped; no replacement on vps-1

These hosts now return HTTP 404 (no route) instead of 502. DNS records still
point to vps-1 (72.60.29.178) — see DNS section.

## vps-2 (production secondary / non-critical)

### Running containers (Aug 20 ~20:40 UTC)
| Container | Image | Purpose | Tier |
|---|---|---|---|
| traefik-traefik-1 | traefik:latest | Reverse proxy (crm, headscale, status, kineticwork, SE AK Supply) | Production |
| crm | vps-1:5000/twenty-selfhosted:latest | Twenty CRM (crm.praesyn.com) | Production |
| crm-db | postgres:16-alpine | CRM Postgres | Production |
| crm-redis | redis:7-alpine | CRM cache | Production |
| headscale | headscale:0.23.0 | Tailnet control (conn.praesyn.com) | Production |
| infisical | infisical/infisical:latest | Secrets management | Production |
| infisical-db | postgres:17-alpine | Infisical DB | Production |
| infisical-redis | redis:7-alpine | Infisical cache | Production |
| prometheus | prom/prometheus:latest | Metrics | Production monitoring |
| loki | grafana/loki:latest | Logs | Production monitoring |
| grafana | grafana/grafana:latest | Dashboards | Production monitoring |
| alertmanager | prom/alertmanager:latest | Alerting | Production monitoring |
| blackbox | prom/blackbox-exporter:latest | SLA probing | Production monitoring |
| promtail | grafana/promtail:latest | Log shipping | Production monitoring |
| status-page-uptime-kuma-1 | louislam/uptime-kuma:1 | Uptime/status page | Production monitoring |
| registry | registry:2 | Docker registry (vps-1:5000 mirror) | Infrastructure |
| oncall-receiver | python:3.12-slim | On-call receiver | Non-critical |
| relm-dev-redis | redis:7-alpine | Relm dev | Dev/staging |
| relm-dev-db | postgres:17-alpine | Relm dev | Dev/staging |
| kineticwork-web | kineticwork-web:latest | Kineticwork site | Non-critical |
| southeastaksupply-alaska-supply | southeastaksupply:latest | SE AK Supply | Production |
| southeastaksupply-db | postgres:16-alpine | SE AK Supply DB | Production |

## DNS map (verified 2026-08-20 ~20:45 UTC)
| Host | Target | Notes |
|---|---|---|
| praesyn.com | 72.60.29.178 (vps-1) | |
| www.praesyn.com | CNAME→praesyn.com | |
| travel.praesyn.com | CNAME→praesyn.com | vps-1 |
| latusai.com | 31.220.48.8 | external (not vps-1/vps-2) |
| voyonder.com | vps-1 (via travel) | |
| crm.praesyn.com | 187.124.148.97 (vps-2) | migrated |
| conn.praesyn.com | 187.124.148.97 (vps-2) | headscale |
| test.cenergi.net | 187.124.148.97 (vps-2) | Vercel via vps-2 traefik |
| assistant.praesyn.com | 72.60.29.178 (vps-1) | **stale — no backend, 404** |
| marketing.praesyn.com | 72.60.29.178 (vps-1) | **stale — no backend, 404** |
| workmanager.praesyn.com | 72.60.29.178 (vps-1) | **stale — no backend, 404** |
| seo.praesyn.com | 72.60.29.178 (vps-1) | **stale — no backend, 404** |
| 0337.praesyn.com | — (NXDOMAIN) | trail-life-web stopped |

## Rebalance actions taken (PRA-1044, 2026-08-20)
1. **Inventory**: enumerated all containers on vps-1 (17) and vps-2 (23).
2. **vps-2 health**: confirmed recovered from the Aug 20 03:10 UTC incident
   (load 39.19 → 0.09, steal 83.2% → 0, zombies 90 → 0, docker responsive).
   Root cause was cAdvisor runaway OOM (PRA-1047/PRA-1061/PRA-1074 — done).
3. **vps-2 provisioning**: CRM, Infisical, headscale, monitoring stack,
   registry, SE AK Supply, kineticwork, relm-dev already provisioned on
   vps-2 (done in prior work — CRM was the main production-tier move).
4. **DNS/Traefik**: removed stale vps-1 routes for crm, assistant, marketing,
   workmanager, seo, trail-life-web. DNS for crm/conn/test.cenergi already
   points to vps-2. Stale A records (assistant/marketing/workmanager/seo)
   still point to vps-1 but return 404.
5. **Health checks**: praesyn.com, travel.praesyn.com, latusai.com,
   crm.praesyn.com all HTTP 200 post-cleanup; traefik restarted cleanly.
6. **Cut over**: no running production container was stopped on vps-1 —
   the removed routes belonged to already-stopped containers.
7. **Monitor**: vps-1 48h watch after rebalance (see below).

## Post-rebalance load (vps-1, 2026-08-20 ~20:43 UTC)
- Load: 5.47 / 7.99 / 17.92 (was 21.71/1.46 earlier — bursty, settling)
- Mem: 2.2Gi used / 5.6Gi available (swap 376Mi)
- Disk: 40G/96G (41%)
- Top consumers: dockerd (~10% CPU), temporal-server, node_exporter, traefik
- vps-2 load: 0.09 (healthy, 4.9Gi available)

## Open items / follow-ups
- [ ] Stale DNS records for assistant/marketing/workmanager/seo.praesyn.com
      should be removed (or services revived on vps-2) — owner: CTO/DevOps
- [ ] vps-1 48h monitoring watch (until 2026-08-22 ~20:45 UTC): re-check
      load/steal, confirm no production impact
- [ ] PRA-1043 (vps-1 upgrade) still blocked — rebalance reduced but did not
      eliminate vps-1 pressure; upgrade remains the structural fix
