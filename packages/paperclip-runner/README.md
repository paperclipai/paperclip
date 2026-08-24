# Paperclip Runner

This private workspace package contains the staged Paperclip Runner work.

The package currently exposes only the language-neutral PRP v1 TypeScript
contract, provider-neutral structured questions and responses, deterministic
fixture validation/replay, structured-result normalization, and the session
reducer oracle. It also contains a package-local Rust runner, scripted fake
harness, bounded process supervisor, and cross-language replay oracle. These
Rust binaries are test infrastructure. No server code starts or invokes them.
The package does not add a provider transport, server adapter, semantic-tool
authorization, or production Paperclip behavior.

The first provider scope is Codex. The protocol contains provider-neutral event
and semantic receipt shapes, but their presence does not authorize a tool or
enable a provider.

The root export is intentionally narrow. The `./testing` entry point and package
release boundary will arrive with the later package-boundary change.

Run the complete contract gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:protocol
```

Run the Rust runner gate with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:runner
```

This command checks Rust formatting, builds and tests the minimal workspace,
verifies bounded process cleanup, exercises the fake local runner, and compares
the Rust conformance and replay summaries with the shared fixtures.

Use `generate:protocol-manifest` after a schema or fixture change,
`generate:protocol-types` after a schema change, and
`generate:replay-goldens` after an intentional reducer change. Commit generated
outputs with their sources; do not edit them by hand.

The gate compiles every schema with AJV 2020-12, validates accepted fixtures,
rejects unsupported required versions, checks generated TypeScript schema
drift, runs the TypeScript contract tests, and compares reducer snapshots and
parity summaries byte-for-byte with their checked-in golden files.
