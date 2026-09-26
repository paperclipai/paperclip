# Cloudflare D1 Database

Use D1 for managed relational application data with SQLite semantics. For an existing external database, consider [Hyperdrive](../hyperdrive/); for per-entity coordination, consider [Durable Objects](https://developers.cloudflare.com/workers/platform/storage-options/#sql-in-durable-objects-vs-d1). See [storage options](https://developers.cloudflare.com/workers/platform/storage-options/) before choosing a product.

Read the relevant current documentation before implementing. These references route tasks to the source of truth rather than maintaining copies of APIs, configuration, or plan tables.

## Start here

- [Get started](https://developers.cloudflare.com/d1/get-started/): create a database, bind it to a Worker, and run a first query.
- [configuration.md](./configuration.md): bindings, environments, migrations, local development, and ORM integration.
- [api.md](./api.md): parameterized queries, batches, sessions, HTTP access, and testing.
- [patterns.md](./patterns.md): query design, caching, tenant isolation, replication, and recovery.
- [gotchas.md](./gotchas.md): errors, types, constraints, performance, and limits.

Check [limits](https://developers.cloudflare.com/d1/platform/limits/) and [pricing](https://developers.cloudflare.com/d1/platform/pricing/) for capacity, allowances, and plan availability; do not infer them from old examples.
