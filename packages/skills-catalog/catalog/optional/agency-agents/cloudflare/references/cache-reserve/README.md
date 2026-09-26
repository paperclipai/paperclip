# Cloudflare Cache Reserve

**Persistent cache storage built on R2 for long-term content retention**

## Smart Shield Integration

Cache Reserve is part of **Smart Shield**, Cloudflare's comprehensive security and performance suite:

- **Smart Shield Advanced tier**: Includes 2TB Cache Reserve storage
- **Standalone purchase**: Available separately if not using Smart Shield
- **Migration**: Existing standalone customers can migrate to Smart Shield bundles

**Decision**: Already on Smart Shield Advanced? Cache Reserve is included. Otherwise evaluate standalone purchase vs Smart Shield upgrade.

## Overview

Cache Reserve is Cloudflare's persistent, large-scale cache storage layer built on R2. It acts as the ultimate upper-tier cache, storing cacheable content for extended periods (30+ days) to maximize cache hits, reduce origin egress fees, and shield origins from repeated requests for long-tail content.

## Core Concepts

### What is Cache Reserve?

- **Persistent storage layer**: Built on R2, sits above tiered cache hierarchy
- **Long-term retention**: 30-day default retention, extended on each access
- **Automatic operation**: Works seamlessly with existing CDN, no code changes required
- **Origin shielding**: Dramatically reduces origin egress by serving cached content longer
- **Usage-based pricing**: Pay only for storage + read/write operations

### Cache Hierarchy

```
Visitor Request
    ↓
Lower-Tier Cache (closest to visitor)
    ↓ (on miss)
Upper-Tier Cache (closest to origin)
    ↓ (on miss)
Cache Reserve (R2 persistent storage)
    ↓ (on miss)
Origin Server
```

### How It Works

1. **On cache miss**: Content fetched from origin �� written to Cache Reserve + edge caches simultaneously
2. **On edge eviction**: Content may be evicted from edge cache but remains in Cache Reserve
3. **On subsequent request**: If edge cache misses but Cache Reserve hits → content restored to edge caches
4. **Retention**: Assets remain in Cache Reserve for 30 days since last access (configurable via TTL)

## When to Use Cache Reserve

```
Need persistent caching?
├─ High origin egress costs → Cache Reserve ✓
├─ Long-tail content (archives, media libraries) → Cache Reserve ✓
├─ Already using Smart Shield Advanced → Included! ✓
├─ Video streaming with seeking (range requests) → ✗ Not supported
├─ Dynamic/personalized content → ✗ Use edge cache only
├─ Need per-request cache control from Workers → ✗ Use R2 directly
└─ Frequently updated content (< 10hr lifetime) → ✗ Not eligible
```

## Asset Eligibility

Cache Reserve only stores assets meeting **ALL** criteria:

- Cacheable per Cloudflare's standard rules
- Minimum 10-hour TTL (36000 seconds)
- `Content-Length` header present
- Original files only (not transformed images)

### Eligibility Checklist

Use this checklist to verify if an asset is eligible:

- [ ] Zone has Cache Reserve enabled
- [ ] Zone has Tiered Cache enabled (required)
- [ ] Asset TTL ≥ 10 hours (36,000 seconds)
- [ ] `Content-Length` header present on origin response
- [ ] No `Set-Cookie` header (or uses private directive)
- [ ] `Vary` header is NOT `*` (can be `Accept-Encoding`)
- [ ] Not an image transformation variant (original images OK)
- [ ] Not a range request (no HTTP 206 support)
- [ ] Not O2O (Orange-to-Orange) proxied request

**All boxes must be checked for Cache Reserve eligibility.**

### Not Eligible

- Assets with TTL < 10 hours
- Responses without `Content-Length` header
- Image transformation variants (original images are eligible)
- Responses with `Set-Cookie` headers
- Responses with `Vary: *` header
- Assets from R2 public buckets on same zone
- O2O (Orange-to-Orange) setup requests
- **Range requests** (video seeking, partial content downloads)

## Quick Start

```bash
# Enable via Dashboard
https://dash.cloudflare.com/caching/cache-reserve
# Click "Enable Storage Sync" or "Purchase" button
```

**Prerequisites:**
- Paid Cache Reserve plan or Smart Shield Advanced required
- Tiered Cache required for optimal performance

## Essential Commands

```bash
# Check Cache Reserve status
curl -X GET "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/cache_reserve" \
  -H "Authorization: Bearer $API_TOKEN"

# Enable Cache Reserve
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/cache_reserve" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value": "on"}'

# Check asset cache status
curl -I https://example.com/asset.jpg | grep -i cache
```

## In This Reference

| Task | Files |
|------|-------|
| Evaluate if Cache Reserve fits your use case | README.md (this file) |
| Enable Cache Reserve for your zone | README.md + [configuration.md](./configuration.md) |
| Use with Workers (understand limitations) | [api.md](./api.md) |
| Setup via SDKs or IaC (TypeScript, Python, Terraform) | [configuration.md](./configuration.md) |
| Optimize costs and debug issues | [patterns.md](./patterns.md) + [gotchas.md](./gotchas.md) |
| Understand eligibility and troubleshoot | [gotchas.md](./gotchas.md) → [patterns.md](./patterns.md) |

**Files:**
- [configuration.md](./configuration.md) - Setup, API, SDKs, and Cache Rules
- [api.md](./api.md) - Purging, monitoring, Workers integration
- [patterns.md](./patterns.md) - Best practices, cost optimization, debugging
- [gotchas.md](./gotchas.md) - Common issues, limitations, troubleshooting

## See Also
- [r2](../r2/) - Cache Reserve built on R2 storage
- [workers](https://developers.cloudflare.com/workers/) - Workers integration with Cache API
