# Prospective native event ingestion source protocol

Status: source implementation and local source checks only. No source workload, VM measurement, application build or accepted measurement series is authorized by this document. Root owns VM operations. After read-only review, the first measurement step is exactly one bounded, ineligible `--quick --phase=aa` qualification at 1,000 ordered retained events. A full series requires explicit ROOT RELEASE after that qualification and its evidence have been reviewed. Never start another fixture while cleanup is unresolved.

The complete earlier monolithic A/A experiment failed the unchanged 20% maximum paired-difference / 10% median-arm-drift noise gates. Its failures remain evidence. This prospective schedule changes the source estimand and gets a new source hash and workload hash; it neither removes those failures nor retroactively qualifies their timings. The old harness/report identified by SHA-256 `48e967a5e7a8c803ff3bf4890a37ff70564ba1a618d83bcff5bb110b35ee8133` is provenance only. It cannot supply A/A calibration or acceptance for the new schedule.

## Frozen application references and ownership

Application refs accepted by root, not measured locally here:

- B0: `5337df423e622755d44f3ece5447d1e0beef5f40`
- B1: `e9b909015ad3d517f28c45f0c66c8f41d6112b4b`
- B2: `fcb5d94848b3c4b0b32096ff5e023618e0f0637b`

The source harness is `scripts/benchmark-native-event-ingestion-interleaved.ts`. The original `scripts/benchmark-native-event-ingestion.ts` and `scripts/native-ingestion-performance-gates.mjs` stay untouched. The gate helper must retain SHA-256 `ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc`; the new harness asserts it before any DB workload.

The harness owns only synthetic companies/agents/runs/events and its private baseline source snapshot. Root owns the selected frozen app checkout, its dependency/build identity, VM access, fixture sequence and release decisions. No production source changes, app builds, measurement execution or VM calls were part of implementation.

## Schedule and preserved workload

Full matrix: retained histories 1,000 / 10,000 / 100,000, with ordered / replay / late-gap / warm-suffix scenarios. Seed, 128-byte text, source identities, payload shape, source offset, generator order and vacuum/analyze preparation are inherited from the frozen harness.

For every non-late-gap case, prepare two independent fixtures at the same retained history, then run the original two warmups of 512 attempts per arm. Warmups remain monolithic, excluded from measured samples and logged separately. Five measured pairs follow. Each pair contains eight corresponding blocks per arm; each block emits exactly two original generator groups of 32 attempts (64 total). The order is:

- Pair 0, 2, 4: B64, C64, B64, C64, repeated until both arms reach 512 attempts.
- Pair 1, 3: C64, B64, C64, B64, repeated until both arms reach 512 attempts.

The first arm is fixed within a pair and alternates between pairs. There are no deliberate timer delays, retries, discarded blocks, outlier exclusions or reduced counts. Each corresponding block starts at the same retained history. The generator's `next` advances without gaps and is continuous across blocks. Ordered and warm-suffix samples commit exactly 512 new events. Replay preserves each original 16-new/16-replay group, yielding exactly 256 new and 256 duplicate attempts per 512-attempt arm sample.

Late-gap retains a fresh fixture and one operation per arm per pair, no warmups, five complete pairs, and structural-only latency treatment. Candidate batch invocation never exceeds 64 events or the inherited 64-KiB canonical-payload cap. Ordinary compare and A/A continue invoking individual appends.

Mandatory qualification uses `--quick --phase=aa`: only 1,000 ordered history, still 16×32 attempts, two warmups per arm and five measured pairs. It is explicitly ineligible for repeatability or performance acceptance. Event/group/pair/history CLI overrides that reduce or change the frozen design are rejected. Quick is not a route to relaxed gates.

## Estimand, timing boundaries and precision

The comparison sample is the sum of eight per-arm ACTIVE append intervals. Wall time includes `invoke()` and its append receipt checks; it excludes generator work, independent durable verification, backend CPU probes, trace writes and inter-arm gaps. Per-arm process and database CPU observations are summed over corresponding block observation windows. This estimand is source service cost under the stated interleaving, not assembled application burst completion, browser delivery latency, provider throughput, or hosted performance acceptance.

For every measured block retain arm, scenario, seeded history, actual retained history before/after, `next` before/after, attempted/new/duplicate counts, active start/end/duration, process CPU, database CPU, memory, event-loop observations, and independent verification duration. Host commit observations are recorded when committed append receipts resolve. A batch acknowledges its committed receipts together; these are not individual database commit timestamps.

Each measured pair additionally records whole elapsed time from pair-plan bookkeeping through final independent durable verification; per-arm first-append-to-last-commit and first-to-last-observed-commit wall time; active wall sums; block verification sums; final verification time; trace write time; and the residual `bookkeepingAndGapMillis`. That residual explicitly includes generator work, CPU probes, trace I/O, aggregation overhead within the pair and inter-arm gaps. The final `pair-complete` trace write and later scenario SQL/plan diagnostics are outside whole-pair time and remain within total trace/execution accounting.

Append promises resolve after commit, with no asynchronous source queue. The final independent drain/verification is a separately timed read of durable row count, run sequence extent, source identities, payload hashes and payloads for the entire arm's attempted sample. It does not claim browser or application delivery drained.

Linux PostgreSQL CPU comes from `/proc/PID/stat` clock ticks using the runtime `CLK_TCK`. Typical per-block resolution is 10 ms. Eight block differences have worst aggregate quantization of eight ticks (typically 80 ms); retain raw tick-quantized observations and avoid sub-tick precision claims. A single late-gap sample has one interval. Heap deltas, RSS, process CPU and event-loop observations describe a shared process; heap delta is not owned allocation or a reliable allocation-efficiency estimate.

## Correctness, SQL diagnostics, evidence and cleanup

All original append receipt checks, independent durable identity/payload/count checks, SQL capture, EXPLAIN plan handling, cursor structural bounds, and cleanup logic remain. Verification operates after each 64-attempt block and once again over the complete pair's arm sample. No mutation is rerun for profiling. Ready projections must have no retained-history sequential scans, no aggregate fallback and at most the original 64 examined rows on analyzed retained-history read nodes. Late-gap remains structural-only.

`--output` is mandatory. Both summary and `--trace-output` paths must be outside the frozen app; defaults use `<output>.blocks.jsonl`. Outputs must be new paths. A new append-only JSONL file is exclusively created, with a complete pair block plan persisted before that pair's first append. Each start/completion/failure is appended. Planned blocks lacking a start are unstarted evidence; a started block lacking completion is interrupted evidence. Append failures retain observed duration/commit bounds before rethrowing. A failed run stays incomplete and cannot qualify. The trace is never rewritten from a growing in-memory array on each block. Scenario summaries can be rewritten separately, with the append-only trace authoritative for interrupted work.

All owned DB clients and embedded clusters/private source snapshots are cleaned up in `finally`. An explicitly supplied disposable localhost DB removes only owned event rows, runs, agents and companies in the inherited order. The summary and append-only trace retain cleanup status. Cleanup must complete before another fixture starts. External supplied URLs must pass the inherited disposable-database helper and localhost restriction.

## Private execution and source provenance

Copy the exact public `.ts` bytes to a private `.mts` path outside APP_ROOT. The extension is mandatory because an external `.ts` without a module package context can be transpiled as CommonJS and reject top-level await. `--app-root=<frozen-app>` controls Git, `createRequire`, DB/client/work-signals imports, canonical hashing, external-test-database helper, acceptance gates and candidate service imports. Static relative imports are erased types only. The measurement records its actual executing file path and SHA separately from the original harness's provenance hash.

Baseline service snapshots live under a private temporary directory with its own `package.json` containing `type: module`. Baseline relative imports select corresponding snapshot files when present and otherwise explicit APP_ROOT support paths. Original bare imports remain unchanged and retain normal ESM package conditions. Only the disposable private snapshot gets a `server/node_modules` symlink to `APP_ROOT/server/node_modules`, preserving the same dependency instances and export conditions as the candidate. No dependency link or file is installed in the frozen app. The harness itself uses an APP_ROOT-based `createRequire` for its inherited diagnostics dependency resolution. The compatible migrated APP_ROOT DB schema/client and unchanged support modules intentionally support both arms, as in the original source harness. This source-only shared-support provenance is explicit; it does not claim an independent application artifact per arm.

`candidateSourceHashes` hashes actual APP_ROOT service modules and schema files (plus DB/client/work-signals, canonical helper, external-DB helper and gate source), not the absent public measurement path in a frozen app. `actualSelfSha256` hashes the exact private executing measurement bytes. Report validation and noise loading require matching self hash, recomputed workload hash, exact baseline revision and unchanged gate hash. Noise loading additionally requires identical pinned baseline source bytes and a complete, eligible, passing same-workload A/A report. Report validation checks APP_ROOT supporting hashes. Old monolithic or differently copied measurement evidence cannot qualify.

## Local checks and next commands

The following are source-only checks; they do not open PostgreSQL or append synthetic events:

```sh
cp scripts/benchmark-native-event-ingestion-interleaved.ts /private/tmp/native-ingestion-interleaved.mts
node --import "$APP_ROOT/server/node_modules/tsx/dist/loader.mjs" /private/tmp/native-ingestion-interleaved.mts \
  --app-root="$APP_ROOT" --baseline-ref="$BASELINE_REVISION" --quick --phase=aa --check-source
```

Read-only review precedes the first qualification. Root chooses a new external output directory and one accepted baseline ref, ensures the VM is quiet and all prior fixture resources are cleaned, then runs exactly one bounded quick A/A qualification using the same command without `--check-source` and with `--output=<new-external-report.json>`. Do not add `--require-repeatability` to quick: the complete-matrix gate correctly rejects quick evidence. Review its complete block log, payload/order/SQL diagnostics and cleanup receipt before ROOT RELEASE.

After ROOT RELEASE, a full same-workload A/A must pass every unchanged 20% paired and 10% median drift limit on all nine timing cases, with complete late-gap structural evidence. Candidate comparisons require that exact full A/A report via `--noise-report`. Improvement cases still need the median improvement beyond the A/A envelope and at least four of five individual paired improvements beyond that envelope; 1k cases retain nonregression treatment. No threshold is loosened. Every source validation must use the same private `.mts` bytes, baseline ref and matching `--quick` status as its report. Application/browser/stop/control acceptance remains a separate required layer.

Implementation evidence (2026-11-03, local source only): the new harness SHA-256 is `c8adaf5ac16cab67513d6c8b888afa44d95fa3688d4831b8126fe3d997f1d039`. A byte-identical external `.mts` copy passed source-only execution. The focused TypeScript invocation over this harness plus the repository Express request augmentation passed without emitting or building. Thirteen synthetic source/report checks passed, including old-self/workload/baseline/gate rejection, incomplete/cleanup rejection, both excessive-noise failures and the inclusive 20%/10% gate boundary. A private ESM snapshot import check proved reference equality with APP_ROOT's actual ESM Drizzle and DB exports; no DB connection was opened. Full workload SHA-256 is `ca4894b0723d0bffff0fc88d1596d64aa8fd75aa1dd8d861372ea993db24e164`; quick workload SHA-256 is `86ccdcfbd02cc1d16bf75223337305e3c10f29ca80da3bec74db28afe0ab7cc6`. These checks are not performance measurements or qualification evidence. No VM workload, full build or performance series ran during implementation.
