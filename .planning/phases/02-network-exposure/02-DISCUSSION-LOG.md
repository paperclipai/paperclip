# Phase 2: Network Exposure - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-02
**Phase:** 02-network-exposure
**Areas discussed:** Subdomain choice, Network strategy, Auth middleware, Technitium setup

---

## Subdomain Choice

| Option | Description | Selected |
|--------|-------------|----------|
| paperclip.thelaljis.com | Matches the product name | |
| pc.thelaljis.com | Short and quick | ✓ |
| Let me specify | Different subdomain | |

**User's choice:** pc.thelaljis.com
**Notes:** User prefers short subdomains.

---

## Network Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Join traefik-net (Recommended) | Route via container name, no IP hardcoding | ✓ |
| IP:port | Route via 192.168.50.117:3100, simpler | |
| You decide | Claude picks | |

**User's choice:** Join traefik-net
**Notes:** Consistent with how authentik, proxcenter, litellm use container name routing.

---

## Auth Middleware

| Option | Description | Selected |
|--------|-------------|----------|
| No auth middleware (Recommended) | Paperclip has BetterAuth built-in | ✓ |
| Authentik middleware | SSO layer in front | |
| Decide later | Skip now, add in backlog 999.1 | |

**User's choice:** No auth middleware
**Notes:** Same pattern as litellm, infisical, firecrawl.

---

## Technitium Setup

| Option | Description | Selected |
|--------|-------------|----------|
| A record → 192.168.50.117 | Direct to docker-001 IP | ✓ |
| CNAME → docker-001 | Point to hostname | |
| You decide | Claude picks | |

**User's choice:** A record → 192.168.50.117

---

## Claude's Discretion

- Cloudflare proxy mode (orange cloud on/off)
- Traefik TLS options
- Whether to remove host port 3100 binding after Traefik works

## Deferred Ideas

- Authentik SSO integration → backlog 999.1
- Infisical injection → backlog
