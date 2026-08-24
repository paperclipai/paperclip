# Paperclip Runner

This private workspace package contains the staged Paperclip Runner work.

This change adds only the language-neutral PRP v1 contract. It does not add a
runtime, a server adapter, or a public package export. The schemas and fixtures
are safe to review and merge before production behavior exists.

The first provider scope is Codex. The protocol contains provider-neutral event
and semantic receipt shapes, but their presence does not authorize a tool or
enable a provider.

Run the protocol gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:protocol
```

Use `generate:protocol-manifest` after a schema or fixture change. Commit the
updated manifest with its source change. Do not edit the manifest by hand.
The gate compiles every schema with AJV 2020-12. It validates accepted replay,
question, and cross-language conformance fixtures against the declared schemas.
It also proves that the unsupported required-version fixture is rejected.

The next pull request will add TypeScript validation and replay behavior. The
public root and `./testing` exports will arrive with the package boundary pull
request.
