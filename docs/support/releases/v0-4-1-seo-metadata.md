---
title: v0.4.1 — SEO Metadata Infrastructure
version: voy-1695/voy-1798/voy-1815
date: 2026-08-23
commit: 1a50ce7446 + fde711db21 + 096b1ecdff
status: LIVE
---

# v0.4.1 — SEO Metadata Infrastructure

**Release:** VOY-1695 / VOY-1798 / VOY-1815
**Commits:** `1a50ce7446` (code review fix), `fde711db21` (structural audit fix), `096b1ecdff` (OG/Twitter tags)
**Date:** 2026-08-23
**Status:** LIVE
**Related issues:** VOY-1695, VOY-1696, VOY-1798, VOY-1715, VOY-1866, VOY-1815

## Summary

This release adds SEO metadata infrastructure to Paperclip, enabling search engines to discover and index public content and producing rich link previews when pages are shared on social media. The changes are entirely server-side and frontend hook-based — no API changes.

## Changes

### New files

| File | Purpose |
|---|---|
| `server/src/routes/seo.ts` | Dynamic sitemap.xml + robots.txt routes |
| `ui/src/hooks/usePageMeta.ts` | React hook for setting page title, meta description, and OG/Twitter tags |

### Modified files

| File | Change |
|---|---|
| `server/src/app.ts` | Registered `seoRoutes(db)` before SPA fallback (line 681) |
| `ui/index.html` | Added base meta description tag and OG/Twitter fallback defaults |
| `ui/src/hooks/usePageMeta.ts` | Extended with `PageMetaOg` interface for OG/Twitter tag injection |
| 75+ page components in `ui/src/pages/` | Added `usePageMeta()` calls |

### Server: sitemap.xml (`GET /sitemap.xml`)

- Query active companies and public issues from DB
- Generate XML urlset with `<loc>`, `<lastmod>`, `<changefreq>weekly`
- Max 10,000 companies and 10,000 issues
- On DB error: returns empty `<urlset>` with 200 (prevents crawler retry storms)
- XML escaping: `&`, `<`, `>`, `"`, `'` escaped to prevent injection via `X-Forwarded-Host`

### Server: robots.txt (`GET /robots.txt`)

- `Allow: /`, `Disallow: /api/`
- `Sitemap:` directive with resolved host
- Host resolution: `X-Forwarded-Host` > `Host` > `paperclip.ai`

### Frontend: usePageMeta hook

- Accepts `(title: string, description?: string, og?: PageMetaOg)`
- `PageMetaOg` interface: `type?`, `url?`, `image?`, `imageAlt?`
- Appends " — Paperclip" to title automatically
- Manages `<meta name="description">` lifecycle (create/update/remove)
- Automatically injects `og:*` and `twitter:*` tags based on title, description, and optional og config
- `twitter:card` defaults to `"summary"`
- Last-call-wins: child routes override parent effects
- Cleans up on unmount (restores previous title, removes description and OG/Twitter tags)

### Frontend: Page coverage

75+ components now call `usePageMeta`, covering:
- Company pages: dashboard, issues, settings, billing
- Agent pages: all agent detail and list views
- Admin pages: secrets, adapters, plugins, pipelines
- Utility pages: export, invites, decisions, approvals
- Legacy/Auth/Error pages: login, not-found, landing

### Base HTML defaults (`index.html`)

Fallback OG/Twitter tags for pages before React renders:
```html
<meta property="og:type" content="website" />
<meta property="og:title" content="Paperclip" />
<meta property="og:description" content="Paperclip — AI-powered issue tracking and project management for modern teams." />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Paperclip" />
<meta name="twitter:description" content="Paperclip — AI-powered issue tracking and project management for modern teams." />
```

### Not in scope (descoped or future)

- JSON-LD structured data — not implemented
- Heading hierarchy audit — descoped per Founding Engineer decision
- Per-issue custom descriptions — not implemented

## Key Decisions

1. **Empty sitemap on DB error (200 vs 500)**: 5xx responses trigger crawler retry storms. Empty 200 avoids this while the system recovers.
2. **X-Forwarded-Host support**: Required for proxy deployments (e.g., behind Traefik). The first entry in a comma-separated list is used.
3. **`isNull(issues.hiddenAt)` filter**: Hidden issues are excluded from the sitemap. Admins can hide sensitive issues.
4. **XML escaping**: Defense-in-depth against injection attacks via request headers.
5. **Last-call-wins meta**: React's insertion order ensures the deepest child's meta tag wins, enabling hierarchical overrides.
6. **OG/Twitter from existing params**: `og:title` and `twitter:title` derived automatically from the `title` parameter, same for description — no additional work needed for basic social previews on all 75+ pages.
7. **Base defaults in index.html**: Pages that render before `usePageMeta` runs still have basic social metadata.

## QA Checklist

- [x] sitemap.xml returns valid XML with company pages
- [x] robots.txt serves correct sitemap link
- [x] Meta tags render on all page components
- [x] Hidden issues excluded from sitemap
- [x] XML injection blocked via escapeXml
- [x] Open Graph tags render on all public pages
- [x] Twitter Card tags render on all public pages
- [ ] CTO Sign-off

## Documentation

- Customer-facing release notes: `/docs/documentation/releases/v0-4-1-seo-infrastructure.md`
- Developer SEO best practices: `/docs/guides/agent-developer/seo-best-practices.md`
- Support case assessment: `/docs/support/assessments/support-case-seo-metadata.md`
