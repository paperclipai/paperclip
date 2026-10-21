# Execution wrapper test audit — 2026-10-13

Remove three import-only acceptance aliases while retaining their complete production-boundary owners. This retires **99 duplicate case registrations and nine test lines**, with **zero production behavior changes**. Complete retained-owner baselines and the final candidate each pass **65/65 cases**, with no failures or skips.

Delivery base: `770cc3be7e294d606d83599c6f6a3232d47d4c70`, the merged root after #16188. Qualification began at `e868e6645ce0d598d756d3458f0b3d71afd6db4a`; all three owners, the mutated production owner, and affected ownership references are byte-identical between those bases. Followed the OpenClaw [test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md) and its candidate-evidence and retention rules.

## Retired aliases and retained contracts

| Retired server acceptance alias | Complete retained owner | Repeated cases | Removed test lines | Historical CI weight |
|---|---|---:|---:|---:|
| `heartbeat-native-runner-selection.test.ts` | `services/native-runtime/runtime-mode.test.ts` | 27 | 2 | 1,173 ms |
| `native-runner-phase6.integration.test.ts` | `services/native-runtime/paperclip-control-plane-port.test.ts` | 34 | 3 | 19,600 ms |
| `native-run-finalizer.test.ts` | `services/native-runtime/paperclip-control-plane-port.test.ts` plus `services/native-runtime/evidence-classifier.test.ts` | 38 | 4 | 19,882 ms |

Every retired executable line imports one of those test modules. There are no alias-owned assertions, fixtures, mocks, hooks, filters, configuration, or entry-point actions. All aliases originated unchanged in `25cf079ec5` (#12591, 2026-08-31), when server Vitest already included the colocated owners. The shared `src/**/*.test.ts` configuration, setup file, isolated forks, and default server walker execute the same owners. An actual current-Vitest run of runtime-mode plus its alias passes 54/54, demonstrating the duplicate registration.

Retain every runtime-selection, compatibility, persisted binding, authorization, redaction, event/replay, result, governance, review, transactional ordering, rollback, workspace-failure, and durable-evidence assertion in the three owners. Their bytes, table rows, timers, awaits, and budgets are unchanged. Independent parent review confirmed that the six-file cleanup removes only these import aliases and redirects the affected pointers.

Retain `native-runner-input-boundary.test.ts`: it imports a Runner package suite omitted from the root default project list. Deleting that superficially similar alias would remove root-suite input-contract coverage. Prior audit receipts and excluded adapter, native-session, recovery, workspace-runtime, UI, and E2E areas were not revisited.

The protocol-coverage generator and generated artifact now name the actual runtime-mode owner. The standalone-thin documentation invokes the three canonical owners directly and removes retired aliases from its file inventories. These labels carry no separate executable matrix signal; no acceptance requirement, source assertion, CI route, or production seam changes.

## Qualification and reversal

- Baseline: runtime-mode 27/27, evidence-classifier 4/4, and the complete real-Postgres control-plane owner 34/34. Final candidate: the same three files, 65/65, zero failures/skips.
- Mutation: bypass only the persisted `run.nativeIssueId === this.#binding.issueId` comparison in `PaperclipControlPlanePort`. The retained `revalidates every persisted native binding before open and completion` fails at its rejection assertion (line 1131): the first corrupted task-binding open resolves `undefined` instead of rejecting. Setup completed; this was neither a timeout nor a harness failure.
- Reversal: restore the production owner byte for byte, then the exact selected guard passes. Its 33 excluded cases are intentional name-filter skips, not a complete-file control claim. Restoration SHA-256: `621beee8a451e9cab4fc09f886bfb4d95512c1433f82b7f9cbd3ea83fd2f3d0c`.
- Default routing: 886 unique general-server files across all 12 stock shards; each retained owner appears exactly once, retired aliases zero times, and the required package-input alias once. Stock shard-routing tests pass 29/29.
- Runner `build:typescript`, generated protocol-coverage `--check`, generator syntax check, owner byte comparisons, and `git diff --check` pass.

Focused candidate command:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/services/native-runtime/runtime-mode.test.ts \
  src/services/native-runtime/evidence-classifier.test.ts \
  src/services/native-runtime/paperclip-control-plane-port.test.ts
```

## Cost and limits

The **40.655 seconds** total above is historical raw suite weight from `scripts/general-server-shard-durations.json`, averaged from PR CI runs 38076844891 and 38076972444 (2026-10-10). It is not a fresh causal speed measurement or a prediction of critical-path job savings. No timing claim comes from removed line counts. The successful full port baseline took 16.472 seconds of test time (25.84-second invocation); the final three-owner candidate took 26.08 seconds total. Their scopes and host state differ, so they are not an A/B speed comparison.

Two initial database attempts failed before any assertions because the isolated `--ignore-scripts` install omitted Postgres dylib symlinks. The dependency's standard hydration script repaired that isolated setup; subsequent real-DB baseline, mutation, reversal, and candidate runs reached their intended assertions. Read-only shared-memory inventories showed 29 then 30 allocations against a 32-entry limit. No unrelated process was inspected, stopped, or changed. These failed setup attempts are excluded from the passing counts.

This is complete affected-owner proof. A combined execution of all retired aliases was not repeated; doing so would replay the expensive unchanged database owner. Vitest's combined `list` collection reported no-suite errors on import aliases because it reuses module registrations; collection is not used as runtime preservation proof. No complete repository typecheck, default suite, full build, Rust qualification, browser suite, or fresh remote CI pass was obtained for this local branch. Their absence is not represented as a full repository pass. Publication follows the parent's sequential stack disposition.

[Compact controls and provenance](2026-10-13-execution-wrapper-test-audit-controls.json) retain source/run hashes, counts, and the intended mutation failure. Raw logs and run JSON remain temporary local audit evidence; digests identify them but do not make them durable payloads.
