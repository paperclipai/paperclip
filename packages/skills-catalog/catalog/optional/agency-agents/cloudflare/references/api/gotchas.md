# Gotchas & Troubleshooting

## Rate Limits & 429 Errors

**Actual Limits:**
- **1200 requests / 5 minutes** per user/token (global)
- **200 requests / second** per IP address
- **GraphQL: 320 / 5 minutes** (cost-based)

**SDK Behavior:**
- Auto-retry with exponential backoff (default 2 retries, Go: 10)
- Respects `Retry-After` header
- Throws `RateLimitError` after exhausting retries

**Solution:**

```typescript
// Increase retries for rate-limit-heavy workflows
const client = new Cloudflare({ maxRetries: 5 });

// Add application-level throttling
import pLimit from 'p-limit';
const limit = pLimit(10); // Max 10 concurrent requests
```

## SDK-Specific Issues

### Go: Required Field Wrapper

**Problem:** Go SDK requires `cloudflare.F()` wrapper for optional fields.

```go
// ❌ WRONG - Won't compile or send field
client.Zones.New(ctx, cloudflare.ZoneNewParams{
    Name: "example.com",
})

// ✅ CORRECT
client.Zones.New(ctx, cloudflare.ZoneNewParams{
    Name: cloudflare.F("example.com"),
    Account: cloudflare.F(cloudflare.ZoneNewParamsAccount{
        ID: cloudflare.F("account-id"),
    }),
})
```

**Why:** Distinguishes between zero value, null, and omitted fields.

### Python: Async vs Sync Clients

**Problem:** Using sync client in async context or vice versa.

```python
# ❌ WRONG - Can't await sync client
from cloudflare import Cloudflare
client = Cloudflare()
await client.zones.list()  # TypeError

# ✅ CORRECT - Use AsyncCloudflare
from cloudflare import AsyncCloudflare
client = AsyncCloudflare()
await client.zones.list()
```

## Token Permission Errors (403)

**Problem:** API returns 403 Forbidden despite valid token.

**Cause:** Token lacks required permissions (scope).

**Scopes Required:**

| Operation | Required Scope |
|-----------|----------------|
| List zones | Zone:Read (zone-level or account-level) |
| Create zone | Zone:Edit (account-level) |
| Edit DNS | DNS:Edit (zone-level) |
| Deploy Worker | Workers Script:Edit (account-level) |
| Read KV | Workers KV Storage:Read |
| Write KV | Workers KV Storage:Edit |

**Solution:** Re-create token with correct permissions in Dashboard → My Profile → API Tokens.

## Pagination Truncation

**Problem:** Only getting first 20 results (default page size).

**Solution:** Use auto-pagination iterators.

```typescript
// ❌ WRONG - Only first page (20 items)
const page = await client.zones.list();

// ✅ CORRECT - All results
const zones = [];
for await (const zone of client.zones.list()) {
  zones.push(zone);
}
```

## Workers Subrequests

**Problem:** Rate limit hit faster than expected in Workers.

**Cause:** Workers subrequests count as separate API calls.

**Solution:** Use bindings instead of REST API in Workers (see ../bindings/).

```typescript
// ❌ WRONG - REST API in Workers (counts against rate limit)
const client = new Cloudflare({ apiToken: env.CLOUDFLARE_API_TOKEN });
const zones = await client.zones.list();

// ✅ CORRECT - Use bindings (no rate limit)
// Access via env.MY_BINDING
```

## Authentication Errors (401)

**Problem:** "Authentication failed" or "Invalid token"

**Causes:**
- Token expired
- Token deleted/revoked
- Token not set in environment
- Wrong token format

**Solution:**

```typescript
// Verify token is set
if (!process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN not set');
}

// Test token
const user = await client.user.tokens.verify();
console.log('Token valid:', user.status);
```

## Timeout Errors

**Problem:** Request times out (default 60s).

**Cause:** Large operations (bulk DNS, zone transfers).

**Solution:** Increase timeout or split operations.

```typescript
// Increase timeout
const client = new Cloudflare({
  timeout: 300000, // 5 minutes
});

// Or split operations
const batchSize = 100;
for (let i = 0; i < records.length; i += batchSize) {
  const batch = records.slice(i, i + batchSize);
  await processBatch(batch);
}
```

## Zone Not Found (404)

**Problem:** Zone ID valid but returns 404.

**Causes:**
- Zone not in account associated with token
- Zone deleted
- Wrong zone ID format

**Solution:**

```typescript
// List all zones to find correct ID
for await (const zone of client.zones.list()) {
  console.log(zone.id, zone.name);
}
```

## Limits Reference

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| API rate limit | 1200/5min | Per user/token |
| IP rate limit | 200/sec | Per IP |
| GraphQL rate limit | 320/5min | Cost-based |
| Parallel requests (recommended) | < 10 | Avoid overwhelming API |
| Default page size | 20 | Use auto-pagination |
| Max page size | 50 | Some endpoints |

## Best Practices

**Security:**
- Never commit tokens
- Use minimal permissions
- Rotate tokens regularly
- Set token expiration

**Performance:**
- Batch operations
- Use pagination wisely
- Cache responses
- Handle rate limits

**Code Organization:**

```typescript
// Create reusable client instance
export const cfClient = new Cloudflare({
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  maxRetries: 5,
});

// Wrap common operations
export async function getZoneDetails(zoneId: string) {
  return await cfClient.zones.get({ zone_id: zoneId });
}
```

## See Also

- [api.md](./api.md) - Error types, authentication
- [configuration.md](./configuration.md) - Timeout/retry configuration
- [patterns.md](./patterns.md) - Error handling patterns
