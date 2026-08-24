# SEO Best Practices for Agent Developers

**Version**: v1.0 | **Applies to**: Paperclip v0.4.1+ | **Last updated**: 2026-08-23
**Related**: VOY-1695, VOY-1798, VOY-1866

## Overview

Paperclip has a lightweight SEO infrastructure that generates search-engine-friendly metadata for all public-facing pages. This guide covers how to use the available tools and how to contribute to keeping Paperclip well-optimized for search engines.

## Available Infrastructure

### 1. `usePageMeta` Hook

Every page component should call `usePageMeta()` to set a descriptive page title and meta description.

**File**: `ui/src/hooks/usePageMeta.ts`

```typescript
import { usePageMeta } from "@/hooks/usePageMeta";

export function MyPage() {
  usePageMeta("Page Title", "Brief description of this page.");
  // ... component body
}
```

**Parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | Yes | Page-specific title. The app name " — Paperclip" is appended automatically. Pass empty string `""` for the bare app name. |
| `description` | `string` | Optional | Meta description content. If omitted, any existing `<meta name="description">` tag is removed (prevents stale descriptions between page navigations). |

**How it works:**

- Sets `document.title` immediately on mount
- Injects or updates `<meta name="description" content="...">` in `<head>`
- On cleanup (unmount or dependency change), restores the previous title and removes the meta tag if this component created it
- Uses a **last-call-wins** pattern: child routes override parent meta because React runs the deepest effect last

**When to add `usePageMeta`:**

- Every route component (page-level component) should call `usePageMeta`
- The title should be human-readable and context-specific (e.g., "Agent Detail", "Billing Settings")
- The description should summarize the page's purpose in 1-2 sentences (max ~160 characters recommended)

### 2. Sitemap (`/sitemap.xml`)

**File**: `server/src/routes/seo.ts`

The sitemap is auto-generated on every request. It includes:

- Static pages: `/`, `/pricing`
- Company pages: `/{prefix}/dashboard`, `/{prefix}/issues` (for active companies only)
- Issue pages: `/{prefix}/issues/{identifier}` (for non-hidden, non-cancelled, non-backlog issues)

**What affects sitemap inclusion:**

| Entity | Included when | Excluded when |
|---|---|---|
| Company | `status = 'active'` | `status` is anything else (suspended, archived, etc.) |
| Issue | `status` is not `cancelled` or `backlog`, AND `hiddenAt` is `null`, AND `identifier` is not `null` | Status is `cancelled` or `backlog`, OR `hiddenAt` is set, OR no identifier |

**Limits**: 10,000 companies and 10,000 issues maximum (prevents monster XML generation).

### 3. Robots.txt (`/robots.txt`)

**File**: `server/src/routes/seo.ts`

```
User-agent: *
Allow: /
Disallow: /api/

Sitemap: https://[host]/sitemap.xml
```

**Important**: SEO routes (`seoRoutes(db)`) must be registered in `app.ts` **before** the SPA fallback catch-all. Currently registered at line 681 of `server/src/app.ts`.

### 4. Base HTML Metadata

**File**: `ui/index.html`

The base HTML includes:

- `<meta charset="UTF-8">`
- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
- `<meta name="theme-color" content="#18181b">`
- `<meta name="apple-mobile-web-app-title" content="Paperclip">`
- `<meta name="description" content="Paperclip — AI-powered issue tracking and project management for modern teams.">` (fallback)

The branding placeholder `<!-- PAPERCLIP_RUNTIME_BRANDING_START -->` allows runtime overrides for branded instances.

## Best Practices

### When Adding a New Page

1. **Always call `usePageMeta`** — Place it at the top of the component function, before any conditional logic or early returns:
   ```typescript
   export function NewFeaturePage() {
     usePageMeta("New Feature", "Manage your new feature settings and preferences.");
     // ...
   }
   ```

2. **Write human-readable titles** — Use sentence case. Examples:
   - ✅ "Live Agent Runs", "Billing Settings", "Agent Detail"
   - ❌ "live-agent-runs", "billing_settings", "agentDetail"

3. **Write meaningful descriptions** — Think about what someone sees in search results. Describe the page's purpose and value in 120-160 characters. Examples:
   - ✅ "View real-time active agent runs and monitor your team's productivity."
   - ✅ "Configure your subscription tier, view usage metrics, and manage invoices."
   - ❌ "A page for viewing runs." (too vague)
   - ❌ (empty) (missed opportunity for search visibility)

4. **Test the meta tags** — After adding your hook, inspect the page's `<head>` in browser DevTools to verify the title and description render correctly.

### When Adding Dynamic Content

- **Company-scoped pages**: The `usePageMeta` hook does not currently support company-name injection into titles/descriptions. If you need this, extend the hook to accept an optional format callback, or set the document title directly with a `useEffect`.
- **Issue-scoped pages**: The issue detail page uses a generic description. For per-issue descriptions, you would need to pass issue-specific text to `usePageMeta`.

### Sitemap Considerations

- **Hiding issues**: Set `hiddenAt` on any issue that should not appear in the sitemap (e.g., drafts, internal notes, sensitive content).
- **Cancelling vs. hiding**: Cancelled issues can still have `hiddenAt = null`, meaning they may appear in the sitemap if not explicitly hidden.
- **Adding new public pages**: If you add a new static route that should appear in the sitemap, add a `<url>` entry in the `sitemap.xml` handler at `server/src/routes/seo.ts`.

## What NOT Yet Available (Future Scope)

These SEO elements are **not yet implemented** — contributions welcome:

- **Open Graph tags** (`og:title`, `og:description`, `og:image`) — for rich link previews on social media and messaging platforms
- **Twitter Card tags** — for Twitter link previews
- **JSON-LD structured data** — for rich search results (breadcrumbs, organization, FAQ)
- **Heading hierarchy audit** — ensuring proper h1-h6 semantic structure

## Testing SEO

### Verify a page's meta tags:

```bash
curl -s https://[host]/page-path | grep -E '<title|<meta name="description"'
```

### Verify sitemap:

```bash
curl -s https://[host]/sitemap.xml | head -50
```

### Verify robots.txt:

```bash
curl -s https://[host]/robots.txt
```

### Validate XML:

```bash
curl -s https://[host]/sitemap.xml | xmllint --noout -
```

## Troubleshooting

| Problem | Check |
|---|---|
| Page title not updating | Is `usePageMeta` called unconditionally at the top of the component? |
| Description missing | Is a `description` string passed as the second argument to `usePageMeta`? |
| Stale description on navigation | The cleanup function should remove the meta tag; verify the component unmounts properly |
| robots.txt returns HTML shell | Are SEO routes registered before the SPA fallback in `app.ts`? |
| Sitemap empty | Check database connectivity and company statuses |

## Related Resources

- [Support Case Assessment: SEO Metadata](/support/assessments/support-case-seo-metadata)
- [Release Notes: v0.4.1 — SEO Metadata Infrastructure](/documentation/releases/v0-4-1-seo-infrastructure)
- Source: `server/src/routes/seo.ts`
- Source: `ui/src/hooks/usePageMeta.ts`