# Hyperdrive configuration

See [README.md](./README.md) for the retrieval workflow. Fetch the relevant guide before creating or changing resources; use current configuration fields and CLI syntax from these sources.

| Task | Official documentation |
|------|------------------------|
| Create the first configuration and bind it to a Worker | [Get started](https://developers.cloudflare.com/hyperdrive/get-started/) |
| Create, inspect, update, or delete configurations; set cache or pool options | [Wrangler commands](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/) |
| Generate TypeScript types from Worker configuration | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Connect a private database using the recommended Workers VPC route | [Workers VPC integration](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/) |
| Maintain a private database connection using Tunnel and Access | [Tunnel integration](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/) |
| Configure database network access | [Firewall and networking](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/) |
| Configure server verification or client certificates | [SSL/TLS certificates](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/) |
| Rotate origin database credentials | [Credential rotation](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/) |
| Configure cache freshness or separate cached and fresh-read bindings | [Query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/) |
| Budget origin connections across configurations | [Tune connection pooling](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/) |
| Choose local database access or remote Hyperdrive testing | [Local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/) |
| Evaluate Worker placement for multiple database round trips | [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/) |

## Setup decisions

- Identify the database engine, provider, and network path first. The [PostgreSQL](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/) and [MySQL](https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/) indexes route to provider-specific instructions.
- For private connectivity, choose Workers VPC or the existing Tunnel/Access integration before configuring credentials. Follow the selected guide's prerequisites and TLS guidance.
- Decide which reads may be stale before selecting cache settings. Multiple configurations against one database contribute to its total origin connection usage.
- Local direct database access does not exercise Hyperdrive pooling or caching. Use the local-development guide's remote option when verifying those behaviors, and identify the database that option targets before running writes.

See [api.md](./api.md) for drivers and [gotchas.md](./gotchas.md) for diagnosis.
