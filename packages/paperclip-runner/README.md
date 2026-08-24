# Paperclip Runner

This private workspace package contains the staged Paperclip Runner work.

The package currently exposes only the language-neutral PRP v1 TypeScript
contract, provider-neutral structured questions and responses, deterministic
fixture validation/replay, structured-result normalization, and the session
reducer oracle. It also contains a package-local Rust runner, scripted fake
harness, bounded process supervisor, cross-language replay oracle, and durable
PRP transport. The transport authenticates and encrypts loopback WebSocket
sessions, persists an ACK-driven outbox and command journal, and reconnects with
a short-lived lease. The Rust runner now includes a Codex-only app-server
provider bridge with durable thread resume, cancellation, structured questions,
and provider-neutral event normalization. No server code starts or invokes it.
The package does not add a server adapter, semantic-tool authorization, or
production Paperclip behavior.

The first and only installed provider is Codex. Dynamic semantic tools remain
undiscoverable because the catalog and authorization layers have not landed.

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

Durability and failure semantics are documented in
[`runner/DURABLE_TRANSPORT.md`](runner/DURABLE_TRANSPORT.md). The fault suite
drops a connection before its event ACK, reconnects with the bound lease,
replays the same event, and proves the duplicated command effect ran once.
Codex launch, resume, cancellation, and normalization behavior is documented in
[`runner/CODEX_PROVIDER.md`](runner/CODEX_PROVIDER.md).

Use `generate:protocol-manifest` after a schema or fixture change,
`generate:protocol-types` after a schema change, and
`generate:replay-goldens` after an intentional reducer change. Commit generated
outputs with their sources; do not edit them by hand.

The gate compiles every schema with AJV 2020-12, validates accepted fixtures,
rejects unsupported required versions, checks generated TypeScript schema
drift, runs the TypeScript contract tests, and compares reducer snapshots and
parity summaries byte-for-byte with their checked-in golden files.
