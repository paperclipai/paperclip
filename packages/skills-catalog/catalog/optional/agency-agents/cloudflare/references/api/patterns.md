# Common Patterns

## List All with Auto-Pagination

**Problem:** API returns paginated results. Default page size is 20.

**Solution:** Use SDK auto-pagination to iterate all results.

```typescript
// TypeScript
for await (const zone of client.zones.list()) {
  console.log(zone.name);
}
```

```python
# Python
for zone in client.zones.list():
    print(zone.name)
```

```go
// Go
iter := client.Zones.ListAutoPaging(ctx, cloudflare.ZoneListParams{})
for iter.Next() {
    fmt.Println(iter.Current().Name)
}
```

## Error Handling with Retry

**Problem:** Rate limits (429) and transient errors need retry.

**Solution:** SDKs auto-retry with exponential backoff. Customize as needed.

```typescript
// Increase retries for rate-limit-heavy operations
const client = new Cloudflare({ maxRetries: 5 });

try {
  const zone = await client.zones.create({ /* ... */ });
} catch (err) {
  if (err instanceof Cloudflare.RateLimitError) {
    // Already retried 5 times with backoff
    const retryAfter = err.headers['retry-after'];
    console.log(`Rate limited. Retry after ${retryAfter}s`);
  }
}
```

## Batch Parallel Operations

**Problem:** Need to create multiple resources quickly.

**Solution:** Use `Promise.all()` for parallel requests (respect rate limits).

```typescript
// Create multiple DNS records in parallel
const records = ['www', 'api', 'cdn'].map(subdomain =>
  client.dns.records.create({
    zone_id: 'zone-id',
    type: 'A',
    name: `${subdomain}.example.com`,
    content: '192.0.2.1',
  })
);
await Promise.all(records);
```

**Controlled concurrency** (avoid rate limits):

```typescript
import pLimit from 'p-limit';
const limit = pLimit(10); // Max 10 concurrent

const subdomains = ['www', 'api', 'cdn', /* many more */];
const records = subdomains.map(subdomain =>
  limit(() => client.dns.records.create({
    zone_id: 'zone-id',
    type: 'A',
    name: `${subdomain}.example.com`,
    content: '192.0.2.1',
  }))
);
await Promise.all(records);
```

## Zone CRUD Workflow

```typescript
// Create
const zone = await client.zones.create({
  account: { id: 'account-id' },
  name: 'example.com',
  type: 'full',
});

// Read
const fetched = await client.zones.get({ zone_id: zone.id });

// Update
await client.zones.edit(zone.id, { paused: false });

// Delete
await client.zones.delete(zone.id);
```

## DNS Bulk Update

```typescript
// Fetch all A records
const records = [];
for await (const record of client.dns.records.list({
  zone_id: 'zone-id',
  type: 'A',
})) {
  records.push(record);
}

// Update all to new IP
await Promise.all(records.map(record =>
  client.dns.records.update({
    zone_id: 'zone-id',
    dns_record_id: record.id,
    type: 'A',
    name: record.name,
    content: '203.0.113.1', // New IP
    proxied: record.proxied,
    ttl: record.ttl,
  })
));
```

## Filter and Collect Results

```typescript
// Find all proxied A records
const proxiedRecords = [];
for await (const record of client.dns.records.list({
  zone_id: 'zone-id',
  type: 'A',
})) {
  if (record.proxied) {
    proxiedRecords.push(record);
  }
}
```

## Error Recovery Pattern

```typescript
async function createZoneWithRetry(name: string, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.zones.create({
        account: { id: 'account-id' },
        name,
        type: 'full',
      });
    } catch (err) {
      if (err instanceof Cloudflare.RateLimitError && attempt < maxAttempts) {
        const retryAfter = parseInt(err.headers['retry-after'] || '5');
        console.log(`Rate limited, waiting ${retryAfter}s (retry ${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      } else {
        throw err;
      }
    }
  }
}
```

## Conditional Update Pattern

```typescript
// Only update if zone is active
const zone = await client.zones.get({ zone_id: 'zone-id' });
if (zone.status === 'active') {
  await client.zones.edit(zone.id, { paused: false });
}
```

## Batch with Error Handling

```typescript
// Process multiple zones, continue on errors
const results = await Promise.allSettled(
  zoneIds.map(id => client.zones.get({ zone_id: id }))
);

results.forEach((result, i) => {
  if (result.status === 'fulfilled') {
    console.log(`Zone ${i}: ${result.value.name}`);
  } else {
    console.error(`Zone ${i} failed:`, result.reason.message);
  }
});
```

## See Also

- [api.md](./api.md) - SDK client initialization, basic operations
- [gotchas.md](./gotchas.md) - Rate limits, common errors
- [configuration.md](./configuration.md) - SDK configuration options
