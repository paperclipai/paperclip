# Configuration

## Setup Methods

### Proxied Sites (Automatic)

Dashboard → Web Analytics → Add site → Select hostname → Done

| Injection Option | Description |
|------------------|-------------|
| Enable | Auto-inject for all visitors (default) |
| Enable, excluding EU | No injection for EU (GDPR) |
| Enable with manual snippet | You add beacon manually |
| Disable | Pause tracking |

**Fails if response has:** `Cache-Control: public, no-transform`

**CSP required:**
```
script-src https://static.cloudflareinsights.com https://cloudflareinsights.com;
```

### Non-Proxied Sites (Manual)

Dashboard → Web Analytics → Add site → Enter hostname → Copy snippet

```html
<script defer src='https://static.cloudflareinsights.com/beacon.min.js' 
        data-cf-beacon='{"token": "YOUR_TOKEN", "spa": true}'></script>
```

**Limits:** 10 non-proxied sites per account

## SPA Mode

**Enable `spa: true` for:** React Router, Next.js, Vue Router, Nuxt, SvelteKit, Angular

**Keep `spa: false` for:** Traditional multi-page apps, static sites, WordPress

**Hash routing (`#/path`) NOT supported** - use History API routing.

## Token Management

- Found in: Dashboard → Web Analytics → Manage site
- **Not secrets** - domain-locked, safe to expose in HTML
- Each site gets unique token

## Environment Config

```typescript
// Only load in production
if (process.env.NODE_ENV === 'production') {
  // Load beacon
}
```

Or use environment-specific tokens via env vars.

## Verify Installation

1. DevTools Network → filter `cloudflareinsights` → see `beacon.min.js` + data request
2. No CSP/CORS errors in console
3. Dashboard shows pageviews after 5-10 min delay

## Rules (Plan-dependent)

Configure in dashboard for:
- **Sample rate** - reduce collection % for high-traffic
- **Path-based** - different behavior per route
- **Host-based** - separate tracking per domain

## Data Retention

- 6 months rolling window
- 1-hour bucket granularity
- No raw export, dashboard only
