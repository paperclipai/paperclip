# Feature modules

A feature module under `server/src/modules/<name>/` uses three layers. Each
layer has one rule: which layer below it, it may import from.

```
adapters  →  application  →  domain
```

- **`domain/`** holds pure business rules. A domain file takes plain data in
  and returns plain data out. A domain file must not import `drizzle-orm`,
  `@paperclipai/db`, a service under `server/src/services/`, a route under
  `server/src/routes/`, or a Node.js I/O module (`node:child_process`,
  `node:fs`, `node:net`). A domain function must not read the system clock;
  the caller passes `now` as an explicit `Date` value.
- **`application/`** holds use cases and the ports they need. A use case
  takes its ports as constructor arguments and calls domain functions for
  policy decisions. An application file must not import `drizzle-orm`, a SQL
  client, a concrete adapter, or the server's HTTP error helpers. The outer
  service or route translates application errors into transport responses.
- **`adapters/`** holds the concrete implementations of the ports:
  Postgres queries, transactions, and process control. An adapter file may
  import `drizzle-orm`, `@paperclipai/db`, and Node.js I/O modules.

A module exposes one entry point, `index.ts`, which composes the adapters
and the use cases behind a factory function. Code outside the module imports
only that entry point, never a file inside `domain/`, `application/`, or
`adapters/` directly.

`pnpm check:module-boundaries` enforces these rules for production source
files. It also rejects imports that bypass another module's `index.ts`.
