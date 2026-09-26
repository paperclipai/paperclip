# D1 Gotchas & Troubleshooting

Use current documentation to diagnose the failure before changing query or database configuration.

| Symptom or question | What to check |
| --- | --- |
| Missing table, query exception, or constraint error | [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/); verify the target binding, environment, and applied [migrations](https://developers.cloudflare.com/d1/reference/migrations/) |
| Boolean, date, or other binding type mismatch | [Workers Binding API type conversion](https://developers.cloudflare.com/d1/worker-api/) and [SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/) |
| Foreign key failure during writes or migrations | [Foreign key enforcement and deferral](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) |
| Slow queries, scans, or excessive rows read | [Indexes and query plans](https://developers.cloudflare.com/d1/best-practices/use-indexes/) and [metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/) |
| Query duration, statement, storage, or account limits | [Current limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Unexpected usage charges or plan assumptions | [Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| Stale reads after a write | [Sessions, bookmarks, and read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) |
| Transient query failures | [Retry guidance](https://developers.cloudflare.com/d1/best-practices/retry-queries/); check idempotency before retrying writes |
| Import/export failure or unsupported data | [Import/export behavior and limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/) |
| Local and deployed databases differ | [Local development](https://developers.cloudflare.com/d1/best-practices/local-development/) and [environment configuration](https://developers.cloudflare.com/d1/configuration/environments/) |

Continue to bind untrusted SQL values as described in [api.md](./api.md). Do not treat SQL injection as a recoverable database error or assume retries correct invalid queries.
