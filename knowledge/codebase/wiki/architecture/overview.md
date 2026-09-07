---
title: Architecture overview
type: architecture
tags: [wiki, architecture, start]
source: docs/start/architecture.md
board: NOM-27
---

## Summary
Four layers today: React/Vite UI, Express REST (Node), PostgreSQL/Drizzle, Adapters. API migration target: Bun/Elysia (NOM-11). Astro stays NOM-12 until SSR/SEO why.

## Diagram
See stack diagram in canonical `docs/start/architecture.md`.

## Key components
| Layer | Today | Notes |
|---|---|---|
| Frontend | React 19 + Vite 6 | SPA; Astro deferred |
| Backend | Express on Node | Bun/Elysia cutover in flight |
| Data | Postgres + Drizzle | company-scoped |
| Adapters | CLI / process / HTTP | runtime heartbeats |

## Design decisions
Express remains oracle until each Bun/Elysia slice is green. Isolated `server/src/http` boundary already green per inventory.

## Related
- Canonical: `docs/start/architecture.md`
- [Core concepts](../concepts/core-concepts.md)
- Migration plans: NOM-28 / lifecycle
