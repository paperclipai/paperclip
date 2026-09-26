# Bot Management Configuration

## Product Tiers

**Note:** Dashboard paths differ between old and new UI:
- **New:** Security > Settings > Filter "Bot traffic"
- **Old:** Security > Bots

Both UIs access same settings.

### Bot Score Groupings (Pro/Business)

Pro/Business users see bot score groupings instead of granular 1-99 scores:

| Score | Grouping | Meaning |
|-------|----------|---------|
| 0 | Not computed | Bot Management didn't run |
| 1 | Automated | Definite bot (heuristic match) |
| 2-29 | Likely automated | Probably bot (ML detection) |
| 30-99 | Likely human | Probably human |
| N/A | Verified bot | Allowlisted good bot |

Enterprise plans get granular 1-99 scores for custom thresholds.

### Bot Fight Mode (Free)
- Auto-blocks definite bots (score=1), excludes verified bots by default
- JavaScript Detections always enabled, no configuration options

### Super Bot Fight Mode (Pro/Business)
```txt
Dashboard: Security > Bots > Configure
- Definitely automated: Block/Challenge
- Likely automated: Challenge/Allow  
- Verified bots: Allow (recommended)
- Static resource protection: ON (may block mail clients)
- JavaScript Detections: Optional
```

### Bot Management for Enterprise
```txt
Dashboard: Security > Bots > Configure > Auto-updates: ON (recommended)

# Template 1: Block definite bots
(cf.bot_management.score eq 1 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource)
Action: Block

# Template 2: Challenge likely bots
(cf.bot_management.score ge 2 and cf.bot_management.score le 29 and not cf.bot_management.verified_bot and not cf.bot_management.static_resource)
Action: Managed Challenge
```

## JavaScript Detections Setup

### Enable via Dashboard
```txt
Security > Bots > Configure Bot Management > JS Detections: ON

Update CSP: script-src 'self' /cdn-cgi/challenge-platform/;
```

### Manual JS Injection (API)
```html
<script>
function jsdOnload() {
  window.cloudflare.jsd.executeOnce({ callback: function(result) { console.log('JSD:', result); } });
}
</script>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js?onload=jsdOnload" async></script>
```

**Use API for**: Selective deployment on specific pages  
**Don't combine**: Zone-wide toggle + manual injection

### WAF Rules for JSD
```txt
# NEVER use on first page visit (needs HTML page first)
(not cf.bot_management.js_detection.passed and http.request.uri.path eq "/api/user/create" and http.request.method eq "POST" and not cf.bot_management.verified_bot)
Action: Managed Challenge (always use Managed Challenge, not Block)
```

### Limitations
- First request won't have JSD data (needs HTML page first)
- Strips ETags from HTML responses
- Not supported with CSP via `<meta>` tags
- Websocket endpoints not supported
- Native mobile apps won't pass
- cf_clearance cookie: 15-minute lifespan, max 4096 bytes

## __cf_bm Cookie

Cloudflare sets `__cf_bm` cookie to smooth bot scores across user sessions:

- **Purpose:** Reduces false positives from score volatility
- **Scope:** Per-domain, HTTP-only
- **Lifespan:** Session duration
- **Privacy:** No PII—only session classification
- **Automatic:** No configuration required

Bot scores for repeat visitors consider session history via this cookie.

## Static Resource Protection

**File Extensions**: ico, jpg, png, jpeg, gif, css, js, tif, tiff, bmp, pict, webp, svg, svgz, class, jar, txt, csv, doc, docx, xls, xlsx, pdf, ps, pls, ppt, pptx, ttf, otf, woff, woff2, eot, eps, ejs, swf, torrent, midi, mid, m3u8, m4a, mp3, ogg, ts  
**Plus**: `/.well-known/` path (all files)

```txt
# Exclude static resources from bot rules
(cf.bot_management.score lt 30 and not cf.bot_management.static_resource)
```

**WARNING**: May block mail clients fetching static images

## JA3/JA4 Fingerprinting (Enterprise)

```txt
# Block specific attack fingerprint
(cf.bot_management.ja3_hash eq "8b8e3d5e3e8b3d5e")

# Allow mobile app by fingerprint
(cf.bot_management.ja4 eq "your_mobile_app_fingerprint")
```

Only available for HTTPS/TLS traffic. Missing for Worker-routed traffic or HTTP requests.

## Verified Bot Categories

```txt
# Allow search engines only
(cf.verified_bot_category eq "Search Engine Crawler")

# Block AI crawlers
(cf.verified_bot_category eq "AI Crawler")
Action: Block

# Or use dashboard: Security > Settings > Bot Management > Block AI Bots
```

| Category | String Value | Example |
|----------|--------------|---------|
| AI Crawler | `AI Crawler` | GPTBot, Claude-Web |
| AI Assistant | `AI Assistant` | Perplexity-User, DuckAssistBot |
| AI Search | `AI Search` | OAI-SearchBot |
| Accessibility | `Accessibility` | Accessible Web Bot |
| Academic Research | `Academic Research` | Library of Congress |
| Advertising & Marketing | `Advertising & Marketing` | Google Adsbot |
| Aggregator | `Aggregator` | Pinterest, Indeed |
| Archiver | `Archiver` | Internet Archive, CommonCrawl |
| Feed Fetcher | `Feed Fetcher` | RSS/Podcast updaters |
| Monitoring & Analytics | `Monitoring & Analytics` | Uptime monitors |
| Page Preview | `Page Preview` | Facebook/Slack link preview |
| SEO | `Search Engine Optimization` | Google Lighthouse |
| Security | `Security` | Vulnerability scanners |
| Social Media Marketing | `Social Media Marketing` | Brandwatch |
| Webhooks | `Webhooks` | Payment processors |
| Other | `Other` | Uncategorized bots |

## Best Practices

- **ML Auto-Updates**: Enable on Enterprise for latest models
- **Start with Managed Challenge**: Test before blocking
- **Always exclude verified bots**: Use `not cf.bot_management.verified_bot`
- **Exempt corporate proxies**: For B2B traffic via `cf.bot_management.corporate_proxy`
- **Use static resource exception**: Improves performance, reduces overhead
