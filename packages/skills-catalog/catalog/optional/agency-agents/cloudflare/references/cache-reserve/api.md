# Cache Reserve API

## Workers Integration

```
┌────────────────────────────────────────────────────────────────┐
│ CRITICAL: Workers Cache API ≠ Cache Reserve                   │
│                                                                │
│ • Workers caches.default / cache.put() → edge cache ONLY      │
│ • Cache Reserve → zone-level setting, automatic, no per-req   │
│ • You CANNOT selectively write to Cache Reserve from Workers  │
│ • Cache Reserve works with standard fetch(), not cache.put()  │
└────────────────────────────────────────────────────────────────┘
```

Cache Reserve is a **zone-level configuration**, not a per-request API. It works automatically when enabled for the zone:

### Standard Fetch (Recommended)

```typescript
// Cache Reserve works automatically via standard fetch
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Standard fetch uses Cache Reserve automatically
    return await fetch(request);
  }
};
```

### Cache API Limitations

**IMPORTANT**: `cache.put()` is **NOT compatible** with Cache Reserve or Tiered Cache.

```typescript
// ❌ WRONG: cache.put() bypasses Cache Reserve
const cache = caches.default;
let response = await cache.match(request);
if (!response) {
  response = await fetch(request);
  await cache.put(request, response.clone()); // Bypasses Cache Reserve!
}

// ✅ CORRECT: Use standard fetch for Cache Reserve compatibility
return await fetch(request);

// ✅ CORRECT: Use Cache API only for custom cache namespaces
const customCache = await caches.open('my-custom-cache');
let response = await customCache.match(request);
if (!response) {
  response = await fetch(request);
  await customCache.put(request, response.clone()); // Custom cache OK
}
```

## Purging and Cache Management

### Purge by URL (Instant)

```typescript
// Purge specific URL from Cache Reserve immediately
const purgeCacheReserveByURL = async (
  zoneId: string,
  apiToken: string,
  urls: string[]
) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: urls })
    }
  );
  return await response.json();
};

// Example usage
await purgeCacheReserveByURL('zone123', 'token456', [
  'https://example.com/image.jpg',
  'https://example.com/video.mp4'
]);
```

### Purge by Tag/Host/Prefix (Revalidation)

```typescript
// Purge by cache tag - forces revalidation, not immediate removal
await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: ['tag1', 'tag2'] })
  }
);
```

**Purge behavior:**
- **By URL**: Immediate removal from Cache Reserve + edge cache
- **By tag/host/prefix**: Revalidation only, assets remain in storage (costs continue)

### Clear All Cache Reserve Data

```typescript
// Requires Cache Reserve OFF first
await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zoneId}/cache/cache_reserve_clear`,
  { method: 'POST', headers: { 'Authorization': `Bearer ${apiToken}` } }
);

// Check status: GET same endpoint returns { state: "In-progress" | "Completed" }
```

**Process**: Disable Cache Reserve → Call clear endpoint → Wait up to 24hr → Re-enable

## Monitoring and Analytics

### Dashboard Analytics

Navigate to **Caching > Cache Reserve** to view:

- **Egress Savings**: Total bytes served from Cache Reserve vs origin egress cost saved
- **Requests Served**: Cache Reserve hits vs misses breakdown
- **Storage Used**: Current GB stored in Cache Reserve (billed monthly)
- **Operations**: Class A (writes) and Class B (reads) operation counts
- **Cost Tracking**: Estimated monthly costs based on current usage

### Logpush Integration

```typescript
// Logpush field: CacheReserveUsed (boolean) - filter for Cache Reserve hits
// Query Cache Reserve hits in analytics
const logpushQuery = `
  SELECT 
    ClientRequestHost, 
    COUNT(*) as requests, 
    SUM(EdgeResponseBytes) as bytes_served,
    COUNT(CASE WHEN CacheReserveUsed = true THEN 1 END) as cache_reserve_hits,
    COUNT(CASE WHEN CacheReserveUsed = false THEN 1 END) as cache_reserve_misses
  FROM http_requests 
  WHERE Timestamp >= NOW() - INTERVAL '24 hours'
  GROUP BY ClientRequestHost 
  ORDER BY requests DESC
`;

// Filter only Cache Reserve hits
const crHitsQuery = `
  SELECT ClientRequestHost, COUNT(*) as requests, SUM(EdgeResponseBytes) as bytes
  FROM http_requests 
  WHERE CacheReserveUsed = true AND Timestamp >= NOW() - INTERVAL '7 days'
  GROUP BY ClientRequestHost 
  ORDER BY bytes DESC
`;
```

### GraphQL Analytics

```graphql
query CacheReserveAnalytics($zoneTag: string, $since: string, $until: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(
        filter: { datetime_geq: $since, datetime_leq: $until }
        limit: 1000
      ) {
        dimensions { date }
        sum {
          cachedBytes
          cachedRequests
          bytes
          requests
        }
      }
    }
  }
}
```

## Pricing

```typescript
// Storage: $0.015/GB-month | Class A (writes): $4.50/M | Class B (reads): $0.36/M
// Cache miss: 1A + 1B | Cache hit: 1B | Assets >1GB: proportionally more ops
```

## See Also

- [README](./README.md) - Overview and core concepts
- [Configuration](./configuration.md) - Setup and Cache Rules
- [Patterns](./patterns.md) - Best practices and optimization
- [Gotchas](./gotchas.md) - Common issues and troubleshooting
