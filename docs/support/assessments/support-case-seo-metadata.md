# Support Case Assessment: SEO Metadata Infrastructure — Sitemap, Robots, Page Meta, Open Graph / Twitter Cards

**Feature**: Search-engine-optimization infrastructure including sitemap.xml, robots.txt, dynamic page metadata, and Open Graph / Twitter Card social preview tags
**Assessed by**: Support Engineer
**Date**: 2026-08-23 (updated)
**Related**: VOY-1695, VOY-1798, VOY-1696, VOY-1715, VOY-1815
**Release**: v0.4.1 — SEO Metadata Infrastructure

## Feature Overview (User Perspective)

Paperclip now generates search-engine-friendly metadata across the platform. Companies hosting their project management on Paperclip benefit from automatic search engine visibility — no configuration needed. Additionally, Paperclip pages now produce rich link previews when shared on social media and messaging platforms.

**What this means for users:**

- **Your pages are indexed** — Active company dashboards and public issue pages appear in search engine results
- **Descriptive page titles** — Every page has a context-specific browser tab title (e.g. "Dashboard — Paperclip", "Agent Detail — Paperclip") instead of a generic label
- **Search result summaries** — Key pages include summary descriptions that show beneath search result links
- **Social media previews** — When someone shares a Paperclip link on Slack, Twitter/X, LinkedIn, or Discord, a rich preview card with title, description, and optional image is shown automatically
- **Search engines know your content** — A sitemap at `/sitemap.xml` tells search engines what pages exist and when they were last updated
- **Crawling rules are set** — `robots.txt` at `/robots.txt` allows public content crawling while blocking `/api/` paths

## What Changed

### 1. Dynamic Page Metadata (`usePageMeta` hook)

Every page component now calls `usePageMeta(title, description, og?)` at the top level. This React hook:

- Sets `document.title` to a descriptive string (e.g. "Live Agent Runs — Paperclip")
- Injects or updates a `<meta name="description">` tag in `<head>` with a page-specific summary
- Injects or updates Open Graph (`og:*`) and Twitter Card (`twitter:*`) meta tags for social link previews
- Cleans up on unmount — if a component provided the current meta tags, they are removed when the component leaves the DOM
- Supports last-call-wins: child routes naturally override parents because React runs the deepest effect last

**Coverage**: 75+ page components across the entire UI surface have been updated.

### 2. `/sitemap.xml` (Server-side, Dynamic)

- Auto-generated XML sitemap available at `https://[host]/sitemap.xml`
- Lists: static pages (homepage, pricing), active company pages (dashboard, issues), and public issue detail pages for non-hidden, non-cancelled, non-backlog issues
- Each entry includes `<lastmod>`, `<changefreq>weekly</changefreq>`, full `<loc>` URL
- Hostname resolved from `X-Forwarded-Host` (when behind a proxy) or `Host` header
- **On DB error**: Returns empty `<urlset>` with HTTP 200 — prevents crawler retry storms that would follow a 5xx response
- **Security**: XML special characters escaped on host, path, and lastmod to prevent injection via `X-Forwarded-Host` or other user-influenced values
- Cache header: `Cache-Control: public, max-age=3600`

### 3. `/robots.txt` (Server-side, Dynamic)

- Auto-generated robots.txt at `https://[host]/robots.txt`
- Rules: `Allow: /` (all public content), `Disallow: /api/` (API endpoints blocked)
- Includes `Sitemap:` directive pointing to the dynamically resolved sitemap URL
- Cache header: `Cache-Control: public, max-age=3600`

### 4. Base HTML Metadata (`index.html`)

- `<meta charset="UTF-8">`
- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
- `<meta name="theme-color" content="#18181b">`
- `<meta name="apple-mobile-web-app-title" content="Paperclip">`
- `<meta name="description" content="Paperclip — AI-powered issue tracking and project management for modern teams.">` (fallback for pages without dynamic meta)
- `<meta property="og:type" content="website">` (fallback for social previews)
- `<meta property="og:title" content="Paperclip">` (fallback for social previews)
- `<meta property="og:description" content="Paperclip — AI-powered issue tracking and project management for modern teams.">` (fallback for social previews)
- `<meta name="twitter:card" content="summary">` (fallback for social previews)
- `<meta name="twitter:title" content="Paperclip">` (fallback for social previews)
- `<meta name="twitter:description" content="Paperclip — AI-powered issue tracking and project management for modern teams.">` (fallback for social previews)

### 5. Open Graph and Twitter Card Tags (NEW)

All pages that use `usePageMeta` automatically inject the following social media preview tags:

| Tag | Source | Notes |
|---|---|---|
| `og:title` | Derived from `usePageMeta` title parameter | E.g., "Dashboard — Paperclip" |
| `og:description` | Derived from `usePageMeta` description parameter | E.g., "Overview of your company's active issues" |
| `og:type` | Always `"website"` (default) | Configurable via `PageMetaOg.type` |
| `og:url` | Optional — set via `PageMetaOg.url` | Canonical URL for the shared page |
| `og:image` | Optional — set via `PageMetaOg.image` | URL to an image for rich social cards |
| `og:image:alt` | Optional — set via `PageMetaOg.imageAlt` | Alt text for the social card image |
| `twitter:title` | Mirror of `og:title` | Same value |
| `twitter:description` | Mirror of `og:description` | Same value |
| `twitter:card` | Always `"summary"` | Configurable via `PageMetaOg.type` in future |

Pages that render before `usePageMeta` runs (or that don't call it) fall back to the base defaults in `index.html`.

## What Did NOT Change (Scope Gaps)

The following SEO elements were considered but are **not yet implemented**:

| Element | Status | Reason |
|---|---|---|
| Structured data / JSON-LD | ❌ Not implemented | Not in scope for M2 |
| Proper heading hierarchy (h1-h6 audit) | ❌ Descoped | Per Founding Engineer decision |
| Issue-specific meta descriptions per content | ❌ Partial — usePageMeta sets descriptions but some complex pages use generic text | Follow-up opportunities |

## Technical Architecture

### Routes

SEO routes are registered in `server/src/app.ts` **before** the SPA fallback catch-all (`app.use(seoRoutes(db))`) at line 681. This ensures crawlers receive the correct XML/text response instead of the HTML shell.

### Route File

`server/src/routes/seo.ts` exports `seoRoutes(db: Db): Router` containing:

- `GET /robots.txt` — synchronous
- `GET /sitemap.xml` — async, queries companies and issues tables

### Hook

`ui/src/hooks/usePageMeta.ts` exports:

```typescript
interface PageMetaOg {
  type?: string;     // og:type, defaults to "website"
  url?: string;      // og:url
  image?: string;    // og:image
  imageAlt?: string; // og:image:alt
}

usePageMeta(title: string, description?: string, og?: PageMetaOg): void
```

## Potential User Confusion Points

1. **"My issue page isn't showing in search results"** — Only active companies with non-hidden, non-cancelled issues appear in the sitemap. Hidden issues (`hiddenAt` is not null) are excluded. Search engines may take days to index new pages.

2. **"I see a stale sitemap"** — The sitemap is regenerated on every request with `Cache-Control: max-age=3600` (1 hour). Search engines may cache it longer.

3. **"My page title changed back to just 'Paperclip'"** — If a page component doesn't call `usePageMeta`, or if an error prevents the hook from running, the title falls back to the base `<title>Paperclip</title>` from `index.html`.

4. **"The sitemap is empty"** — If the database is unreachable, the sitemap returns an empty `<urlset>` with HTTP 200 (by design). Check database connectivity.

5. **"I'm getting 404 on robots.txt"** — SEO routes must be registered before the SPA fallback. If the route order is disrupted (e.g., a middleware catches all paths), robots.txt will return the HTML shell.

6. **"My company page isn't in the sitemap"** — Only companies with `status = 'active'` are included. Companies in other states (e.g., suspended, archived) are excluded.

7. **"My link preview on Slack/Discord doesn't show an image"** — The `og:image` tag is optional. Pages without a configured image in the `usePageMeta` `og` parameter will show only the title and description. To add an image, pass `image` in the `og` config object.

8. **"Link preview shows 'Paperclip' as the title instead of my page title"** — If the React component hasn't rendered yet (e.g., slow JS load), the base defaults from `index.html` are shown. This is expected behavior — the page-specific tags are injected once `usePageMeta` runs.

## Known Limitations

1. **No JSON-LD structured data** — Search engines cannot extract rich snippets (e.g., breadcrumbs, organization info, FAQ schema).
2. **Maximum sitemap entries**: Capped at 10,000 companies and 10,000 issues. Companies with large numbers of public issues may hit this limit.
3. **No per-issue meta descriptions** — The `usePageMeta` hook takes a static description per page type, not per-content-description (e.g., the issue detail page uses a generic description, not a summary of the specific issue).
4. **Social preview image is optional** — Not all pages have a configured `og:image`. Pages without an explicit image will show a text-only preview card.

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---|---|---|
| `${host}/robots.txt` returns HTML | SEO routes not registered before SPA fallback | Check `app.ts` route order — `seoRoutes(db)` must be called before the static file serve catch-all |
| `${host}/sitemap.xml` returns empty `<urlset>` | DB connection issue or no active companies | Check DB health and company statuses |
| Page title doesn't update | Component doesn't call `usePageMeta` | Add `usePageMeta(title, description)` to the component's top level |
| Meta description missing on a page | Component calls `usePageMeta` without a description argument | Pass a description string as the second argument |
| XML error in sitemap | Malformed hostname or path injection | Check `X-Forwarded-Host` header — non-ASCII or special characters should be sanitized by the caller; the server escapes XML entities as a defense layer |
| Link preview shows wrong title | React hasn't rendered yet, showing `index.html` defaults | This is expected; verify that `usePageMeta` runs on the page and the title is correct after full page load |
| No image in social preview | Page doesn't set `og:image` in `usePageMeta` config | Add `image` to the `og` parameter of `usePageMeta` |

## Escalation Path

| Issue | Escalate To |
|---|---|
| Sitemap returns 500 errors | Staff Engineer (route error) |
| robots.txt returning wrong content | Staff Engineer (route registration order) |
| Missing meta tags on user-facing pages | Founding Engineer (component hook integration) |
| Social preview tags not rendering correctly | Staff Engineer (hook implementation) |

## Related Documentation

- Developer guide: [SEO Best Practices](/guides/agent-developer/seo-best-practices)
- Release notes: [v0.4.1 — SEO Metadata Infrastructure](/documentation/releases/v0-4-1-seo-infrastructure)
- Source: `server/src/routes/seo.ts`
- Source: `ui/src/hooks/usePageMeta.ts`

## Version History

| Date | Version | Change |
|---|---|---|
| 2026-08-23 | v1.1 | Updated with Open Graph / Twitter Card tags support (VOY-1815) |
| 2026-08-23 | v1.0 | Initial assessment based on VOY-1695 / VOY-1798 implementation |