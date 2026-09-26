# Analytics Engine Configuration

## Setup

1. Add binding to `wrangler.jsonc`
2. Deploy Worker
3. Dataset created automatically on first write
4. Query via SQL API

## wrangler.jsonc

```jsonc
{
  "name": "my-worker",
  "analytics_engine_datasets": [
    { "binding": "ANALYTICS", "dataset": "my_events" }
  ]
}
```

Multiple datasets for separate concerns:
```jsonc
{
  "analytics_engine_datasets": [
    { "binding": "API_ANALYTICS", "dataset": "api_requests" },
    { "binding": "USER_EVENTS", "dataset": "user_activity" }
  ]
}
```

## TypeScript

```typescript
interface Env {
  ANALYTICS: AnalyticsEngineDataset;
}

export default {
  async fetch(request: Request, env: Env) {
    // No await - returns void, fire-and-forget
    env.ANALYTICS.writeDataPoint({
      blobs: [pathname, method, status],      // String dimensions (max 20)
      doubles: [latency, 1],                   // Numeric metrics (max 20)
      indexes: [apiKey]                        // High-cardinality filter (max 1)
    });
    return response;
  }
};
```

## Data Point Limits

| Field | Limit | SQL Access |
|-------|-------|------------|
| blobs | 20 strings, 16KB each | `blob1`...`blob20` |
| doubles | 20 numbers | `double1`...`double20` |
| indexes | 1 string, 16KB | `index1` |

## Write Behavior

| Scenario | Behavior |
|----------|----------|
| <1M writes/min | All accepted |
| >1M writes/min | Automatic sampling |
| Invalid data | Silent failure (check tail logs) |

**Mitigate sampling:** Pre-aggregate, use multiple datasets, write only critical metrics.

## Query Limits

| Resource | Limit |
|----------|-------|
| Query timeout | 30 seconds |
| Data retention | 90 days (default) |
| Result size | ~10MB |

## Cost

**Free tier:** 10M writes/month, 1M reads/month

**Paid:** $0.05 per 1M writes, $1.00 per 1M reads

## Environment-Specific

```jsonc
{
  "analytics_engine_datasets": [
    { "binding": "ANALYTICS", "dataset": "prod_events" }
  ],
  "env": {
    "staging": {
      "analytics_engine_datasets": [
        { "binding": "ANALYTICS", "dataset": "staging_events" }
      ]
    }
  }
}
```

## Monitoring

```bash
npx wrangler tail  # Check for sampling/write errors
```

```sql
-- Check write activity
SELECT DATE_TRUNC('hour', timestamp) AS hour, COUNT(*) AS writes
FROM my_dataset
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY hour
```
