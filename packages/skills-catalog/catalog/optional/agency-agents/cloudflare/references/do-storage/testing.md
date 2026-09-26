# DO Storage Testing

Choose tests around persistence, rollback, instance isolation, and scheduled-work behavior. Inspect installed test packages and configuration before changing the suite.

Fetch the relevant current documentation before implementing or reviewing changes.

| Task | Documentation |
|------|---------------|
| Set up or migrate a test suite, choose helpers, and manage isolation | [Testing Durable Objects](../../../durable-objects/references/testing.md) |
| Exercise RPC, SQLite storage, and alarms | [Testing Durable Objects example](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/) |
| Determine the storage or recovery contract to verify | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/); [Legacy KV storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/) |

Use the current test documentation for helper signatures and runtime limitations. For point-in-time recovery tests, check both the storage API and the test runtime’s supported behavior before assuming a restart reproduces production recovery.
