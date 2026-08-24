---
type: Verification Evidence
title: Phase 0 Rust correction verification
description: Tool versions and targeted results for the corrected Rust workspace and cross-language tracer.
tags: [native-runner, phase-0, rust, verification, parity]
status: stable
generated: { by: codex/gpt-5, at: 2026-08-07T18:09:35Z }
phase: "0"
---

# Environment

- OS: `Linux 6.17.0-1019-aws aarch64`
- Rust: `rustc 1.97.1 (8bab26f4f 2026-07-14)`
- Cargo: `cargo 1.97.1 (c980f4866 2026-06-30)`
- Node.js: `v22.22.2`
- pnpm: `9.15.4`

The Rust toolchain was installed only under `PAPERCLIP_RUN_SCRATCH_DIR`; it did
not modify the host user's Rust installation or shell profile.

# Commands and results

1. Rust formatting check:

```sh
cargo fmt --manifest-path packages/paperclip-runner/runner/Cargo.toml --all -- --check
```

Result: exit 0.

2. Complete package verification:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Result: exit 0. TypeScript build/tests, Rust build/tests, TypeScript and Cargo
negative boundary tests, documentation links, OKF v0.2 validation, language
parity, and the default Rust tracer all passed.

3. Rust tests included in the package verification:

```sh
cargo test --manifest-path runner/Cargo.toml --locked --workspace
```

Result: 3 Rust unit tests passed: shared-fixture validation, invalid sequence
rejection, and stable mock-core tracer output.

4. Stable tracer output:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

# Acceptance mapping

- Rust production package boundary exists: `runner/Cargo.toml` and
  `runner/crates/runner-core/`.
- The package's default tracer executes Rust, not TypeScript.
- Rust and TypeScript read the same fixture and emit byte-identical output.
- Static boundary enforcement covers Rust source inclusion and Cargo path
  dependencies, with a negative core-path fixture.
- The accepted plan, architecture, tutorials, journal, and README state Rust as
  the production direction and TypeScript as the reference/control-plane side.
