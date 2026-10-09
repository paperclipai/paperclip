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

A module exposes its commands through `index.ts`, which composes the adapters
and the use cases behind a factory function. Code outside the module imports
that entry point, never a file inside `domain/`, `application/`, or
`adapters/` directly.

`pnpm check:module-boundaries` enforces these rules for production source
files. It also checks access to the company deletion entry point below.

## Company deletion

The existing company deletion service owns the database transaction and deletion
order. A module can expose a separate `company-deletion.ts` entry point.
Only `services/company-deletion.ts` can import this entry point.
The entry point exports an implementation of `CompanyDeletionParticipant` from
`lib/company-deletion.ts`. Do not export it through the normal module index.

The service must complete external cleanup before it starts the transaction.
It must lock the company before it deletes dependent records or calls a module.
Creation commands must use the same company lock.
The service removes dependent records before it calls the module.
The module checks its deletion conditions and deletes the records it owns.
Use the supplied transaction. Do not start another transaction or call external
systems. Throw an error if deletion cannot proceed.
An error must roll back all database changes in the deletion transaction.

Call each module explicitly in dependency order. No module registry is required.

The [agent lifecycle module](../../../doc/AGENT-LIFECYCLE.md) owns agent creation,
pause, resume, and termination. Use its commands for these changes.
