# DO Storage Troubleshooting

Identify the backend and failing operation before applying concurrency or recovery guidance.

Fetch the relevant current documentation before implementing or reviewing changes.

| Task | Documentation |
|------|---------------|
| Input/output gates, write coalescing, external I/O races, or storage options | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/); [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); [Legacy KV storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/) |
| SQL transactions, synchronous callbacks, parameter types, or numeric precision | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Alarm cancellation and storage deletion | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/); [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Slow queries, indexing, caching, or initialization | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/); [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/) |
| Storage limits or CPU exhaustion | [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |
| Storage charges and operation accounting | [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Overload, storage timeouts, or object resets | [Troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/); [Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/) |
