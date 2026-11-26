# Telemetry client contract test consolidation

Date: 2026-10-13. Baseline commit: `9b4d0cd872ca1fc897f320cb181fc060f0bd5bf1`.

## Scope and keeper map

Retire only `packages/shared/src/telemetry/client-contract.test.ts` after moving its unique assertions into the complete owner suite, `packages/shared/src/telemetry/client.test.ts`.

| Retired contract case | Surviving owner keeper and protected regression |
| --- | --- |
| `emits only allow-set keys with schemaVersion '1' on every POST` | The count-split keeper now checks every envelope key against `CONTRACT_KEYS` (`app`, `schemaVersion`, `installId`, `version`, `events`, `batchId`) and every envelope's schema version against `"1"`. Extra wire fields and wrong schema versions remain detectable. |
| `never exceeds the injected maxEventsPerBatch on any POST` | `splits more than maxEventsPerBatch events into multiple compliant POSTs` retains the injected count cap of 2 and exact `[2, 2, 1]` distribution for five queued events. Count violations and event loss remain detectable. |
| `never exceeds the injected maxBodyBytes on any POST` | `splits a chunk whose serialized bytes exceed maxBodyBytes` retains the injected 900-byte cap and checks every raw POST body. It now also requires exactly six aggregate events, protecting against loss during byte splitting. |
| `a large flush splits into N envelopes that are each count- and byte-compliant` | The count-split keeper now injects `maxBodyBytes = 4096` and checks every raw POST body against that same injected limit, alongside the count cap and exact five-event distribution. |
| `retries a 429 and re-sends the identical batchId (server idempotency)` | `retries a 429 with the same batchId and eventually succeeds` now compares the retry's events with the original events, alongside equal batch IDs and exactly two attempts. Retry event remixing remains detectable. |
| `does not retry a terminal 400 or 413` | The separate owner cases `does not retry a terminal 400` and `does not retry a terminal 413` remain unchanged. |
| `derives a different batchId for the same events under a different installId` | The same-named owner case remains unchanged with the clock frozen across clients, isolating install identity from timestamp differences. |
| `emits a batchId of at least 32 hex chars — 128-bit collision floor` | `emits a batchId of at least 32 hex chars (128-bit collision floor)` retains both the minimum length and lowercase hexadecimal format checks. |

The remaining owner controls for event registration, dynamic events, configuration, oversized/circular events, backoff, endpoint fallback and retry-store bounds are unchanged. No production code or generated telemetry contract changed; no runtime behavior changed. The generated contract was checked first and remains byte-identical because no event names, dimensions, or schema version changed. The telemetry README now records `client.test.ts` as the durable owner for transport contract assertions.

## Privacy review

Independent review of this change found no production telemetry client, event, config, type, generated-contract, retention, or payload construction changes. Event names, dimensions, schema version, identity and privacy transforms, destination, opt-out behavior, and retention remain unchanged. The tests use the existing localhost endpoint and stubbed fetch; the assertions preserve the wire allow-set, schema version, count/byte limits, and retry payload boundaries. Privacy impact: none in emitted behavior.

## Exact reduction

- Candidate file removed: **205 lines**, **8 `it` declarations**, **3 `describe` declarations**, and one Vitest test-file isolation unit.
- Owner additions: 15 lines added and 1 replaced line removed, for 14 net owner lines added. No owner test declaration was added or removed.
- Combined telemetry test diff: **15 added / 206 removed**, or **191 net test lines removed**.
- Telemetry cases: **33 before / 25 after**. The separately consolidated access suite accounts for the other case removed from the combined focused run.
- These are case, file and source-line reductions. No CI time saving was measured or claimed.

## Reproducible verification

Commands ran from `/private/tmp/paperclip-test-audit-pr-stack`, using the root Vitest project configuration and the package-shared project. Both commands ran complete files without a test-name filter.

Baseline:

```sh
node_modules/.bin/vitest run --project @paperclipai/shared packages/shared/src/telemetry/client.test.ts packages/shared/src/telemetry/client-contract.test.ts packages/shared/src/validators/access.test.ts
```

Result: **3 files passed, 53 cases passed**, zero failed/skipped/todo; Vitest duration **214 ms** (start 08:15:17).

Candidate, after both consolidations:

```sh
node_modules/.bin/vitest run --project @paperclipai/shared packages/shared/src/telemetry/client.test.ts packages/shared/src/validators/access.test.ts
```

Result: **2 files passed, 44 cases passed**, zero failed/skipped/todo; Vitest duration **214 ms** (start 08:15:50). The telemetry owner has 25 surviving cases; access has 19.

Both runs emitted the existing Vite native-config warning about `__dirname`; neither run failed. `git diff --check` passes. No production mutation experiment was run. Repo-wide typecheck, tests, build and CI were not run for this focused consolidation; this receipt does not claim PR readiness.
