---
type: Engineering Journal Entry
title: Phase 0 Rust boundary correction
description: Corrects the TypeScript-only Phase 0 checkpoint by establishing and verifying the production-direction Rust workspace.
tags: [native-runner, phase-0, rust, boundary, correction]
status: stable
generated: { by: codex/gpt-5, at: 2026-08-07T18:09:35Z }
entry_kind: correction
phase: "0"
---

# Context

The Phase 0 issue named TypeScript contract sketches, and the first checkpoint
implemented the fixture, mock control plane, tracer, and boundary enforcement
only in TypeScript. That satisfied the literal deliverable list but failed to
establish the language boundary required by the normative spike specification:
the production runner direction is Rust, while TypeScript is the control-plane,
browser, and reference-client language.

# Root cause

Implementation followed the Phase 0 bullets in isolation and treated the spike's
Rust packaging section as later daemon work. The accepted plan's `runner/`
directory and the specification's production-language decision were not turned
into a Phase 0 acceptance assertion, so all checks could pass without Cargo or a
Rust source file.

# Decisions

1. Establish `runner/Cargo.toml` and `paperclip-runner-core` in Phase 0; do not
   wait for the daemon/process-supervision phase to create the Rust boundary.
2. Make `trace:phase0` run the Rust implementation. Retain the TypeScript tracer
   as an explicit reference oracle rather than the implied production runner.
3. Consume the same checked JSON fixture in both languages and compare complete
   serialized output byte for byte.
4. Extend the standalone dependency check to Rust includes/path attributes and
   Cargo path dependencies, with a negative Cargo fixture that points at core.
5. Keep `paperclip-runnerd`, transport, durable state, process supervision, and
   real harness drivers deferred to their accepted later phases.

# Evidence

Exact tool versions, commands, and results are in the
[Rust correction verification](../evidence/2026-08-07-phase-00-rust-correction-verification.md).

# Failures

- The execution image had no Rust toolchain. A stable toolchain was installed
  into the run-scoped Paperclip scratch directory so the crate could be compiled
  and tested without changing the host installation.
- Sandboxed DNS could not reach the official Rust or crates.io endpoints. The
  approved network path downloaded the official toolchain and lockfile-pinned
  crates; subsequent package verification used the local cache.
- The first parity helper used synchronous Node child processes. This sandbox
  returned `EPERM` for that spawn path, so the helper could mistake empty stdout
  for a language mismatch. Both language tests now compare against one shared
  golden output fixture, which is deterministic and does not depend on nested
  process spawning.

# Known gaps

- `runner-core` is a deterministic Phase 0 skeleton, not `paperclip-runnerd`.
- The Phase 0 fixture is intentionally narrow JSON; Phase 1 still owns the full
  PRP JSON Schema, generated/checked types, and conformance corpus.
- Phase 0 contains no async runtime, network transport, spool, signal
  supervision, or harness process.

# Follow-up questions

- Which Rust schema-generation/checking path should Phase 1 use so JSON Schema,
  rather than serde or TypeScript implementation detail, remains authoritative?
- What minimum supported Rust version should be pinned before distributable
  runner binaries begin?
