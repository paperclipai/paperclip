# Hyperdrive

Use Hyperdrive to connect Workers to an existing PostgreSQL or MySQL database with connection pooling and optional query caching. It does not replace the origin database or replicate its data. Start with [how Hyperdrive works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/) and [supported databases and features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) to assess fit.

## Retrieve current documentation

Fetch the relevant official page before implementing. Driver versions, compatibility settings, API shapes, CLI flags, cache settings, and limits belong in the docs rather than this reference. Use the [Hyperdrive documentation index](https://developers.cloudflare.com/hyperdrive/llms.txt) to discover additional pages. Retrieve a page as Markdown by sending `Accept: text/markdown` to its URL.

## Choose the next reference

| Task | Reference |
|------|-----------|
| Create a configuration, bind it, connect privately, or develop locally | [configuration.md](./configuration.md) |
| Choose a driver, use binding credentials, or integrate an ORM | [api.md](./api.md) |
| Decide read freshness, connection lifetime, or query placement | [patterns.md](./patterns.md) |
| Diagnose connection, cache, latency, or capacity problems | [gotchas.md](./gotchas.md) |

## Decisions to preserve

- Choose a driver for the database engine and existing application stack; verify supported versions and Worker requirements in its guide.
- Create database clients inside each handler invocation. Hyperdrive manages the underlying origin pool; consult [connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/) for cleanup behavior.
- Choose caching by read freshness. Disabling caching still allows connection pooling; a write does not invalidate cached reads. See [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

## See also

- [D1](../d1/) for a managed SQLite alternative.
- [Workers](https://developers.cloudflare.com/workers/) for the runtime and bindings.
