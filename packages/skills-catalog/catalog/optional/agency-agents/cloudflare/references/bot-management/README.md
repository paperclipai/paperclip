# Cloudflare Bot Management

Enterprise-grade bot detection, protection, and mitigation using ML/heuristics, bot scores, JavaScript detections, and verified bot handling.

## Overview

Bot Management provides multi-tier protection:
- **Free (Bot Fight Mode)**: Auto-blocks definite bots, no config
- **Pro/Business (Super Bot Fight Mode)**: Configurable actions, static resource protection, analytics groupings
- **Enterprise (Bot Management)**: Granular 1-99 scores, WAF integration, JA3/JA4 fingerprinting, Workers API, Advanced Analytics

## Quick Start

```txt
# Dashboard: Security > Bots
# Enterprise: Deploy rule template
(cf.bot_management.score eq 1 and not cf.bot_management.verified_bot) → Block
(cf.bot_management.score le 29 and not cf.bot_management.verified_bot) → Managed Challenge
```

## What Do You Need?

```txt
├─ Initial setup → configuration.md
│   ├─ Free tier → "Bot Fight Mode"
│   ├─ Pro/Business → "Super Bot Fight Mode"
│   └─ Enterprise → "Bot Management for Enterprise"
├─ Workers API integration → api.md
├─ WAF rules → patterns.md
├─ Debugging → gotchas.md
└─ Analytics → api.md#bot-analytics
```

## Reading Order

| Task | Files to Read |
|------|---------------|
| Enable bot protection | README → configuration.md |
| Workers bot detection | README → api.md |
| WAF rule templates | README → patterns.md |
| Debug bot issues | gotchas.md |
| Advanced analytics | api.md#bot-analytics |

## Core Concepts

**Bot Scores**: 1-99 (1 = definitely automated, 99 = definitely human). Threshold: <30 indicates bot traffic. Enterprise gets granular 1-99; Pro/Business get groupings only.

**Detection Engines**: Heuristics (known fingerprints, assigns score=1), ML (majority of detections, supervised learning on billions of requests), Anomaly Detection (optional, baseline traffic analysis), JavaScript Detections (headless browser detection).

**Verified Bots**: Allowlisted good bots (search engines, AI crawlers) verified via reverse DNS or Web Bot Auth. Access via `cf.bot_management.verified_bot` or `cf.verified_bot_category`.

## Platform Limits

| Plan | Bot Scores | JA3/JA4 | Custom Rules | Analytics Retention |
|------|------------|---------|--------------|---------------------|
| Free | No (auto-block only) | No | 5 | N/A (no analytics) |
| Pro/Business | Groupings only | No | 20/100 | 30 days (72h at a time) |
| Enterprise | 1-99 granular | Yes | 1,000+ | 30 days (1 week at a time) |

## Basic Patterns

```typescript
// Workers: Check bot score
export default {
  async fetch(request: Request): Promise<Response> {
    const botScore = request.cf?.botManagement?.score;
    if (botScore && botScore < 30 && !request.cf?.botManagement?.verifiedBot) {
      return new Response('Bot detected', { status: 403 });
    }
    return fetch(request);
  }
};
```

```txt
# WAF: Block definite bots
(cf.bot_management.score eq 1 and not cf.bot_management.verified_bot)

# WAF: Protect sensitive endpoints
(cf.bot_management.score lt 50 and http.request.uri.path in {"/login" "/checkout"} and not cf.bot_management.verified_bot)
```

## In This Reference

- [configuration.md](./configuration.md) - Product tiers, WAF rule setup, JavaScript Detections, ML auto-updates
- [api.md](./api.md) - Workers BotManagement interface, WAF fields, JA4 Signals
- [patterns.md](./patterns.md) - E-commerce, API protection, mobile app allowlisting, SEO-friendly handling
- [gotchas.md](./gotchas.md) - False positives/negatives, score=0 issues, JSD limitations, CSP requirements

## See Also

- [waf](../waf/) - WAF custom rules for bot enforcement
- [workers](https://developers.cloudflare.com/workers/) - Workers request.cf.botManagement API
- [api-shield](../api-shield/) - API-specific bot protection
