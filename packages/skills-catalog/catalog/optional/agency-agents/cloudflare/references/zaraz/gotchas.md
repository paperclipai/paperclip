# Zaraz Gotchas

## Events Not Firing

**Check:**
1. Tool enabled in dashboard (green dot)
2. Trigger conditions met
3. Consent granted for tool's purpose
4. Tool credentials correct (GA4: `G-XXXXXXXXXX`, FB: numeric only)

**Debug:**
```javascript
zaraz.debug = true;
console.log('Tools:', zaraz.tools);
console.log('Consent:', zaraz.consent.getAll());
```

## Consent Issues

**Modal not showing:**
```javascript
// Clear consent cookie
document.cookie = 'zaraz-consent=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
location.reload();
```

**Tools firing before consent:** Map tool to consent purpose with "Do not load until consent granted".

## SPA Tracking

**Route changes not tracked:**
1. Configure History Change trigger in dashboard
2. Hash routing (`#/path`) requires manual tracking:
```javascript
window.addEventListener('hashchange', () => {
  zaraz.track('pageview', { page_path: location.pathname + location.hash });
});
```

**React fix:**
```javascript
const location = useLocation();
useEffect(() => {
  zaraz.track('pageview', { page_path: location.pathname });
}, [location]); // Include dependency
```

## Performance

**Slow page load:**
- Audit tool count (50+ degrades performance)
- Disable blocking triggers unless required
- Reduce event payload size (<100KB)

## Tool-Specific Issues

| Tool | Issue | Fix |
|------|-------|-----|
| GA4 | Events not in real-time | Wait 5-10 min, use DebugView |
| Facebook | Invalid Pixel ID | Use numeric only (no `fbpx_` prefix) |
| Google Ads | Conversions not attributed | Include `send_to: 'AW-XXX/LABEL'` |

## Data Layer

- Properties persist per page only - set on each page load
- Nested access: `{{client.__zarazTrack.user.plan}}`

## Limits

| Resource | Limit |
|----------|-------|
| Request size | 100KB |
| Consent purposes | 20 |
| API rate | 1000 req/sec |

## When NOT to Use Zaraz

- Server-to-server tracking (use Workers)
- Real-time bidirectional communication
- Binary data transmission
- Authentication flows
