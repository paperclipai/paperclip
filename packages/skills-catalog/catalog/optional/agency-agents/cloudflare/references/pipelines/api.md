# Pipelines API Reference

Code templates and verified behavior. For the full SQL function set and HTTP status semantics, pull `https://developers.cloudflare.com/pipelines/sql-reference/` and the streams docs.

## Worker Binding Interface

```typescript
// from cloudflare:pipelines / @cloudflare/workers-types
interface Pipeline<T = any> { send(records: T[]): Promise<void>; }

interface Env { MY_STREAM: Pipeline; }

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await env.MY_STREAM.send([{ event_id: crypto.randomUUID(), amount: 29.99 }]);
    return new Response("OK");
  }
} satisfies ExportedHandler<Env>;
```

- `send()` takes an **array**, returns `Promise<void>` (no confirmation payload).
- Throws on network errors — wrap in try/catch or use `ctx.waitUntil()` for fire-and-forget.
- Validation errors are **not** thrown here (deferred during processing — see [gotchas.md](gotchas.md)).
- Payload/rate limits apply — check `https://developers.cloudflare.com/pipelines/platform/limits/` before sizing batches.

## HTTP Ingest

```
https://{stream-id}.ingest.cloudflare.com
```

Get `{stream-id}` from `npx wrangler pipelines streams list`.

```bash
# Batch (preferred)
curl -X POST https://{stream-id}.ingest.cloudflare.com \
  -H "Content-Type: application/json" \
  -d '[{"event_id":"evt-1","amount":29.99},{"event_id":"evt-2","amount":14.99}]'

# Single event — auto-wrapped in an array
curl -X POST https://{stream-id}.ingest.cloudflare.com \
  -H "Content-Type: application/json" -d '{"event_id":"evt-3","amount":9.99}'
```

If stream auth is enabled, add `-H "Authorization: Bearer $TOKEN"` (token needs **Workers Pipelines Send**). Standard HTTP status codes apply (400 invalid, 401 auth, 413 too large, 429 rate-limited, 5xx retry).

> **JSON only** — no Avro, Protobuf, or CSV input.

## REST Management API

Base: `https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pipelines/v1`

```bash
# List
curl -s "$BASE_URL/streams"   -H "Authorization: Bearer $API_TOKEN"
curl -s "$BASE_URL/sinks"     -H "Authorization: Bearer $API_TOKEN"
curl -s "$BASE_URL/pipelines" -H "Authorization: Bearer $API_TOKEN"

# Get one (pipeline GET includes status + failure_reason — useful for debugging)
curl -s "$BASE_URL/pipelines/{pipeline-id}" -H "Authorization: Bearer $API_TOKEN"

# Delete in reverse order: pipeline → sink → stream
curl -X DELETE "$BASE_URL/pipelines/{id}" -H "Authorization: Bearer $API_TOKEN"
curl -X DELETE "$BASE_URL/sinks/{id}"     -H "Authorization: Bearer $API_TOKEN"
curl -X DELETE "$BASE_URL/streams/{id}"   -H "Authorization: Bearer $API_TOKEN"
```

> `wrangler pipelines delete` defaults to "no" non-interactively — use the REST API for automated cleanup. Deleting a stream removes buffered events and dependent pipelines.

### Pipeline Lifecycle States

| Status | Meaning |
|--------|---------|
| `running` | Active, processing events |
| `initializing` | Starting up (minutes after creation or recovery) |
| `failed` | Stopped on error — check `failure_reason` (expired token, deleted bucket, disabled catalog) |

> A `GET` on a sink shows `schema.fields: []` — expected. The sink inherits schema from the stream via the pipeline SQL.

## Pipeline SQL (Transforms)

Row-level only — no GROUP BY/aggregation. CTEs (`WITH`) and `UNNEST` are supported. Full function list: `https://developers.cloudflare.com/pipelines/sql-reference/`.

```sql
-- Passthrough / filter / enrich
INSERT INTO my_sink SELECT * FROM my_stream;
INSERT INTO my_sink SELECT * FROM my_stream WHERE amount > 10;
INSERT INTO my_sink
SELECT event_id, UPPER(category) AS category, amount * 1.1 AS amount_with_tax
FROM my_stream;

-- CTE
WITH filtered AS (SELECT event_id, amount FROM my_stream WHERE amount > 50)
INSERT INTO my_sink SELECT * FROM filtered;

-- UNNEST arrays (one per SELECT)
SELECT UNNEST(tags) AS tag FROM my_stream;
```

Supported categories: string, regex, hashing (`sha256`), JSON extraction, timestamp conversion, conditional (`CASE`), `CAST`, `COALESCE`, math/comparison operators.

## Verifying End-to-End Data Flow

```bash
# 1. Pipeline running (not initializing/failed)?
curl -s "$BASE_URL/pipelines/{id}" -H "Authorization: Bearer $API_TOKEN"

# 2. Table created yet? (3–7 min on first flush)
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2-catalog/$BUCKET/namespaces/my_ns/tables" \
  -H "Authorization: Bearer $API_TOKEN"

# 3. Data present? (R2 SQL)
curl -s -X POST \
  "https://api.sql.cloudflarestorage.com/api/v1/accounts/$ACCOUNT_ID/r2-sql/query/$BUCKET" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "SELECT COUNT(*) AS total FROM my_ns.my_table"}'
```

> Expect **3–7 minutes** from first send to first queryable data. Subsequent flushes are much faster.

## See Also

- [configuration.md](configuration.md) — creating resources · [patterns.md](patterns.md) — producers, Logpush, observability
- [r2-sql/api.md](../r2-sql/api.md) — querying results
