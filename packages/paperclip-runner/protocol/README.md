# PRP v1 Contract

The JSON Schema files in `schemas/` are the language-neutral source of truth for
Paperclip Runner Protocol version 1. The fixtures in `fixtures/` define accepted
and rejected compatibility cases.

## Compatibility

- `protocolVersion`, `fixtureVersion`, and `event.schemaVersion` are required.
- A consumer fails closed when a required version or schema discriminator is
  not supported.
- A v1 envelope can contain an unknown optional property when its schema marks
  that object as extensible.
- A consumer ignores an unknown optional property until a later contract gives
  it meaning.
- A required field, enum value, or typed structured-input field is not optional.
- Question and answer identifiers are stable across the provider boundary.

The `unknown-optional-fields.json` fixture must be accepted. The
`unsupported-required-version.json` fixture must be rejected.

## Scope

The first provider descriptor and adapter fixture cover Codex only. The schemas
for provider-neutral events and semantic receipts do not enable those actions.
Discovery and authorization are separate contracts.

The conformance manifest records every source file and its SHA-256 digest. Run
`pnpm generate:protocol-manifest` from this package after a source change. CI
runs the same generator with `--check` to reject drift. This check also compiles
the JSON Schemas and validates every replay, question, and cross-language
conformance fixture against its declared schema.

The files in `fixtures/replay/golden/` are deterministic reducer oracles. Each
accepted replay fixture has a complete session snapshot and a compact parity
summary. `pnpm generate:replay-goldens` updates them after an intentional
reducer change; package build and CI fail when they drift.

The files in `fixtures/local-runner/scripts/` drive the package-local fake
harness. They cover successful, failed, interrupted, interactive, duplicate
terminal, process-cleanup, and oversized-frame behavior without starting a
production adapter.
