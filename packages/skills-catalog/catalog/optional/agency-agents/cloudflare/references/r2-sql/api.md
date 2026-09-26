# R2 SQL API Reference

Read-only SQL over Iceberg (Apache DataFusion). Query templates only. For the authoritative list of supported syntax, functions, data types, and limitations, pull the SQL reference (`sql-reference/`, `.../aggregate-functions/`, `.../scalar-functions/`, `.../complex-types/`) and `reference/limitations-best-practices/`.

## Query Endpoint

```
POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/r2-sql/query/{BUCKET}
Authorization: Bearer <token>
Content-Type: application/json
Body: {"query": "<SQL>"}
```

CLI: `npx wrangler r2 sql query "{WAREHOUSE}" "<SQL>"` (with `WRANGLER_R2_SQL_AUTH_TOKEN`).

## Response Format

```json
{
  "result": {
    "request_id": "dqe-prod-01...",
    "schema": [{"name": "cnt", "descriptor": {"type": {"name": "int64"}, "nullable": false}}],
    "rows": [{"category": "Electronics", "cnt": 12345}],
    "metrics": {"r2_requests_count": 5, "files_scanned": 29, "bytes_scanned": 12345678, "cache_hits": 0}
  },
  "success": true, "errors": []
}
```

Error: `{"result": null, "success": false, "errors": [{"code": 40003, "message": "..."}]}`. `bytes_scanned` ≈ billable data.

## Query Structure

```sql
SELECT [DISTINCT] columns | expressions | aggregations
FROM namespace.table [alias]
[ [INNER|LEFT|RIGHT|FULL OUTER|CROSS] JOIN namespace.table2 alias2 ON ... ]
[WHERE ...] [GROUP BY ...] [HAVING ...]
[QUALIFY window_predicate]
[ORDER BY expr [ASC|DESC]]
[LIMIT n]                          -- default 500, max 10,000
```

## Schema Discovery

```sql
SHOW DATABASES;            -- list namespaces (aliases: SHOW NAMESPACES / SHOW SCHEMAS)
SHOW TABLES IN namespace;
DESCRIBE namespace.table;  -- columns, types, partition keys
EXPLAIN [FORMAT JSON] SELECT ...;   -- execution plan (free; no data scanned)
```

## JOINs / Subqueries / CTEs / Set Ops

```sql
-- JOINs: all types + multi-way
SELECT z.domain, COUNT(*) AS cnt
FROM ns.zones z
INNER JOIN ns.http_requests h ON z.zone_id = h.zone_id
LEFT  JOIN ns.firewall_events f ON z.zone_id = f.zone_id
GROUP BY z.domain ORDER BY cnt DESC LIMIT 20;

-- Subqueries: IN / EXISTS / scalar / derived
SELECT * FROM ns.t1 WHERE id IN (SELECT id FROM ns.t2 WHERE x > 0);
SELECT col, (SELECT COUNT(*) FROM ns.t2 s WHERE s.id = t.id) AS cnt FROM ns.t1 t;

-- Multi-table CTE with JOIN
WITH top AS (SELECT zone_id, COUNT(*) AS req FROM ns.http_requests GROUP BY zone_id ORDER BY req DESC LIMIT 50)
SELECT t.zone_id, t.req FROM top t LEFT JOIN ns.zones z ON t.zone_id = z.zone_id;

-- Set ops: UNION / UNION ALL / INTERSECT / EXCEPT
SELECT zone_id FROM ns.firewall_events WHERE action = 'block'
UNION SELECT zone_id FROM ns.http_requests WHERE risk_score > 0.8;
```

## Window Functions

Use inline `OVER (...)`. See the SQL reference for the full list of supported window functions and frame syntax.

```sql
SELECT event_id,
       ROW_NUMBER() OVER (PARTITION BY mag_type ORDER BY magnitude DESC) AS rn,
       LAG(magnitude, 2, 0.0) OVER (ORDER BY occurred_at) AS prev2,   -- offset + default
       NTH_VALUE(magnitude, 2) OVER (ORDER BY magnitude DESC) AS n2,
       SUM(magnitude) OVER (ORDER BY occurred_at) AS running,
       AVG(magnitude) OVER (ORDER BY magnitude ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg
FROM ns.earthquakes;

-- QUALIFY: filter on a window result (top row per partition)
SELECT event_id, mag_type, magnitude FROM ns.earthquakes
QUALIFY ROW_NUMBER() OVER (PARTITION BY mag_type ORDER BY magnitude DESC) = 1;
```

## Functions

Aggregate, scalar, JSON, and array/map function catalogs are in the docs — pull `sql-reference/aggregate-functions/` and `.../scalar-functions/`. JSON functions accept variadic paths, e.g. `json_get_int(doc, 'user', 'profile', 'level')`.

## Data Types

`integer`, `float`, `string` (single quotes), `boolean`, `timestamp` (RFC3339 **with timezone**), `date` (ISO 8601), `struct`, `array` (1-indexed), `map`. No implicit conversions — quote strings, include timezone on timestamps, don't quote integers. Full type docs: `sql-reference/`.

```sql
WHERE status = 200 AND method = 'GET'              -- not '200', not GET
  AND ts >= '2026-01-01T00:00:00Z'                 -- not '2026-01-01'
```

## Complex Types (quick examples; full ref in docs)

```sql
SELECT pricing['price'] AS price, get_field(pricing, 'discount') AS disc FROM ns.t;  -- struct
SELECT tags[1] AS first_tag, array_length(tags) AS n FROM ns.t;                       -- array (1-indexed)
SELECT map_keys(meta), map_extract(meta, 'source') FROM ns.t;                         -- map
```

## Errors

Failed queries return `{"success": false, "errors": [{"code": ..., "message": ...}]}`. For error codes and troubleshooting, see `https://developers.cloudflare.com/r2-sql/troubleshooting/`.

## See Also

- [patterns.md](patterns.md) — query examples · [gotchas.md](gotchas.md) — limits & workarounds · [configuration.md](configuration.md)
