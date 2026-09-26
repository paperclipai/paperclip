# Cloudflare Durable Objects Storage

Use SQLite for new classes. Existing KV-backed classes need their matching API reference; using key-value methods does not by itself identify the backend.

Fetch the relevant current documentation before implementing or reviewing changes.

| Task | Documentation |
|------|---------------|
| Choose SQL, key-value access, transactions, or recovery APIs | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); [Legacy KV storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/) |
| Configure the backend, class lifecycle, and placement | [Configuration](configuration.md) |
| Find operation semantics and storage options | [API routing](api.md) |
| Design schemas, caches, scheduled work, or cleanup | [Patterns](patterns.md) |
| Diagnose concurrency, limits, and billing | [Troubleshooting](gotchas.md) |
| Verify storage behavior in the Workers runtime | [Testing](testing.md) |

For object routing, WebSockets, and coordination design, see the [Durable Objects skill](../../../durable-objects/SKILL.md).
