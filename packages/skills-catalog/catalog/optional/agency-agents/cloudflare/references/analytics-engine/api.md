# Analytics Engine API Reference

## Writing Data

### `writeDataPoint()`

Fire-and-forget (returns `void`, not Promise). Writes happen asynchronously.

```typescript
interface AnalyticsEngineDataPoint {
  blobs?: string[];      // Up to 20 strings (dimensions), 16KB each
  doubles?: number[];    // Up to 20 numbers (metrics)
  indexes?: string[];    // 1 indexed string for high-cardinality filtering
}

env.ANALYTICS.writeDataPoint({
  blobs: ["/api/users", "GET", "200"],
  doubles: [145.2, 1],  // latency_ms, count
  indexes: ["customer_abc123"]
});
```

**Behaviors:** No await needed, no error thrown (check tail logs), auto-sampled at high volumes, auto-timestamped.

**Blob vs Index:** Blob for GROUP BY (<100k unique), Index for filter-only (millions unique).

### Full Example

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const start = Date.now();
    const url = new URL(request.url);
    try {
      const response = await handleRequest(request);
      env.ANALYTICS.writeDataPoint({
        blobs: [url.pathname, request.method, response.status.toString()],
        doubles: [Date.now() - start, 1],
        indexes: [request.headers.get("x-api-key") || "anonymous"]
      });
      return response;
    } catch (error) {
      env.ANALYTICS.writeDataPoint({
        blobs: [url.pathname, request.method, "500"],
        doubles: [Date.now() - start, 1, 0],
      });
      throw error;
    }
  }
};
```

## SQL API (External Only)

```bash
curl -X POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql \
  -H "Authorization: Bearer $TOKEN" \
  -d "SELECT blob1 AS endpoint, COUNT(*) AS requests FROM dataset WHERE timestamp >= NOW() - INTERVAL '1' HOUR GROUP BY blob1"
```

### Column References

```sql
-- blob1..blob20, double1..double20, index1, timestamp
SELECT blob1 AS endpoint, SUM(double1) AS latency, COUNT(*) AS requests
FROM my_dataset
WHERE index1 = 'customer_123' AND timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY blob1
HAVING COUNT(*) > 100
ORDER BY requests DESC LIMIT 100
```

**Aggregations:** `SUM()`, `AVG()`, `COUNT()`, `MIN()`, `MAX()`, `quantile(0.95)()`

**Time ranges:** `NOW() - INTERVAL '1' HOUR`, `BETWEEN '2026-01-01' AND '2026-01-31'`

### Query Examples

```sql
-- Top endpoints
SELECT blob1, COUNT(*) AS requests, AVG(double1) AS avg_latency
FROM api_requests WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY blob1 ORDER BY requests DESC LIMIT 20

-- Error rate
SELECT blob1, COUNT(*) AS total,
  SUM(if(blob3 LIKE '5%', 1, 0)) AS errors
FROM api_requests WHERE timestamp >= NOW() - INTERVAL '1' HOUR
GROUP BY blob1 HAVING total > 50

-- P95 latency
SELECT blob1, quantile(0.95)(double1) AS p95
FROM api_requests GROUP BY blob1
```

## Response Format

```json
{"data": [{"endpoint": "/api/users", "requests": 1523}], "rows": 2}
```

## Limits

| Resource | Limit |
|----------|-------|
| Blobs/Doubles per point | 20 each |
| Indexes per point | 1 |
| Blob/Index size | 16KB |
| Data retention | 90 days |
| Query timeout | 30s |

**Critical:** High write volumes (>1M/min) trigger automatic sampling.
