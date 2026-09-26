# Hyperdrive design patterns

See [api.md](./api.md) for maintained driver and ORM examples. Use the following decisions to select a pattern, then fetch its linked documentation for implementation.

| Workload or decision | Guidance and documentation |
|----------------------|----------------------------|
| Popular content or analytics dashboards | Cache only when the product can tolerate the configured stale window. Use [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) for eligibility, parameters, and settings. |
| Mixed cached reads and fresh reads | Route authentication, permissions, and reads after writes through a cache-disabled configuration. Writes do not invalidate cached results; see [read-after-write behavior](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#read-after-write-behavior). |
| Multi-tenant queries | Derive tenant scope from authenticated application context and apply it to every query. A cache is not an authorization boundary. Review [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) for the selected query's behavior. |
| Globally distributed callers | Understand the distinction between fast connection setup and the remaining query round trip in [how Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/). |
| Multiple sequential database queries | Measure placement rather than assuming the nearest user location is best. Consult [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/) and [Hyperdrive metrics](https://developers.cloudflare.com/hyperdrive/observability/metrics/). |
| Transactions or connection-local state | Keep transactions short and do not assume state survives across transactions. Fetch [connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/) and [supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) before relying on session settings. |
| Client lifetime and pool sizing | Create clients per handler invocation; Hyperdrive owns the origin pool. Use [connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) and [pool tuning](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/) instead of a global driver pool or copied connection counts. |

Separate application correctness from acceleration: use parameterized queries, enforce tenant access in the application, and select freshness before tuning cache hit rate. See [gotchas.md](./gotchas.md) when observed behavior differs from the design.
