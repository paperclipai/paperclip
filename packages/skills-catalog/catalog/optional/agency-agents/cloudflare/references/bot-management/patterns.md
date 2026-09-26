# Bot Management Patterns

## E-commerce Protection

```txt
# High security for checkout
(cf.bot_management.score lt 50 and http.request.uri.path in {"/checkout" "/cart/add"} and not cf.bot_management.verified_bot and not cf.bot_management.corporate_proxy)
Action: Managed Challenge
```

## API Protection

```txt
# Protect API with JS detection + score
(http.request.uri.path matches "^/api/" and (cf.bot_management.score lt 30 or not cf.bot_management.js_detection.passed) and not cf.bot_management.verified_bot)
Action: Block
```

## SEO-Friendly Bot Handling

```txt
# Allow search engine crawlers
(cf.bot_management.score lt 30 and not cf.verified_bot_category in {"Search Engine Crawler"})
Action: Managed Challenge
```

## Block AI Scrapers

```txt
# Block training crawlers only (allow AI assistants/search)
(cf.verified_bot_category eq "AI Crawler")
Action: Block

# Block all AI-related bots (training + assistants + search)
(cf.verified_bot_category in {"AI Crawler" "AI Assistant" "AI Search"})
Action: Block

# Allow AI Search, block AI Crawler and AI Assistant
(cf.verified_bot_category in {"AI Crawler" "AI Assistant"})
Action: Block

# Or use dashboard: Security > Settings > Bot Management > Block AI Bots
```

## Rate Limiting by Bot Score

```txt
# Stricter limits for suspicious traffic
(cf.bot_management.score lt 50)
Rate: 10 requests per 10 seconds

(cf.bot_management.score ge 50)
Rate: 100 requests per 10 seconds
```

## Mobile App Allowlisting

```txt
# Identify mobile app by JA3/JA4
(cf.bot_management.ja4 in {"fingerprint1" "fingerprint2"})
Action: Skip (all remaining rules)
```

## Datacenter Detection

```typescript
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

// Low score + not corporate proxy = likely datacenter bot
export default {
  async fetch(request: Request): Promise<Response> {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    const botMgmt = cf?.botManagement;
    
    if (botMgmt?.score && botMgmt.score < 30 && 
        !botMgmt.corporateProxy && !botMgmt.verifiedBot) {
      return new Response('Datacenter traffic blocked', { status: 403 });
    }
    
    return fetch(request);
  }
};
```

## Conditional Delay (Tarpit)

```typescript
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

// Add delay proportional to bot suspicion
export default {
  async fetch(request: Request): Promise<Response> {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    const botMgmt = cf?.botManagement;
    
    if (botMgmt?.score && botMgmt.score < 50 && !botMgmt.verifiedBot) {
      // Delay: 0-2 seconds for scores 50-0
      const delayMs = Math.max(0, (50 - botMgmt.score) * 40);
      await new Promise(r => setTimeout(r, delayMs));
    }
    
    return fetch(request);
  }
};
```

## Layered Defense

```txt
1. Bot Management (score-based)
2. JavaScript Detections (for JS-capable clients)
3. Rate Limiting (fallback protection)
4. WAF Managed Rules (OWASP, etc.)
```

## Progressive Enhancement

```txt
Public content: High threshold (score < 10)
Authenticated: Medium threshold (score < 30)
Sensitive: Low threshold (score < 50) + JSD
```

## Zero Trust for Bots

```txt
1. Default deny (all scores < 30)
2. Allowlist verified bots
3. Allowlist mobile apps (JA3/JA4)
4. Allowlist corporate proxies
5. Allowlist static resources
```

## Workers: Score + JS Detection

```typescript
import type { IncomingRequestCfProperties } from '@cloudflare/workers-types';

export default {
  async fetch(request: Request): Promise<Response> {
    const cf = request.cf as IncomingRequestCfProperties | undefined;
    const botMgmt = cf?.botManagement;
    const url = new URL(request.url);
    
    if (botMgmt?.staticResource) return fetch(request); // Skip static
    
    // API endpoints: require JS detection + good score
    if (url.pathname.startsWith('/api/')) {
      const jsDetectionPassed = botMgmt?.jsDetection?.passed ?? false;
      const score = botMgmt?.score ?? 100;
      
      if (!jsDetectionPassed || score < 30) {
        return new Response('Unauthorized', { status: 401 });
      }
    }
    
    return fetch(request);
  }
};
```

## Rate Limiting by JWT Claim + Bot Score

```txt
# Enterprise: Combine bot score with JWT validation
Rate limiting > Custom rules
- Field: lookup_json_string(http.request.jwt.claims["{config_id}"][0], "sub")
- Matches: user ID claim
- Additional condition: cf.bot_management.score lt 50
```

## WAF Integration Points

- **WAF Custom Rules**: Primary enforcement mechanism
- **Rate Limiting Rules**: Bot score as dimension, stricter limits for low scores
- **Transform Rules**: Pass score to origin via custom header
- **Workers**: Programmatic bot logic, custom scoring algorithms
- **Page Rules / Configuration Rules**: Zone-level overrides, path-specific settings

## See Also

- [gotchas.md](./gotchas.md) - Common errors, false positives/negatives, limitations
