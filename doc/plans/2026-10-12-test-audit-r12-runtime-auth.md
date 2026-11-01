# Test audit R12: runtime and credential owner coverage

Date: 2026-10-12. Base: `e12e8de07b7cbd0c1b37a921d6db432bbb8d32c5`, the head of [R11](https://github.com/paperclipai/paperclip/pull/16078). Branch: `codex/test-audit-r12-runtime-auth`.

This change removes **seven redundant registered executions and 76 net test lines** across four files. It changes no production code. Each retired case repeats an existing owner invocation. Three result assertions move into the existing stronger first-login case. No wall-time improvement is inferred from these counts.

## Exact retirement map

| File | Retired exact case | Retained keeper and observation |
| --- | --- | --- |
| `cli/src/__tests__/runtime-info.test.ts` | `writes and reads the selected runtime endpoint` | `does not remove runtime info owned by a replacement process`: same fresh fixture, write and exact read; wrong-PID preservation and matching-PID removal also remain. |
| `packages/adapters/codex-local/src/server/codex-auth-merge-decision.test.ts` | `default mode keeps destination when destination is absent (host-default fail-closed)` | `the leading positional --seed-if-dest-absent flag is parsed before the two path arguments; a default two-path call never enters seed mode`: identical subscription bytes and absent destination, actual subprocess, exit 20. |
| Same Codex decision file | `seed mode uses source when destination is absent and source is a usable subscription credential` | Same leading-flag keeper: identical opt-in call, actual subprocess, exit 10. |
| `packages/adapters/grok-local/src/server/grok-auth-merge-decision.test.ts` | `uses the source when the identity matches and the source expiry is later` | `reads an ISO-8601 expiry, an epoch-seconds expiry, and an epoch-milliseconds expiry`: ISO row retains identical source/destination credential shape, markers and later-expiry relation through actual files and subprocess; all encodings remain. |
| `packages/adapters/codex-local/src/server/adapter-auth-promotion.test.ts` | `promotion returns the account id and the account home path` | `a user login seeds this account's own home and the company default home`: identical fresh-root input and callbacks. Exact account ID and account-home path assertions move unchanged into this keeper. |
| Same promotion file | `promotion reports accountHomeCreated true for a first login of an account` | Same first-login keeper gains the exact true receipt. Repeat-login and concurrent-created receipts remain separate. |
| Same promotion file | `promotion seeds the company default home when it holds no usable credential` | Same first-login keeper already reads the company default home's actual account ID and also reads the account home, checks promoted outcome and forbids instance-global writes. |

The retired invocations comprise one runtime-info write/read scenario, two Codex decision subprocesses, one Grok decision subprocess and three fresh-login promotions. Table registration and internal case execution are unchanged in the keepers. This is reduced duplicate execution, not only shorter test setup.

Net test lines: runtime-info 6; Codex decision 17; Grok decision 7; promotion 46, including five added assertion lines. Total: 81 deletions and five additions. The evidence files are excluded from those savings.

## Preserved contracts

The runtime file's malformed-input and process-ownership guards remain. Both decision suites retain identity isolation, unusable credentials, strict freshness and ties, exact clock bounds and encoding rejection. Promotion retains readiness, user-initiated/sole-owner gates, company isolation, account separation, repeat and concurrent creation, persistence failures, symlink replacement and secret redaction. No API, schema, migration, platform, lifecycle or security contract is retired.

## Replay on the exact stacked base

Nine complete existing files ran through the repository's real Vitest project configuration with isolated home, config, instance ID and temporary paths. The four owner files contain 56 original or 49 candidate cases. Five unchanged auth-cache, copyback and home siblings contain 121 cases.

| Phase | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Original baseline | 177 | 0 | 0 |
| Candidate | 170 | 0 | 0 |
| Reverted original tests | 177 | 0 | 0 |
| Candidate after owner restoration | 170 | 0 | 0 |

Run counts overlap and must not be added. Source-only filtering excludes build output. Existing pinned external dependencies are read-only; workspace dependency links point into this managed checkout. The initial discovery export was not used as PR qualification.

## Owner mutation controls

Eight deliberate changes to the real production owners each failed exactly one retained keeper at its intended assertion. Each owner was restored byte for byte in `finally` before the next run.

| Deliberate owner regression | Failed observation |
| --- | --- |
| Omit atomic runtime-file publication | Exact persisted runtime object: null instead of the written object. |
| Seed an absent destination without the Codex opt-in flag | Default call: exit 10 instead of 20. |
| Keep an absent destination despite the Codex opt-in flag | Seed call: exit 20 instead of 10. |
| Erase the decoded Grok ISO expiry | ISO row: exit 20 instead of 10. |
| Write the wrong identity to the company default home | Actual stored account ID differs. |
| Return the wrong account ID after real promotion | Migrated result account ID differs. |
| Return the wrong account-home path after real promotion | Migrated exact result path differs. |
| Report false after first account-home creation | Migrated creation receipt is false instead of true. |

Name-filtered mutation runs skip the unrelated cases in their complete owner file. Those intentional filter skips are separate from the four complete-file controls, which have zero skips. The harness counts one failed case, rather than assuming Vitest's nested suite count equals one. No timeout, mock result, fixture receipt or setup error supplies a mutation failure.

[The adjacent controls record](2026-10-12-test-audit-r12-runtime-auth-controls.json) retains exact original/candidate test hashes, restored owner hashes, run/log digests, production edits and actual failing keeper assertions. Compile, build and current-head CI/review results are reported separately on the draft PR.
