# Phase 2: Network Exposure - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Route HTTPS traffic through Traefik + Cloudflare to the Paperclip container with a valid Let's Encrypt certificate. Add internal DNS resolution via Technitium. After this phase, `https://pc.thelaljis.com` loads the Paperclip dashboard.

</domain>

<decisions>
## Implementation Decisions

### Subdomain
- **D-01:** Paperclip will be accessible at `pc.thelaljis.com`

### Network Strategy
- **D-02:** Paperclip's server container joins the existing `traefik-net` Docker network. Traefik routes to it via container name (`docker-server-1:3100`), not IP:port. This requires adding `traefik-net` as an external network in `docker/docker-compose.yml`.

### Traefik Configuration
- **D-03:** Add a router + service entry to `/opt/traefik/config/dynamic/services.yml` on docker-001. Pattern matches existing services (authentik, litellm, etc.):
  - Router: `Host(\`pc.thelaljis.com\`)`, entryPoint `websecure`, certResolver `cloudflare`
  - Service: loadBalancer URL `http://docker-server-1:3100`
  - No middlewares (no Authentik — Paperclip has its own BetterAuth)

### Auth Middleware
- **D-04:** No Authentik middleware. Paperclip handles its own auth via BetterAuth. Same pattern as litellm, infisical, firecrawl.

### Cloudflare DNS
- **D-05:** Create a DNS record in Cloudflare for `pc.thelaljis.com` pointing to the public IP or Cloudflare tunnel. Traefik's `cloudflare` certResolver handles Let's Encrypt cert via DNS challenge (already configured with `CF_DNS_API_TOKEN`).

### Technitium Internal DNS
- **D-06:** Add an A record in Technitium DNS (192.168.50.112) for `pc.thelaljis.com` → `192.168.50.117` (docker-001 IP). This allows internal network clients to resolve without going through Cloudflare.

### PAPERCLIP_PUBLIC_URL Update
- **D-07:** Update `PAPERCLIP_PUBLIC_URL` in docker-001's `.env` from `http://192.168.50.117:3100` to `https://pc.thelaljis.com`. BetterAuth uses this for trusted origins — wrong value silently breaks login.

### Claude's Discretion
- Cloudflare proxy mode (orange cloud on/off) — pick based on whether other services use it
- Traefik TLS options (min version, ciphers) — use existing tls-options.yml if present
- Whether to remove the `ports: 3100:3100` host binding from compose (Traefik handles ingress now)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Traefik Infrastructure (on docker-001)
- `/opt/traefik/config/traefik.yml` — Static config: entrypoints (80→443 redirect), file provider at /dynamic, cloudflare certResolver with DNS challenge
- `/opt/traefik/config/dynamic/services.yml` — Dynamic config: all router + service definitions. New Paperclip entry goes here.
- `/opt/traefik/docker-compose.yml` — Traefik compose: defines `traefik-net` network (name: traefik-net, driver: bridge)

### Paperclip Docker (on docker-001)
- `/opt/paperclip/docker/docker-compose.yml` — Needs `networks:` block to join traefik-net
- `/opt/paperclip/docker/.env` — Needs PAPERCLIP_PUBLIC_URL updated to https://pc.thelaljis.com

### DNS
- Technitium DNS server at 192.168.50.112 — add A record via API or web UI
- Docker daemon DNS config: `/etc/docker/daemon.json` → `{"dns": ["192.168.50.112", "1.1.1.1"]}`

### Existing Patterns (reference for consistency)
- Cloudflare API token already configured in Traefik's env (`CF_DNS_API_TOKEN`)
- Services without Authentik middleware: litellm, infisical, firecrawl — Paperclip follows this pattern

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Traefik file provider watches `/opt/traefik/config/dynamic/` — just drop/edit the YAML, no restart needed
- `traefik-net` network already exists — just reference as external in Paperclip's compose
- Cloudflare certResolver already configured and working for all *.thelaljis.com subdomains

### Established Patterns
- Router pattern: `Host(\`subdomain.thelaljis.com\`)` → entryPoints: [websecure] → tls.certResolver: cloudflare
- Service pattern: loadBalancer.servers[0].url: `http://container-name:port`
- Network: services on traefik-net are reachable by container name

### Integration Points
- `docker/docker-compose.yml` needs `networks:` section with traefik-net as external
- `/opt/traefik/config/dynamic/services.yml` needs new router + service block
- Technitium needs A record (API available at 192.168.50.112)
- Cloudflare needs DNS record (API available via CF_DNS_API_TOKEN)

</code_context>

<specifics>
## Specific Ideas

- Subdomain: `pc.thelaljis.com` (short, memorable)
- All config changes are on docker-001 — SSH as root@docker-001
- Traefik watches dynamic config — changes take effect without restart
- PAPERCLIP_PUBLIC_URL must match exactly: `https://pc.thelaljis.com` (no trailing slash, no port)
- Technitium API token available in hermes .env on synergy: `TECHNITIUM_API_TOKEN=1e5f4a1c1d548849d1e112283d1a2bd22d437d5dfed371e6405b42fb4ab1b532`

</specifics>

<deferred>
## Deferred Ideas

- Authentik SSO integration — backlog item 999.1
- Infisical secret injection — backlog (service was unreachable during Phase 1)
- Removing host port 3100 binding — could do after Traefik is confirmed working

</deferred>

---

*Phase: 02-network-exposure*
*Context gathered: 2026-04-02*
