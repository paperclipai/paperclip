# Heartbeat disposition test audit — 2026-10-12

Two duplicate fixture-and-recovery executions are retired. Test registrations fall from 398 to 396. Test source changes by +13/−68, net−55 lines. No execution-time or CI-time benefit is claimed.

The historical pre-integration proof parent was #16099 at `8e955181d8a3776acc86e4662de3c77933231a76`, branch `codex/test-audit-daytona-pack`. The complete 248-declaration, 398-runtime-case ledger and 49 helper/hook hashes are in the companion JSON evidence file. All 52 matrix declarations remain. All 245 declarations outside the keeper and the two retirements retain their source hashes.

## Retired and keeper map

| Role | Original lines | Case |
| --- | --- | --- |
| Retired case 202 |13446–13471| `repairs missing disposition independently of the productive diagnostic label` |
| Retired case 207 |13710–13749| `re-enqueues recovery when the latest in-progress continuation made progress but left no live path` |
| Keeper case 239 |15632–15706| `does not treat a productive terminal run as healthy when in-progress work has no live path` |

Each seeds `seedStrandedIssueFixture({status: "in_progress", runStatus: "succeeded", livenessState: "advanced"})`, creates one heartbeat service, and reconciles once. No optional fixture input differs. The keeper's extra precondition queries are reads. They confirm the source owner and the absence of active company runs and live company wakes.

The keeper retains its complete original checks. It receives the exact successful/continuation/escalation counters, post-reconcile issue state, two wakes, the original agent-only run count, and the conditional settlement wait. Both the agent-only and company+agent query boundaries remain. Full retry issue/task/source/ancestor identity and the absent modelProfile remain. Crash, ownership, persistence, restart, cancellation, error and distinct liveness scenarios outside this exact fixture are unchanged.

## Historical sequential exact-parent controls

| Phase | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| baseline | 398 | 0 | 0 |
| candidate | 396 | 0 | 0 |
| revert | 398 | 0 | 0 |
| mutation-source-original | 0 | 1 | 397 |
| mutation-source-keeper | 0 | 1 | 395 |
| mutation-counter-original | 0 | 1 | 397 |
| mutation-counter-keeper | 0 | 1 | 395 |
| restoration | 396 | 0 | 0 |

The four mutation runs select one intended case each. Their unselected skips do not count as coverage. The real recovery owner runs against isolated embedded Postgres; adapter mocks are unchanged.

The source mutation changes `server/src/services/recovery/service.ts:3163` from the canonical persisted context source to `issue.wrong_disposition_repair`. It fails retired case 202 at original line 13463 and the keeper at candidate line 15635, at the context source oracle.

The independent counter mutation adds `successfulContinuationObserved += 1` in the active queued legacy-repair branch at `server/src/services/recovery/service.ts:4513`. It fails retired case 207 at original line 13721 and the keeper at candidate line 15608, where the counter expects 0 and receives 1. Other earlier liveness checks pass before this guard.

Restoring the owner returns the full candidate to 396/396 with zero failures/skips. Test and owner source are then restored byte for byte to the exact parent before the final patch is applied. The process snapshot has no owned remaining test/Postgres process. No global main Postgres process is present at that snapshot. One unrelated Vitest process in another checkout remains. It is not part of this proof. No global process is terminated by this audit.

## Integrated revision checks

The counts, source hashes, matrix/declaration ledger and mutation line numbers
below and in the companion JSON were recorded before integration. They do not
claim a passing run or matching whole-file hashes on today's PR head.

The integrated code revisions are parent
`ef04ba1592a5932d2d971e09b09467f878572d7a` and candidate
`1daaa7496b67c9d38eb7ee4f3eec9e1a3e27cd86`. These immutable public revisions
precede this documentation clarification; the clarification changes no tests or
production source. Fresh static checks confirm the candidate still changes only
+13/-68 lines in `heartbeat-process-recovery.test.ts`, and the production owner
has identical bytes in both revisions.

| Integrated file | Parent SHA-256 | Candidate SHA-256 |
| --- | --- | --- |
| `heartbeat-process-recovery.test.ts` | `66c6fcfd0a798bc690355eef86306c3b02dead31341e14e27a27bf3f7e5ca061` | `e1d787440f7a24cde1601da41a7c2d78897f0e0b9b31c88657479332d3ff3310` |
| `recovery/service.ts` | `6f23f16a963eb4fe743daad39bc3a51373b72799c851ac9b367ebf119c2b706c` | `6f23f16a963eb4fe743daad39bc3a51373b72799c851ac9b367ebf119c2b706c` |

```sh
base=ef04ba1592a5932d2d971e09b09467f878572d7a
candidate=1daaa7496b67c9d38eb7ee4f3eec9e1a3e27cd86
git fetch https://github.com/paperclipai/paperclip.git "$base" "$candidate"
git diff --check "$base" "$candidate"
git diff --numstat "$base" "$candidate" -- server/src/__tests__/heartbeat-process-recovery.test.ts
git show "$base":server/src/__tests__/heartbeat-process-recovery.test.ts | shasum -a 256
git show "$candidate":server/src/__tests__/heartbeat-process-recovery.test.ts | shasum -a 256
git diff --exit-code "$base" "$candidate" -- server/src/services/recovery/service.ts
```

To validate the integrated owner, create separate isolated checkouts at these
revisions, install the pinned dependencies and run the owner command below in
each. Record actual current counts; do not substitute the historical 398/396
counts. Current-head CI must validate the integrated change before merge. This
clarification records static checks, not a new local runtime or mutation run.

## Reproduce historical controls

Use isolated PAPERCLIP_HOME, PAPERCLIP_CONFIG and TMPDIR values and the checked-in root/server Vitest configuration:

```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server \
  server/src/__tests__/heartbeat-process-recovery.test.ts --exclude '**/dist/**'
```

Run baseline, candidate, full revert, each original/keeper mutation independently, then the full restored candidate. Restore source after proof. Mutation patches are described above and are never committed.

## Limits

This is a narrow test change. Local controls cover the entire owner. Repository-wide typecheck/test/build and review gates must be checked on the new PR head. No timing or broader live-product acceptance claim is made.
