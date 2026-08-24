# Paperclip Runner

This private workspace package contains the staged Paperclip Runner work.

The package currently exposes only the language-neutral PRP v1 TypeScript
contract, provider-neutral structured questions and responses, deterministic
fixture validation/replay, structured-result normalization, and the session
reducer oracle. It does not add a runner process, provider transport, server
adapter, semantic-tool authorization, or production Paperclip behavior.

The first provider scope is Codex. The protocol contains provider-neutral event
and semantic receipt shapes, but their presence does not authorize a tool or
enable a provider.

The root export is intentionally narrow. The `./testing` entry point and package
release boundary will arrive with the later package-boundary change.

Run the complete contract gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:protocol
```

Use `generate:protocol-manifest` after a schema or fixture change,
`generate:protocol-types` after a schema change, and
`generate:replay-goldens` after an intentional reducer change. Commit generated
outputs with their sources; do not edit them by hand.

The gate compiles every schema with AJV 2020-12, validates accepted fixtures,
rejects unsupported required versions, checks generated TypeScript schema
drift, runs the TypeScript contract tests, and compares reducer snapshots and
parity summaries byte-for-byte with their checked-in golden files.
