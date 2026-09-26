# DO Storage Patterns

Persist essential state and treat memory as a reconstructible cache. Coordinate related updates within the storage and concurrency guarantees of the selected backend.

Fetch the relevant current documentation before implementing or reviewing changes.

| Task | Documentation |
|------|---------------|
| Schema initialization, migrations, indexes, caching, or parent-child coordination | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| Counters, transactions, and atomic updates | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); [Legacy KV storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/); [Counter example](https://developers.cloudflare.com/durable-objects/examples/build-a-counter/) |
| Batch processing or multiple scheduled events | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/); [Batching example](https://developers.cloudflare.com/durable-objects/examples/alarms-api/) |
| Cleanup and expiration | [Time to Live example](https://developers.cloudflare.com/durable-objects/examples/durable-object-ttl/); [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Design application-specific rate limiting | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/); [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |

Verify persistence, isolation, and rollback behavior with the [testing guidance](testing.md).
