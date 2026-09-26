# D1 Configuration

Read the task's documentation before adding bindings or running database commands. Confirm the database and environment being targeted, particularly when applying migrations or importing data.

| Task | Current documentation |
| --- | --- |
| Create a database and attach a Worker binding | [Getting started](https://developers.cloudflare.com/d1/get-started/) |
| Configure binding fields and multiple databases | [Wrangler D1 configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases) |
| Separate staging and production databases | [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/) |
| Create, track, and apply schema migrations | [Migrations](https://developers.cloudflare.com/d1/reference/migrations/) |
| Look up CLI flags for management, execution, and exports | [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) |
| Develop against local database state | [Local development](https://developers.cloudflare.com/d1/best-practices/local-development/) |
| Generate binding types | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Choose an ORM or query builder, including Drizzle | [D1 community projects](https://developers.cloudflare.com/d1/reference/community-projects/) (follow the integration's current setup guide) |
| Import or export SQL data | [Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/) |
| Enable replicas and use them through sessions | [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) |

Local migrations and data do not automatically update a remote database. Test against a separate staging database before a production migration. Naming another binding `DB_REPLICA` does not configure replica routing; follow the replication guide.
