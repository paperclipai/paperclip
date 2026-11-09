# Execution-target sandbox test audit: round 19

Exact parent: #16092, `8e52b1935d8982fae24158fc94dacf218c023ee5`.

Read the complete 6,409-line test owner, all helpers, hooks, parameter rows and assertions. The declaration ledger has 129 declarations and 148 registered cases. The candidate has 128 declarations and 147 cases.

## Retirement map

Retire `bounds the pre-READY buffer growth-copy work by the bytes received`. Keep `bounds the pre-READY newline-scan work by the bytes received`.

Move `resetBufferGrowthCopyUnits()` before the keeper's bridge bring-up. Move the exact `readBufferGrowthCopyUnits()` and `copyUnits <= 4 * totalBytes` observation into its try block after the scan bound. Keep both bridge-presence/open-count guards and the exact bridge.stop/api.close finally block.

Both cases have the same recording API server, buffer cap, 64-byte chunks, chunk count, byte count, runner callback, recorder, provider target, readiness timeout and bridge options. The callback emits the same chunks in the same order. The setup, callback, bridge call and finalizer AST match after normalizing only two namespace labels. Fresh temp prefixes and runIds differ. They select fresh isolated paths and run namespaces; neither case dispatches a request or observes those names. They have the same path shape and valid runId character class. These differences are expressly assessed as isolation, not described as literal byte-equivalent inputs.

The two reset/read pairs use independent numeric accounting variables. Production never reads the counters to select behavior. Neither reset changes the buffer, gate, callbacks or lifecycle. Both bounds can observe one fresh bridge execution.

The whole-program AST permits only one declaration removal and the exact reset/read/bound migration. Helpers, hooks, fixtures, parameter rows, all other declarations and the separate many-small-chunk cap case match the parent. The restored runtime case list equals the baseline minus the named retirement.

## Full owner replay

All complete-file runs have zero failures and skips.

| Phase | Passed cases |
| --- | ---: |
| Exact parent baseline | 148 |
| Candidate | 147 |
| Original test revert | 148 |
| Restored candidate after controls | 147 |

Command: `pnpm exec vitest run packages/adapter-utils/src/execution-target-sandbox.test.ts --reporter=json --outputFile=<phase>.json`.

## Actual production-owner controls

Each control selects the keeper with Vitest `-t`. It fails once at the intended assertion. Other rows are selector-filtered; no source skips are added. Neither control changes the counters or their test-only readers.

| Control | Actual owner change | Intended failure |
| --- | --- | --- |
| Newline rescan | Search from offset zero for retained buffers up to 32 KiB, then use the original cursor. This makes actual indexOf work repeat on retained bytes. | Retained scan bound, candidate line 4591: 8,638,528 scan units exceeded 1,065,216. |
| Per-fragment growth | In appendReadinessBytes, allocate exactly the needed length for the first 32 KiB, then use the original doubling. This makes actual storage.copy work repeat. | Migrated copy bound, candidate line 4593: 8,863,744 copied bytes exceeded 1,065,216. |

The bounded controls avoid excessive stress while introducing a real buffer/cursor regression. The owner is restored after each control. SHA256 before and after: `9f61140f7c27698e7837b97dd78f9b3056045a41527da06bb0cee9f11c9f62a6`.

Candidate test SHA256: `270701dcf459289a6d09ac88c74cf9ccfb41ab8323d75eecbc9ef683072471ee`.

An initial harness refused the growth declaration because the text occurred in two functions. It applied no growth mutation. The final control binds the exact appendReadinessBytes function. Both final controls caught the intended regressions and restored the owner.

## Scope and checks

The test diff adds one line and removes 38 lines: 37 net test lines removed. It removes one registered execution and one real bridge bring-up. No measured time savings are claimed. Production LOC changes: zero.

Retain all transport, callback, command, host/sandbox path, credential, platform, readiness, timeout, security and lifecycle distinctions. Pre-preface overflow and post-preface overflow remain separate. Safe GET and committed POST remain separate. The independent many-small-chunk buffer-cap case remains intact.

Focused adapter-utils typecheck and build, token gate, and diff check pass. No repeated broad run was started: the exact parent's full local attempt failed in its server-only phase with unchanged host/server failures before workspace projects ran. Its focused UI proof and all 53 remote checks passed. This candidate does not claim a full local suite pass.

Full replay JSON/logs, exact declaration/runtime ledger, AST/input proof, mutation failures, original source and restored hash receipts are retained under /private/tmp/execution-target-*. This report includes the retirement map, exact counts and observed controls for review without those local files.
