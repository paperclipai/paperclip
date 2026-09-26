# Analytics Engine Patterns

## Use Cases

| Use Case | Key Metrics | Index On |
|----------|-------------|----------|
| API Metering | requests, bytes, compute_units | api_key |
| Feature Usage | feature, action, duration | user_id |
| Error Tracking | error_type, endpoint, count | customer_id |
| Performance | latency_ms, cache_status | endpoint |
| A/B Testing | variant, conversions | user_id |

## API Metering (Billing)

```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [pathname, method, status, tier],
  doubles: [1, computeUnits, bytes, latencyMs],
  indexes: [apiKey]
});

// Query: Monthly usage by customer
// SELECT index1 AS api_key, SUM(double2) AS compute_units
// FROM usage WHERE timestamp >= DATE_TRUNC('month', NOW()) GROUP BY index1
```

## Error Tracking

```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [endpoint, method, errorName, errorMessage.slice(0, 1000)],
  doubles: [1, timeToErrorMs],
  indexes: [customerId]
});
```

## Performance Monitoring

```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [pathname, method, cacheStatus, status],
  doubles: [latencyMs, 1],
  indexes: [userId]
});

// Query: P95 latency by endpoint
// SELECT blob1, quantile(0.95)(double1) AS p95_ms FROM perf GROUP BY blob1
```

## Anti-Patterns

| ❌ Wrong | ✅ Correct |
|----------|-----------|
| `await writeDataPoint()` | `writeDataPoint()` (fire-and-forget) |
| `indexes: [method]` (low cardinality) | `blobs: [method]`, `indexes: [userId]` |
| `blobs: [JSON.stringify(obj)]` | Store ID in blob, full object in D1/KV |
| Write every request at 10M/min | Pre-aggregate per second |
| Query from Worker | Query from external service/API |

## Best Practices

1. **Design schema upfront** - Document blob/double/index assignments
2. **Always include count metric** - `doubles: [latency, 1]` for AVG calculations
3. **Use enums for blobs** - Consistent values like `Status.SUCCESS`
4. **Handle sampling** - Use ratios (avg_latency = SUM(latency)/SUM(count))
5. **Test queries early** - Validate schema before heavy writes

## Schema Template

```typescript
/**
 * Dataset: my_metrics
 * 
 * Blobs:
 *   blob1: endpoint, blob2: method, blob3: status
 * 
 * Doubles:
 *   double1: latency_ms, double2: count (always 1)
 * 
 * Indexes:
 *   index1: customer_id (high cardinality)
 */
```
