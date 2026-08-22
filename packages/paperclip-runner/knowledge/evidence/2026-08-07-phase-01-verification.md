---
type: Verification Evidence
title: Phase 1 verification
description: Exact tools, commands, results, and browser artifact for PRP static replay.
tags: [native-runner, phase-1, verification, protocol, browser]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-07T19:10:00Z }
phase: "1"
---

# Environment

- OS: `Linux 6.17.0-1019-aws aarch64`
- Node.js: `v22.22.2`
- pnpm: `9.15.4`
- TypeScript: `5.9.3`
- Vitest: `4.1.10`
- Vite: `6.4.1`
- Playwright: `1.61.1`
- Rust/Cargo: `1.97.1` in the run scratch directory

# Commands and observed results

1. TypeScript schema/type/reducer tests:

```sh
pnpm --filter @paperclipai/paperclip-runner test:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
```

Result: exit 0. Six Vitest files and 29 tests passed. The generated schema module
matched all eight JSON Schema sources, and both TypeScript configurations passed.

2. Golden corpus and standalone boundary:

```sh
pnpm --filter @paperclipai/paperclip-runner check:phase1-goldens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
```

Result: exit 0. All six valid fixture snapshots/summaries were current; forbidden
Paperclip core imports were absent; component visual values remained in the
standalone `styles.css` token layer.

3. Rust conformance/parity tests:

```sh
PATH="$PAPERCLIP_RUN_SCRATCH_DIR/cargo/bin:$PATH" \
CARGO_HOME="$PAPERCLIP_RUN_SCRATCH_DIR/cargo" \
RUSTUP_HOME="$PAPERCLIP_RUN_SCRATCH_DIR/rustup" \
pnpm --filter @paperclipai/paperclip-runner test:rust
```

Result: exit 0. Twelve Rust tests passed, including all six parity fixtures,
unsupported protocol/fixture versions, a mismatched declared result, the Phase 0
stable tracer, and sequence-gap rejection.

4. CLI tutorial paths after `build:typescript`:

```sh
node packages/paperclip-runner/dist/cli/phase1-replay.js
node packages/paperclip-runner/dist/cli/phase1-replay.js packages/paperclip-runner/protocol/fixtures/phase-01/source-gap.json
node packages/paperclip-runner/dist/cli/phase1-replay.js packages/paperclip-runner/protocol/fixtures/phase-01/unsupported-required-version.json
```

Observed summaries:

```json
{"ok":true,"integrity":"complete","timelineCount":9,"runTerminalState":"succeeded"}
{"ok":true,"integrity":"gap_detected","gaps":[{"sourceKey":"runner:runner_phase1","expected":3,"received":4,"missing":[3]}]}
{"ok":false,"issues":[{"code":"unsupported_required_version","path":"/protocolVersion"}]}
```

The first two commands exited 0. The unsupported required version exited 1.

5. Browser build and Playwright replay:

```sh
LD_LIBRARY_PATH="$PAPERCLIP_RUN_SCRATCH_DIR/playwright-libs/usr/lib/aarch64-linux-gnu:/lib/aarch64-linux-gnu:/usr/lib/aarch64-linux-gnu" \
pnpm --filter @paperclipai/paperclip-runner test:browser
```

Result: exit 0. Vite transformed 218 modules and emitted the standalone page;
both Playwright cases passed in 2.0 seconds. They covered the happy snapshot,
ordered timeline, duplicate diagnostic, and unsupported-version error state.

6. Repository UI token gate baseline:

```sh
pnpm check:token-gates
```

Result: exit 1 with 12 existing color-literal findings in
`ui/src/components/onboarding/PaperclipOrbit3D.tsx`. Phase 1 changes no `ui/`
file. The package-local token check above is green.

7. Complete package acceptance sequence:

```sh
PATH="$PAPERCLIP_RUN_SCRATCH_DIR/cargo/bin:$PATH" \
CARGO_HOME="$PAPERCLIP_RUN_SCRATCH_DIR/cargo" \
RUSTUP_HOME="$PAPERCLIP_RUN_SCRATCH_DIR/rustup" \
LD_LIBRARY_PATH="$PAPERCLIP_RUN_SCRATCH_DIR/playwright-libs/usr/lib/aarch64-linux-gnu:/lib/aarch64-linux-gnu:/usr/lib/aarch64-linux-gnu" \
pnpm --filter @paperclipai/paperclip-runner verify
```

Result: exit 0. Build, all three typechecks, current goldens, 29 TypeScript
tests, 12 Rust tests, 3 negative/positive boundary tests, browser token check,
2 Playwright tests, documentation/OKF validation, Phase 0 parity, Phase 1
parity, the Rust Phase 0 tracer, and the Phase 1 CLI replay all passed.

# Browser artifact

[Phase 1 static replay screenshot](phase-01-static-replay.png)

- PNG: 1440 × 1201, RGB (refreshed by the Phase 2 browser suite)
- SHA-256: `9e77087e6bc16d3f8b7e730bde70eb2da11e359b71e24cd8ad7402a28f6680d0`
- Shows editable happy-path fixture input, validated terminal snapshot, result
  summary, ordered nine-event timeline, and snapshot JSON disclosure.

# Acceptance mapping

- Schema validation and schema-derived TypeScript types: passed.
- Happy/failure/interruption/duplicate/gap/unknown-field/version fixtures: passed.
- Determinism, idempotency, duplicate, gap, and forward compatibility: passed.
- CLI and browser use the same replay entry point: verified by imports and tests.
- Rust and TypeScript shared-fixture summaries: passed.
- Standalone browser build, interaction path, and screenshot: passed.
- Forbidden core imports: passed.
- Reference docs, tutorial index, cumulative tutorial, version policy, and OKF
  journal: linked and machine-validated.

# Known limitations

See the linked [Phase 1 journal entry](../journal/2026-08-07-phase-01.md) for
intentional Phase 2+ gaps and the host-only browser dependency note.
