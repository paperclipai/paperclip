# Phase 0: Run the Standalone Tracer

## What this phase is

Phase 0 is the smallest standalone runner path. It uses a mock control plane and does not start Paperclip.

## What this phase proves

This phase proves that the package has an independent Rust boundary. It also proves that Rust and TypeScript accept the same fixture.

You will install the package tools. You will compile the Rust and TypeScript code. You will run the tests and checks.

You will start the Rust mock core. The tracer validates one fixture and prints a deterministic result. The process then stops.

## Prerequisites

- repository checkout on the assigned runner branch;
- Node.js 20 or newer;
- pnpm 9 or newer;
- stable Rust with `cargo` on `PATH`;
- commands run from the repository root.

## 1. Install the package tools

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev
```

`--lockfile=false` follows this repository's policy that automation owns the
root lockfile. `--offline` proves Phase 0 needs no newly downloaded package.
`--dev` makes the package tooling explicit even when the calling shell has
`NODE_ENV=production`.

## 2. Build the standalone package

```sh
pnpm --filter @paperclipai/paperclip-runner build
```

Expected result: TypeScript writes package-local `dist/` files and Cargo builds
the `paperclip-runner-core` crate under `runner/target/`.

## 3. Run the behavior and boundary tests

```sh
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

The tests cover fixture validation, complete Rust and TypeScript mock-core paths,
stable output, and negative TypeScript/Cargo core-dependency fixtures. The
standalone boundary check must print `Standalone boundary check passed.`

## 4. Validate the documentation and OKF bundle

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Expected result: both documentation-link validation and OKF v0.2 validation
pass. The OKF validator checks concept frontmatter, typed journal fields, log
dates, the root version declaration, and index coverage.

## 5. Run the tracer

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase0
```

Expected final line:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

The command exits successfully after the mock core stops. No service remains

The default tracer is Rust. Prove that the TypeScript reference produces the
same bytes with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:phase0-parity
```

Expected result: `Rust and TypeScript Phase 0 tracer output matches the shared
golden fixture.`

## 6. Inspect and query the journal

```sh
sed -n '1,240p' packages/paperclip-runner/knowledge/journal/2026-08-07-phase-00.md
rg -l '^type: Engineering Journal Entry$' packages/paperclip-runner/knowledge
```

For more query and authoring examples, see the [journal guide](../journal.md).

## One-command rerun

After installation, the same checks can be repeated with:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Continue with the [cumulative end-to-end tutorial](end-to-end.md), which points
to this tutorial as the current complete path.
