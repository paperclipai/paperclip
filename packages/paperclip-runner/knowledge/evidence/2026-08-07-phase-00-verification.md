---
type: Verification Evidence
title: Phase 0 verification
description: Exact tools, commands, and results for the standalone tracer checkpoint.
tags: [native-runner, phase-0, verification, boundary]
status: stable
generated: { by: codex/gpt-5, at: 2026-08-07T16:28:59Z }
phase: "0"
---

# Environment

- OS: `Linux 6.17.0-1019-aws aarch64`
- Node.js: `v22.22.2`
- pnpm: `9.15.4`
- TypeScript: `5.9.3`
- Vitest: `4.1.10`

# Commands and results

1. Offline filtered install:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --offline --ignore-scripts --dev --force
```

Result: exit 0; 194 packages resolved and reused, 0 downloaded, 6 package links
added, and completion in 831 ms. The command explicitly reported that the active
configuration prohibited reading or writing the root lockfile.

2. Package build:

```sh
pnpm --filter @paperclipai/paperclip-runner build
```

Result: exit 0; `tsc -p tsconfig.json` emitted the package to `dist/`.

3. Unit, integration, stable-output, and negative-boundary tests:

```sh
pnpm --filter @paperclipai/paperclip-runner test
```

Result: exit 0; 3 Vitest files and 5 tests passed in 167 ms. The Node boundary
suite also passed, including its positive package scan and negative fixture
assertion.

4. Standalone dependency boundary:

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

Result: exit 0; `Standalone boundary check passed.`

5. Documentation and OKF bundle:

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: exit 0; documentation links passed across 15 files. OKF v0.2 validation
passed for 3 concepts and 4 indexes.

6. Runnable tracer:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase0
```

Result: exit 0 after rebuilding, starting and stopping the in-memory mock core,
and printing exactly:

```json
{"schemaVersion":"paperclip.runner.phase0.output.v1","runIdentity":{"runId":"run_phase0_0001","sessionId":"session_phase0_0001"},"result":{"status":"succeeded","summary":"Standalone Phase 0 fixture accepted."}}
```

# Acceptance mapping

- Fixture validation: passed in the package-owned fixture unit tests.
- Mock-core contract path: passed from open through ordered events and result.
- Stable output: passed against an exact serialized string assertion and the CLI
  invocation above.
- Forbidden-import positive and negative paths: both passed.
- Documentation links and OKF v0.2 validation: passed.
- Human-followable tutorial: every documented command was exercised from the
  repository root.

# Known limitations

See the linked [Phase 0 journal entry](../journal/2026-08-07-phase-00.md) for
intentional gaps and follow-up questions.
