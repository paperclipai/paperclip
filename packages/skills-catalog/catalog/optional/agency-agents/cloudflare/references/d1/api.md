# D1 API Reference

Fetch the relevant API page before writing queries or assuming method signatures and return types.

| Task | Current documentation |
| --- | --- |
| Bind values and choose a query execution method | [Prepared statement methods](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) |
| Execute batches and understand transaction rollback; use database sessions | [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| Interpret results and query metadata | [Return objects](https://developers.cloudflare.com/d1/worker-api/return-object/) |
| Choose supported JavaScript values and TypeScript result types | [Workers Binding API](https://developers.cloudflare.com/d1/worker-api/) |
| Choose consistency constraints and carry bookmarks between requests | [Read replication and Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/) |
| Query from a server-side script outside Workers | [REST query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) |
| Handle query failures and transient errors | [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/) and [retry queries](https://developers.cloudflare.com/d1/best-practices/retry-queries/) |
| Test database queries and apply migrations in tests | [Workers Vitest APIs: D1](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#d1) |

Bind untrusted values with prepared statements; do not interpolate them into SQL. Parameters do not replace identifiers: choose dynamic table, column, or sort names from an application-controlled allowlist.

D1 sessions provide sequential consistency for replicated queries. They are not a way to extend query execution limits. Choose the starting constraint or bookmark from the application's consistency requirements using the replication guide.
