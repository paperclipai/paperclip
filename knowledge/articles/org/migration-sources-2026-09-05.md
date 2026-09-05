# Migration sources analysis (2026-09-05)

Official sources consulted:
- https://bun.com/docs
- https://bun.com/docs/runtime/http/server
- https://elysiajs.com/table-of-content
- https://elysiajs.com/integrations/astro.html
- https://docs.astro.build/es/install-and-setup/

## CTO recommendation
1. Primary goal: Bun + Elysia for HTTP/runtime (NOM-11).
2. Do not parallel full Astro rewrite of ui/ with Express cutover.
3. If Astro is required later: prefer Elysia-on-Astro-endpoints hosting spike AFTER API parity, or separate islands epic with explicit SSR/SEO why (NOM-12).

## Repo evidence
- Inventory 2026-09-04 + AGENTS.md section 10.
- Isolated boundary server/src/http already green under Bun 1.4.0.
- Express remains behavioral oracle.
