# Bot Management API

## Workers: BotManagement Interface

```typescript
interface BotManagement {
  score: number;              // 1-99 (Enterprise), 0 if not computed
  verifiedBot: boolean;       // Is verified bot
  staticResource: boolean;    // Serves static resource
  ja3Hash: string;            // JA3 fingerprint (Enterprise, HTTPS only)
  ja4: string;                // JA4 fingerprint (Enterprise, HTTPS only)
  jsDetection?: {
    passed: boolean;          // Passed JS detection (if enabled)
  };
  detectionIds: number[];     // Heuristic detection IDs
  corporateProxy?: boolean;   // From corporate proxy (Enterprise)
}

// DEPRECATED: Use botManagement.score instead
// request.cf.clientTrustScore (legacy, duplicate of botManagement.score)

// Access via request.cf
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

export default {
  async fetch(request: Request): Promise<Response> {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    const botMgmt = cf?.botManagement;
    
    if (!botMgmt) return fetch(request);
    if (botMgmt.verifiedBot) return fetch(request); // Allow verified bots
    if (botMgmt.score === 1) return new Response('Blocked', { status: 403 });
    if (botMgmt.score < 30) return new Response('Challenge required', { status: 429 });
    
    return fetch(request);
  }
};
```

## WAF Fields Reference

```txt
# Score fields
cf.bot_management.score                    # 0-99 (0 = not computed)
cf.bot_management.verified_bot             # boolean
cf.bot_management.static_resource          # boolean
cf.bot_management.ja3_hash                 # string (Enterprise)
cf.bot_management.ja4                      # string (Enterprise)
cf.bot_management.detection_ids            # array
cf.bot_management.js_detection.passed      # boolean
cf.bot_management.corporate_proxy          # boolean (Enterprise)
cf.verified_bot_category                   # string

# Workers equivalent
request.cf.botManagement.score
request.cf.botManagement.verifiedBot
request.cf.botManagement.ja3Hash
request.cf.botManagement.ja4
request.cf.botManagement.jsDetection.passed
request.cf.verifiedBotCategory
```

## JA4 Signals (Enterprise)

```typescript
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

interface JA4Signals {
  // Ratios (0.0-1.0)
  heuristic_ratio_1h?: number;  // Fraction flagged by heuristics
  browser_ratio_1h?: number;    // Fraction from real browsers  
  cache_ratio_1h?: number;      // Fraction hitting cache
  h2h3_ratio_1h?: number;       // Fraction using HTTP/2 or HTTP/3
  // Ranks (relative position in distribution)
  uas_rank_1h?: number;         // User-Agent diversity rank
  paths_rank_1h?: number;       // Path diversity rank
  reqs_rank_1h?: number;        // Request volume rank
  ips_rank_1h?: number;         // IP diversity rank
  // Quantiles (0.0-1.0, percentile in distribution)
  reqs_quantile_1h?: number;    // Request volume quantile
  ips_quantile_1h?: number;     // IP count quantile
}

export default {
  async fetch(request: Request): Promise<Response> {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    const ja4Signals = cf?.ja4Signals as JA4Signals | undefined;
    
    if (!ja4Signals) return fetch(request); // Not available for HTTP or Worker routing
    
    // Check for anomalous behavior
    // High heuristic_ratio or low browser_ratio = suspicious
    const heuristicRatio = ja4Signals.heuristic_ratio_1h ?? 0;
    const browserRatio = ja4Signals.browser_ratio_1h ?? 0;
    
    if (heuristicRatio > 0.5 || browserRatio < 0.3) {
      return new Response('Suspicious traffic', { status: 403 });
    }
    
    return fetch(request);
  }
};
```

## Common Patterns

See [patterns.md](./patterns.md) for Workers examples: mobile app allowlisting, corporate proxy exemption, datacenter detection, conditional delay, and more.

## Bot Analytics

### Access Locations
- Dashboard: Security > Bots (old) or Security > Analytics > Bot analysis (new)
- GraphQL API for programmatic access
- Security Events & Security Analytics
- Logpush/Logpull

### Available Data
- **Enterprise BM**: Bot scores (1-99), bot score source, distribution
- **Pro/Business**: Bot groupings (automated, likely automated, likely human)
- Top attributes: IPs, paths, user agents, countries
- Detection sources: Heuristics, ML, AD, JSD
- Verified bot categories

### Time Ranges
- **Enterprise BM**: Up to 1 week at a time, 30 days history
- **Pro/Business**: Up to 72 hours at a time, 30 days history
- Real-time in most cases, adaptive sampling (1-10% depending on volume)

## Logpush Fields

```txt
BotScore              # 1-99 or 0 if not computed
BotScoreSrc           # Detection engine (ML, Heuristics, etc.)
BotTags               # Classification tags
BotDetectionIDs       # Heuristic detection IDs
```

**BotScoreSrc values:**
- `"Heuristics"` - Known fingerprint
- `"Machine Learning"` - ML model
- `"Anomaly Detection"` - Baseline anomaly
- `"JS Detection"` - JavaScript check
- `"Cloudflare Service"` - Zero Trust
- `"Not Computed"` - Score = 0

Access via Logpush (stream to cloud storage/SIEM), Logpull (API to fetch logs), or GraphQL API (query analytics data).

## Testing with Miniflare

Miniflare provides mock botManagement data for local development:

**Default values:**
- `score: 99` (human)
- `verifiedBot: false`
- `corporateProxy: false`
- `ja3Hash: "25b4882c2bcb50cd6b469ff28c596742"`
- `staticResource: false`
- `detectionIds: []`

**Override in tests:**
```typescript
import { getPlatformProxy } from 'wrangler';

const { cf, dispose } = await getPlatformProxy();
// cf.botManagement is frozen mock object
expect(cf.botManagement.score).toBe(99);
```

For custom test data, mock request.cf in your test setup.
