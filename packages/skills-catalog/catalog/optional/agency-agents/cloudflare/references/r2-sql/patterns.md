# R2 SQL Patterns

Code templates for CLI, REST, and Worker access. For performance/partitioning best practices, pull `https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/`.

## Wrangler CLI

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=$API_TOKEN

npx wrangler r2 sql query "${ACCOUNT_ID}_my-bucket" "
  SELECT category, COUNT(*) AS cnt, round(AVG(amount), 2) AS avg_amount
  FROM analytics.events
  WHERE __ingest_ts >= '2026-01-01T00:00:00Z'
  GROUP BY category ORDER BY cnt DESC LIMIT 100"
```

## REST API (Python)

```python
import requests

API = f"https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/r2-sql/query/{BUCKET}"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def r2sql(query):
    body = requests.post(API, headers=HEADERS, json={"query": query}, timeout=180).json()
    if body["success"]:
        return body["result"]["rows"], body["result"]["metrics"]
    raise RuntimeError(body["errors"])

rows, metrics = r2sql("SELECT category, COUNT(*) AS cnt FROM analytics.events GROUP BY category LIMIT 10")
```

## REST API (curl)

```bash
curl -X POST \
  "https://api.sql.cloudflarestorage.com/api/v1/accounts/$ACCOUNT_ID/r2-sql/query/$BUCKET" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "SELECT COUNT(*) AS total FROM analytics.events"}'
```

## Dashboard Worker

No R2 SQL binding exists — query the REST endpoint via `fetch()`.

```typescript
interface Env { ACCOUNT_ID: string; BUCKET: string; R2_SQL_TOKEN: string; }

async function queryR2SQL(env: Env, query: string) {
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.ACCOUNT_ID}/r2-sql/query/${env.BUCKET}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.R2_SQL_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`R2 SQL ${resp.status}: ${await resp.text()}`);
  return (await resp.json() as any).result;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === "/api/analytics") {
      const result = await queryR2SQL(env, `
        SELECT category, COUNT(*) AS cnt FROM analytics.events
        GROUP BY category ORDER BY cnt DESC LIMIT 10`);
      return Response.json(result.rows);
    }
    return new Response("Not found", { status: 404 });
  },
};
```

```bash
npx wrangler secret put R2_SQL_TOKEN
```

## Example Queries

```sql
-- Error rate by endpoint
SELECT path, COUNT(*) AS total, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
FROM logs.http_requests WHERE __ingest_ts >= '2026-01-01T00:00:00Z'
GROUP BY path ORDER BY errors DESC LIMIT 20;

-- Top-3 slowest requests per method (window + QUALIFY)
SELECT method, path, response_time_ms FROM logs.http_requests
QUALIFY ROW_NUMBER() OVER (PARTITION BY method ORDER BY response_time_ms DESC) <= 3;

-- Cross-table analytics with approx distinct
SELECT z.domain, COUNT(*) AS requests, approx_distinct(h.client_ip) AS uniques
FROM ns.zones z INNER JOIN ns.http_requests h ON z.zone_id = h.zone_id
WHERE h.__ingest_ts >= '2026-06-01T00:00:00Z'
GROUP BY z.domain ORDER BY requests DESC LIMIT 25;
```

## Cursor-Based Pagination

Paginate on a sortable (ideally partition) column rather than `OFFSET`:

```sql
SELECT * FROM logs.requests ORDER BY __ingest_ts DESC LIMIT 500;                       -- page 1
SELECT * FROM logs.requests WHERE __ingest_ts < '<last_ts>' ORDER BY __ingest_ts DESC LIMIT 500;  -- page 2
```

## Performance (essentials)

- **Always `LIMIT`** (early termination); **filter on partition keys first** (`__ingest_ts` range), then add predicates.
- **Narrow time ranges**; **compact tables** (file count dominates latency — enable automatic compaction in [r2-data-catalog](../r2-data-catalog/configuration.md)).
- Read response `metrics` (`files_scanned`, `bytes_scanned`) to tune. Full guidance: limitations-best-practices doc.

## Pipelines → R2 SQL

After `npx wrangler pipelines setup` (Data Catalog destination), wait for first flush (3–7 min), then query the table. See [pipelines/patterns.md](../pipelines/patterns.md).

## See Also

- [api.md](api.md) · [gotchas.md](gotchas.md) · [r2-data-catalog/patterns.md](../r2-data-catalog/patterns.md)
