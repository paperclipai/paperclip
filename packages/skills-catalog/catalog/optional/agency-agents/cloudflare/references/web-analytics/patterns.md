# Web Analytics Patterns

## Core Web Vitals Debugging

Dashboard → Core Web Vitals → Click metric → Debug View shows top 5 problematic elements.

### LCP Fixes

```html
<!-- Priority hints -->
<img src="hero.jpg" loading="eager" fetchpriority="high" />
<link rel="preload" as="image" href="/hero.jpg" fetchpriority="high" />
```

### CLS Fixes

```css
/* Reserve space */
.ad-container { min-height: 250px; }
img { width: 400px; height: 300px; } /* Explicit dimensions */
```

### INP Fixes

```typescript
// Debounce expensive operations
const handleInput = debounce(search, 300);

// Yield to main thread
await task(); await new Promise(r => setTimeout(r, 0)); await task2();

// Move to Web Worker for heavy computation
```

| Metric | Good | Poor |
|--------|------|------|
| LCP | ≤2.5s | >4s |
| INP | ≤200ms | >500ms |
| CLS | ≤0.1 | >0.25 |

## GDPR Consent

```typescript
// Load beacon only after consent
const consent = localStorage.getItem('analytics-consent');
if (consent === 'accepted') {
  const script = document.createElement('script');
  script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  script.setAttribute('data-cf-beacon', '{"token": "TOKEN", "spa": true}');
  document.body.appendChild(script);
}
```

Alternative: Dashboard → "Enable, excluding visitor data in the EU"

## SPA Navigation

```html
<!-- REQUIRED for React/Vue/etc routing -->
<script data-cf-beacon='{"token": "TOKEN", "spa": true}' ...></script>
```

Without `spa: true`: only initial pageload tracked.

## Staging/Production Separation

```typescript
// Use env-specific tokens
const token = process.env.NEXT_PUBLIC_CF_ANALYTICS_TOKEN;
// .env.production: production token
// .env.staging: staging token (or empty to disable)
```

## Bot Filtering

Dashboard → Filters → "Exclude Bot Traffic"

Filters: Search crawlers, monitoring services, known bots.  
Not filtered: Headless browsers (Playwright/Puppeteer).

## Ad-Blocker Impact

~25-40% of users may block `cloudflareinsights.com`. No official workaround.
Dashboard shows minimum baseline; use server logs for complete picture.

## Limitations

- No UTM parameter tracking
- No webhooks/alerts/API
- No custom beacon domains
- Max 10 non-proxied sites
