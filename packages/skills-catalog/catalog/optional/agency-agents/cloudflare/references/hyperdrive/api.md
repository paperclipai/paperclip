# Hyperdrive API and drivers

Start with [README.md](./README.md) and [configuration.md](./configuration.md). Fetch the selected guide before writing connection or query code; use its current supported package version and compatibility settings.

## Driver and binding routes

| Task | Official documentation |
|------|------------------------|
| PostgreSQL with node-postgres (`pg`), including binding connection string and parameterized queries | [node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/) |
| PostgreSQL with tagged-template queries and Postgres.js driver options | [Postgres.js](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/) |
| MySQL with binding connection properties and Worker-specific driver options | [mysql2](https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/mysql2/) |
| Check database features, prepared statements, and library compatibility | [Supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) |
| Generate binding and runtime TypeScript types | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |

Keep an existing supported driver when it fits the application. Choose by database engine and library integration needs; do not infer cache behavior from a driver's prepared-statement setting. Fetch [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) for cache eligibility and freshness controls.

## ORMs and query builders

| Task | Official documentation |
|------|------------------------|
| Use Drizzle with PostgreSQL | [PostgreSQL Drizzle guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/drizzle-orm/) |
| Use Drizzle with MySQL | [MySQL Drizzle guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/drizzle-orm/) |
| Use Prisma with PostgreSQL | [Prisma guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/prisma-orm/) |
| Assess another query builder, including Kysely | [Postgres.js integration notes](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/) and [database compatibility](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/), then the library's current dialect documentation |

An ORM still uses a database driver and inherits its Worker connection constraints. Keep clients scoped to the invocation using [connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/). When a library owns SQL for authentication or other fresh reads, pass a client using a cache-disabled configuration as described in [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
