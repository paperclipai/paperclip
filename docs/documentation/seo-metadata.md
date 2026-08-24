---
title: SEO Metadata Guide
description: How Paperclip generates sitemap.xml, robots.txt, per-page meta tags, and Open Graph / Twitter Card tags for search engine and social media visibility
---

# SEO Metadata Guide

Paperclip automatically generates search-engine-friendly metadata to help crawlers index public content and to produce rich link previews when pages are shared on social media. This guide covers the four pillars of the SEO infrastructure: the XML sitemap, the robots exclusion file, per-page meta tags, and Open Graph / Twitter Card tags.

---

## 1. Sitemap.xml

Paperclip generates a dynamic sitemap at `/sitemap.xml` listing all publicly indexable resources. The sitemap is served with `Content-Type: application/xml` and cached for 1 hour (`Cache-Control: public, max-age=3600`).

### What's included

| Resource | URL Pattern | Frequency | Example |
|---|---|---|---|
| Landing page | `/` | weekly | `https://app.paperclip.ai/` |
| Pricing page | `/pricing` | weekly | `https://app.paperclip.ai/pricing` |
| Company dashboards | `/{prefix}/dashboard` | weekly | `https://app.paperclip.ai/ACME/dashboard` |
| Company issue lists | `/{prefix}/issues` | weekly | `https://app.paperclip.ai/ACME/issues` |
| Public issue detail | `/{prefix}/issues/{id}` | weekly | `https://app.paperclip.ai/ACME/issues/VOY-123` |

### Exclusion criteria

Pages excluded from the sitemap:

- Companies with status other than `active` (cancelled, suspended, etc.)
- Issues with status `cancelled` or `backlog`
- Issues without an `identifier` (internal-only items)
- Issues where `hiddenAt` is set (soft-deleted or hidden)
- Orphaned issues whose parent company no longer exists

### Configuration

The sitemap is generated server-side by `server/src/routes/seo.ts`. There is no configuration file — the sitemap reflects the live database state. Key behaviors:

- **Database errors**: If the database query fails, the response returns a 200 status with an empty `<urlset>` element. This prevents crawlers from retrying aggressively (which they do on 5xx responses).
- **Caching**: A 1-hour cache header is set. The sitemap refreshes on every request but is cached by CDNs and crawlers for the TTL.
- **Limits**: Both company and issue queries are capped at 10,000 rows to prevent excessive XML size.
- **Dynamic host**: The hostname is resolved from `X-Forwarded-Host` (for reverse proxy deployments), falling back to the `Host` header, then to `paperclip.ai`.

### XML structure

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://app.paperclip.ai/</loc>
    <lastmod>2025-01-01</lastmod>
    <changefreq>weekly</changefreq>
  </url>
  <url>
    <loc>https://app.paperclip.ai/ACME/dashboard</loc>
    <lastmod>2026-08-22</lastmod>
    <changefreq>weekly</changefreq>
  </url>
</urlset>
```

---

## 2. Robots.txt

Paperclip serves a dynamic `robots.txt` at `/robots.txt` with `Content-Type: text/plain`.

### Default rules

```
User-agent: *
Allow: /
Disallow: /api/

Sitemap: https://app.paperclip.ai/sitemap.xml

# robots.txt for Paperclip
```

### What the rules mean

| Directive | Effect |
|---|---|
| `Allow: /` | Allow crawling of all public paths |
| `Disallow: /api/` | Block crawling of API endpoints (not useful for indexing, and requests can leak internal structure) |
| `Sitemap: {url}` | Points crawlers to the dynamic sitemap |

### Configuration

Like the sitemap, robots.txt is generated dynamically by `server/src/routes/seo.ts`. The `Sitemap` URL is derived from the same dynamic host resolution as the sitemap, ensuring it stays correct across domains.

### Caching

Served with `Cache-Control: public, max-age=3600` (1 hour).

---

## 3. Meta Tag Guidelines for Developers

Every page component in the Paperclip UI sets a browser tab title, a meta description, and Open Graph / Twitter Card tags. This is done via the `usePageMeta` React hook.

### Hook signature

```typescript
interface PageMetaOg {
  /** og:type — defaults to "website" */
  type?: string;
  /** og:url — the canonical URL of the page */
  url?: string;
  /** og:image — a URL to an image for social cards */
  image?: string;
  /** og:image:alt — alt text for the image */
  imageAlt?: string;
}

usePageMeta(title: string, description?: string, og?: PageMetaOg): void
```

- **`title`** — The page-specific title (e.g. `"Dashboard"`, `"Issue VOY-123"`). The app name `" — Paperclip"` is appended automatically. Pass an empty string to show only the app name.
- **`description`** (optional) — A `<meta name="description">` summary. When provided, the tag is created or updated in `<head>`. When omitted, any existing description tag is removed to prevent stale descriptions across page navigations.
- **`og`** (optional) — Open Graph and Twitter Card configuration. When provided, the hook automatically sets `og:title` and `twitter:title` (from the page title), `og:description` and `twitter:description` (from the description), plus any additional properties like `og:image` and `og:url`. The `twitter:card` type defaults to `"summary"`.

### Usage pattern

```typescript
import { usePageMeta } from "@/hooks/usePageMeta";

function Dashboard() {
  usePageMeta("Dashboard", "Overview of your company's active issues and agent activity");
  // ...component content
}
```

For pages that need social media link previews:

```typescript
function IssueDetail() {
  const { identifier } = useParams();
  const { data: issue } = useQuery(...);

  usePageMeta(
    issue ? `${issue.identifier}: ${issue.title}` : "Loading...",
    issue ? `View issue ${issue.identifier}: ${issue.title}` : undefined,
    {
      url: `https://app.paperclip.ai/${companyPrefix}/issues/${issue?.identifier}`,
      image: "https://app.paperclip.ai/og-image-default.png",
      imageAlt: "Paperclip project management",
    },
  );
  // ...component content
}
```

### How it works

- Call `usePageMeta` at the top level of every page component, inside the component function body (never at module level — this violates React Rules of Hooks).
- React processes effects bottom-up in the component tree, so the deepest (most specific) page component wins. Child routes naturally override parent meta tags.
- On unmount, the hook restores the previous `document.title` and cleans up any meta description and OG/Twitter tags it created.
- If a deeper component already replaced the tags, the cleanup respects the replacement and leaves it in place.

### Writing effective descriptions

| Do | Don't |
|---|---|
| Summarize the page content in 1-2 sentences | Start with "A page about..." or "This is the..." |
| Include relevant keywords naturally | Keyword-stuff or repeat the page title verbatim |
| Keep under 160 characters for search result display | Exceed 320 characters |
| Describe what the user can do or find on the page | Use generic text like "Paperclip page" |
| Use action verbs for interactive pages | Describe the UI components instead of the content |

### Pages with meta descriptions

The following page types include meta descriptions:

| Page | Example title | Example description |
|---|---|---|
| Dashboard | "Dashboard — Paperclip" | An overview of the company's current state and agent activity |
| Issues | "Issues — Paperclip" | Manage and track all issues for the company |
| Issue Detail | "VOY-123: Fix login bug — Paperclip" | (Dynamic — from issue summary) |
| Agents | "Agents — Paperclip" | View and manage your AI agents |
| Agent Detail | "Agent Name — Paperclip" | (Dynamic — from agent role) |
| Search | "Search — Paperclip" | Search across issues, documents, and knowledge |
| Goals | "Goals — Paperclip" | View and manage company goals and projects |
| Projects | "Projects — Paperclip" | Manage your company projects |
| Pricing | "Pricing — Paperclip" | Paperclip pricing plans and features |
| Companies | "Companies — Paperclip" | Manage your companies |
| Profile Settings | "Profile Settings — Paperclip" | Manage your Paperclip account and preferences |
| Not Found | "Not Found — Paperclip" | The page you requested was not found |

Pages without explicit descriptions omit the meta description tag entirely, falling back to the app-wide default in `index.html`: *"Paperclip — AI-powered issue tracking and project management for modern teams."*

### Adding meta to a new page

1. Import the hook: `import { usePageMeta } from "@/hooks/usePageMeta"`
2. Call it inside the component body (not before the component definition):
   ```typescript
   function MyPage() {
     usePageMeta("My Page Title", "A concise description of this page");
     // ...
   }
   ```
3. For dynamic content (e.g. issue titles), derive the title from route params or API data. Use a fallback for loading states:
   ```typescript
   const { identifier } = useParams();
   const { data: issue } = useQuery(...);

   usePageMeta(
     issue ? `${issue.identifier}: ${issue.title}` : "Loading...",
     issue ? `View issue ${issue.identifier}: ${issue.title}` : undefined,
   );
   ```
4. For pages that benefit from social media previews, add the optional `og` parameter with the canonical URL and image.

### Verification checklist for developers

- [ ] `usePageMeta` is called inside the component function body, not at module scope
- [ ] Dynamic data (titles from API) has loading-state fallbacks
- [ ] Description is concise, under 160 characters when possible
- [ ] Description is not a duplicate of the title
- [ ] The meta tag is tested by navigating to the page and inspecting `<title>` in the browser DevTools
- [ ] For pages that should produce rich link previews: verify `og:title`, `twitter:title`, `og:description`, and `twitter:description` are present in DevTools `Elements` panel under `<head>`

---

## 4. Open Graph and Twitter Card Tags

Every page that calls `usePageMeta` automatically gets Open Graph (`og:*`) and Twitter Card (`twitter:*`) meta tags in the page `<head>`. These tags enable rich link previews when a Paperclip page is shared on social media, messaging apps, or collaboration tools like Slack and Discord.

### Tags generated automatically

| Property | Source | Example value |
|---|---|---|
| `og:title` | Page `title` parameter | `"Dashboard — Paperclip"` |
| `og:description` | Page `description` parameter | `"Overview of your company's active issues and agent activity"` |
| `og:type` | Defaults to `"website"` | `"website"` |
| `twitter:title` | Page `title` parameter | `"Dashboard — Paperclip"` |
| `twitter:description` | Page `description` parameter | `"Overview of your company's active issues and agent activity"` |
| `twitter:card` | Always `"summary"` | `"summary"` |

### Tags configurable via the `og` parameter

| Property | `PageMetaOg` field | Example |
|---|---|---|
| `og:url` | `url` | `"https://app.paperclip.ai/ACME/dashboard"` |
| `og:image` | `image` | `"https://app.paperclip.ai/og-image-default.png"` |
| `og:image:alt` | `imageAlt` | `"Paperclip project management"` |

### Base defaults in `index.html`

The HTML shell (`ui/index.html`) includes fallback OG/Twitter tags so that pages that do not use `usePageMeta` (or that render before the React hook runs) still have basic social metadata:

```html
<meta property="og:type" content="website" />
<meta property="og:title" content="Paperclip" />
<meta property="og:description" content="Paperclip — AI-powered issue tracking and project management for modern teams." />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Paperclip" />
<meta name="twitter:description" content="Paperclip — AI-powered issue tracking and project management for modern teams." />
```

### What this means for shared links

When someone shares a Paperclip page on:
- **Slack** — Shows the page title, description, and (if configured) image
- **Twitter/X** — Shows a summary card with title and description
- **LinkedIn** — Shows the title, description, and (if configured) image
- **Discord** — Shows the title and description with a small thumbnail
- **iMessage / SMS** — Fallback link preview with title and description

---

## 5. Technical Summary

| Component | File | Language | Route | Cache |
|---|---|---|---|---|
| Sitemap route | `server/src/routes/seo.ts` | TypeScript (Express) | `GET /sitemap.xml` | `public, max-age=3600` |
| Robots route | `server/src/routes/seo.ts` | TypeScript (Express) | `GET /robots.txt` | `public, max-age=3600` |
| Meta tag hook (incl. OG/Twitter) | `ui/src/hooks/usePageMeta.ts` | TypeScript (React) | N/A (client-side) | N/A |
| Route registration | `server/src/app.ts` | TypeScript (Express) | Before SPA fallback | N/A |

Both routes are registered outside the `/api` namespace and before the SPA catch-all, ensuring crawlers receive the correct response instead of the HTML application shell.

### Graceful degradation

- **DB unavailable**: Sitemap returns empty `<urlset>` with 200, preventing crawler retry spikes
- **Unknown host**: Falls back to `paperclip.ai` as the default domain
- **No meta description on page**: The default description from `index.html` is preserved; stale descriptions from previous pages are cleaned up automatically
- **No OG/Twitter config**: Base defaults from `index.html` are used, providing basic social metadata even before React renders
- **SSE unavailable** (for real-time meta updates): Not applicable — `usePageMeta` operates synchronously on mount and is not SSE-dependent

---

## 6. Related Documentation

- [v0.4.1 Release Note — SEO Metadata Infrastructure](./releases/v0-4-1-seo-infrastructure.md)
- [Support Knowledge Base: SEO Assessment](../support/assessments/support-case-seo-metadata.md)
- [Deployment Guide: Environment Variables](../deploy/environment-variables.md) — For proxy header configuration affecting host resolution
