# Analytics Engine Gotchas

## Critical Issues

### Sampling at High Volumes

**Problem:** Queries return fewer points than written at >1M writes/min.

**Solution:**
```typescript
// Pre-aggregate before writing
let buffer = { count: 0, total: 0 };
buffer.count++; buffer.total += value;

// Write once per second instead of per request
if (Date.now() % 1000 === 0) {
  env.ANALYTICS.writeDataPoint({ doubles: [buffer.count, buffer.total] });
}
```

**Detection:** `npx wrangler tail` → look for "sampling enabled"

### writeDataPoint Returns void

```typescript
// ❌ Pointless await
await env.ANALYTICS.writeDataPoint({...});

// ✅ Fire-and-forget
env.ANALYTICS.writeDataPoint({...});
```

Writes can fail silently. Check tail logs.

### Index vs Blob

| Cardinality | Use | Example |
|-------------|-----|---------|
| Millions | **Index** | user_id, api_key |
| Hundreds | **Blob** | endpoint, status_code, country |

```typescript
// ✅ Correct
{ blobs: [method, path, status], indexes: [userId] }
```

### Can't Query from Workers

Query API requires HTTP auth. Use external service or cache in KV/D1.

### No Custom Timestamps

Auto-generated at write time. Store original in blob if needed.

## Common Errors

| Error | Fix |
|-------|-----|
| Binding not found | Check wrangler.jsonc, redeploy |
| No data in query | Wait 30s; check dataset name; check time range |
| Query timeout | Add time filter; use index for filtering |

## Limits

| Resource | Limit |
|----------|-------|
| Blobs per point | 20 |
| Doubles per point | 20 |
| Indexes per point | 1 |
| Blob/Index size | 16KB |
| Write rate (no sampling) | ~1M/min |
| Retention | 90 days |
| Query timeout | 30s |

## Best Practices

✅ Pre-aggregate at high volumes  
✅ Use index for high-cardinality (millions)  
✅ Always include time filter in queries  
✅ Design schema before coding  

❌ Don't await writeDataPoint  
❌ Don't use index for low-cardinality  
❌ Don't query without time range  
❌ Don't assume all writes succeed
