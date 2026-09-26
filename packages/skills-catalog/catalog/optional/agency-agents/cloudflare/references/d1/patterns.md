# D1 Patterns & Best Practices

Use these guides to design the operation, then fetch [api.md](./api.md) for implementation references.

| Task | Current documentation |
| --- | --- |
| Design pagination, filters, joins, and aggregations | [Query a database](https://developers.cloudflare.com/d1/best-practices/query-d1/) and [supported SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/) |
| Reduce scans and inspect query plans | [Use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) |
| Batch writes or transform data | [Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Store and query event metadata | [Query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/) |
| Evaluate a cache in front of D1 | [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| Choose shared or per-tenant databases | [D1 FAQs](https://developers.cloudflare.com/d1/reference/faq/) and [limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Reduce read latency while preserving required consistency | [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) |
| Plan point-in-time recovery or portable backups | [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) and [import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) |

Keep result sets bounded and pagination ordering deterministic. Choose indexes from actual query plans. When splitting a large operation into batches, account for the loss of whole-operation atomicity across batches.

Authorize a tenant before selecting its database or rows; a request header alone is not proof of tenant membership. Application login sessions stored in tables are separate from D1's Sessions API.

Before caching reads, decide how stale data may be and how writes invalidate cached results. For replicated reads, choose session constraints and bookmark propagation based on read-after-write requirements rather than assuming every read sees the latest primary state.
