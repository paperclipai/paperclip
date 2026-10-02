# Conformance: Run the Standalone Tracer

## What this phase is

Conformance is the smallest standalone runner path. It uses a mock control plane and does not start Paperclip.

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
root lockfile. `--offline` proves Conformance needs no newly downloaded package.
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

## 4. Validate the documentation

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Expected result: documentation-link validation passes. The historical OKF and
recorded-evidence bundle is intentionally deferred from this release.

## 5. Run the tracer

```sh
pnpm --filter @paperclipai/paperclip-runner trace:conformance
```

Expected final line:

```json
{"schemaVersion":"paperclip.runner.conformance.output.v1","runIdentity":{"runId":"run_conformance_0001","sessionId":"session_conformance_0001"},"result":{"status":"succeeded","summary":"Standalone Conformance fixture accepted."}}
```

The command exits successfully after the mock core stops. No service remains

The default tracer is Rust. Prove that the TypeScript reference produces the
same bytes with:

```sh
pnpm --filter @paperclipai/paperclip-runner check:conformance-parity
```

Expected result: `Rust and TypeScript Conformance tracer output matches the shared
golden fixture.`

## 6. Inspect the conformance fixture

```sh
sed -n '1,240p' packages/paperclip-runner/protocol/fixtures/conformance-minimal-run.json
```

## One-command rerun

After installation, the same checks can be repeated with:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Continue with the [cumulative end-to-end tutorial](end-to-end.md), which points
to this tutorial as the current complete path.
