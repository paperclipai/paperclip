# Web Analytics Gotchas

## Critical Issues

### SPA Navigation Not Tracked

**Symptom:** Only initial pageload counted  
**Fix:** Add `spa: true`:
```html
<script data-cf-beacon='{"token": "TOKEN", "spa": true}' ...></script>
```

### CSP Blocking Beacon

**Symptom:** Console error "Refused to load script"  
**Fix:** Allow both domains:
```
script-src 'self' https://static.cloudflareinsights.com https://cloudflareinsights.com;
```

### Hash-Based Routing Unsupported

**Symptom:** `#/path` URLs not tracked  
**Fix:** Migrate to History API (`BrowserRouter`, not `HashRouter`). No workaround for hash routing.

### No Data Appearing

**Causes & Fixes:**
1. **Delay** - Wait 5-15 minutes
2. **Wrong token** - Verify matches dashboard exactly
3. **Script blocked** - Check DevTools Network tab for beacon.min.js
4. **Domain mismatch** - Dashboard site must match actual URL

### Auto-Injection Fails

**Cause:** `Cache-Control: no-transform` header  
**Fix:** Remove `no-transform` or install beacon manually

### Duplicate Pageviews

**Cause:** Multiple beacon scripts  
**Fix:** Keep only one beacon per page

## Configuration Issues

| Issue | Fix |
|-------|-----|
| 10-site limit reached | Delete old sites or proxy through CF (unlimited) |
| Token not recognized | Use exact alphanumeric token from dashboard |

## Framework-Specific

### Next.js Hydration Warning

```tsx
<script suppressHydrationWarning ... />
```

### Gatsby Window Undefined

Use `gatsby-browser.js` to load client-side only.

## Limits

| Resource | Limit |
|----------|-------|
| Non-proxied sites | 10 |
| Proxied sites | Unlimited |
| Data retention | 6 months |
| Ingestion delay | 5-10 min |
| API access | None (dashboard only) |

## When NOT to Use Web Analytics

Use alternatives if you need:
- Custom event tracking
- Real-time data
- User-level tracking
- Conversion funnels
- Data export/API access

**Web Analytics excels at:** Core Web Vitals, basic traffic, privacy compliance, free unlimited pageviews.
