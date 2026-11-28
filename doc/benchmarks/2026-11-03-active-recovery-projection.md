# Active recovery current-wait projection

An active recovery check needs a current durable-wait reason. It previously built the full seven-query retry fingerprint state for every admitted source action. This change reads the three needed existence facts in one statement. The full fingerprint collector keeps all of its inputs. Both readers use the same reason policy. Child checks, outside-action run/wake checks, native safety holds and mutation services stay in place.

## Local evidence

Baseline: `a497bae83a128feae8206f27e4930e6407a67630`. Node24.22.2, macOS arm64, source Vitest and disposable PostgreSQL. The actual `recoveryService.reconcileActiveRecoveryActions` ran against synthetic cohorts with mostly empty wait facts, approximately75%board and25%legacy agent recovery owners. A second company's records stayed unchanged. The live company/owner/cohort mix is unknown.

Nine alternating pairs per cohort follow three warmup pairs. The timed database client has no SQL debug or row-transform observer. Count proof uses separate warmed clients outside timing. Node process CPU includes JIT/GC/driver work and excludes PostgreSQL process CPU. The [data file](2026-11-03-active-recovery-projection.json) contains all72retained primary timing samples, independent count proof and raw-file hashes.

| Actions | CPU median before → after (ms) | CPU paired wins | Wall median before → after (ms) | Application queries before → after |
|---:|---:|---:|---:|---:|
|1|1.378 →0.763|8/9|1.421 →1.049|11 →5|
|8|7.091 →2.886|9/9|6.614 →3.829|81 →33|
|32|21.922 →8.374|9/9|21.539 →12.686|321 →129|
|100|68.384 →32.718|9/9|68.019 →40.327|1001 →401|

All nine wall pairs improve at8/32/100. CPU ranges at8 are[6.110,20.971]before and[2.181,6.001]after; at32,[17.255,36.617]and[7.363,9.651]; at100,[60.393,74.871]and[22.194,37.502]. Size1is noisy. Driver rows rise from N to2N because each EXISTS statement returns one boolean row. This is reduced query construction/dispatch and unused fingerprint work, not reduced returned rows.

The source-consistent census pattern suggests about162outer action checks/30s, but that caller partition is unproven and was observed only3m19safter startup readiness. Scaling the local per-action difference to that assumed mix would yield only a few milliseconds CPU/s. It is not measured fleet savings, a hard ceiling, or a deployed improvement. No request latency, production-build, Sentry or OTLP result is claimed.

## Correctness

The real-service proof preserves exact results, action/issue/wake/activity/comment records and queue notifications between baseline and treatment on the same fixture. Relation edges preserve exact semantic fields; generated edge IDs and timestamps are excluded from that comparison. Mixed controls cover user/blocker/monitor/execution/interaction/approval reason priority, board ownership, same-action versus outside run paths, healthy children and native reconciliation holds. Full retry fingerprints match the pinned collector on fresh mixed issue inputs.

A deterministic gate pauses after the source cohort read and before the new statement. An independent client then commits a pending interaction. The check sees that fact. A second case also resolves the action independently; the existing conditional mutation preserves that decision. These tests prove fresh query facts and the current action update guard. They do not make a single statement's snapshot identical to seven concurrent statement snapshots. Scalar issue fields still come from the source cohort read.

Permanent PostgreSQL regressions live in `server/src/__tests__/recovery-durable-wait-projection.test.ts`.

## Reproduce in an isolated checkout

Use installed dependencies and Node24.11or newer. Keep CPU measurement exclusive. The manual helper creates a unique evidence directory, materializes the pinned baseline and fixture, and removes only its own temporary source files afterward. It refuses existing temporary paths. It does not run in the default test suite.

```sh
node scripts/benchmark-active-recovery-projection.mjs --baseline-ref=a497bae83a128feae8206f27e4930e6407a67630
```

For only count and correctness proof, with all four timing tests excluded:

```sh
node scripts/benchmark-active-recovery-projection.mjs --baseline-ref=a497bae83a128feae8206f27e4930e6407a67630 --proof-only
```

An optional `--evidence-dir=/absolute/parent` places a unique run directory under that parent. Preserve the printed directory and command log. No external provider is called.

## Evidence incident and limits

The first observer-free run had an exclusive team timing reservation and passed all seven controls. Its aggregate summary and log remain, but a later harness error overwrote its raw samples. Those original samples are lost and are not reconstructed or pooled into the table above.

An intended untimed proof edit failed because it used a root-relative file path from the server directory. The shell then ran the unchanged timing fixture. The resulting unintended repeat is the separately retained primary raw evidence above. It had no renewed quiet reservation; unrelated system activity cannot be excluded. The direction and ranges support the same local conclusion as the earlier summary, but this provenance limit remains. No third CPU run was made. The corrected proof used a verified explicit test filter:7passed,4timing tests skipped, all count-proof sample arrays empty. Initial count clients included PostgreSQL type discovery; those counts were superseded by the separate warmed count proof shown above.

The reproducible helper now creates a unique run directory. Edit, validation and execution were separated for the corrected proof. This change has not been deployed. Serving CPU and real workload acceptance remain separate follow-up work.
