# Incremental batching append-service measurements (2026-11-03)

All five SOURCE stages pass their unchanged gates: B0 A/A, cursor B0→B1, B1 A/A, batching B1→B2 and combined B0→B2. Incremental batching reduces median **active source append cost by 95.81–96.73%** across nine ordinary cases; the combined B0→B2 reduction at 10k/100k histories is **96.48–98.62%**. Every required long-history case has five of five individual paired improvements beyond its corresponding noise envelope. These are real append-service/PostgreSQL results. Both full H4c application attempts missed the original 120-second streaming deadline, so no application A/A or application/browser gain is accepted. H5 is prospective and unexecuted. The full ingestion plan remains incomplete.

## Protocol and measured work

Frozen SOURCE B0 is `5337df423e622755d44f3ece5447d1e0beef5f40`; SOURCE B1 is `e9b909015ad3d517f28c45f0c66c8f41d6112b4b`; SOURCE B2 is `fcb5d94848b3c4b0b32096ff5e023618e0f0637b`. The designated immutable tags are `native-ingestion-benchmark-2026-11-03-fixture2-{b0,b1,b2}`; resolve them to these exact commits. B1 A/A runs both service arms from B1 while using B2's compatible migrated schema/client/support root. The raw A/A therefore correctly records B2 as its support checkout and B1 as its effective candidate service. B1→B2 and B0→B2 use that same support root with the changed event owner. The B0→B1 pair uses the B1 support root, as documented in PR1.

The [PR1 source report](2026-11-03-native-event-ingestion-interleaved.md) owns the common [prospective protocol](native-event-ingestion-2026-11-03/interleaved-source/prospective-protocol.md), [exact measurement source](native-event-ingestion-2026-11-03/interleaved-source/measurement-source.ts), [unchanged gates](native-event-ingestion-2026-11-03/interleaved-source/gates.mjs), release and bounded source/runtime-DB-graph equivalence evidence. Their SHA256 identities remain protocol `302c11ec61d5170822c08e47f798ca582b8e5afefd9d223fb9023d9ead7a2ad3`, measurement `c8adaf5ac16cab67513d6c8b888afa44d95fa3688d4831b8126fe3d997f1d039`, gates `ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc`, and workload `ca4894b0723d0bffff0fc88d1596d64aa8fd75aa1dd8d861372ea993db24e164`. These are source-layer comparisons, not measurements of the separate ce33 APP builds B1 `d8cd3be0aeed4f9fb93ecc3cf725f1d46d5a0310` and B2 `914129afb141d81c0d6d8c5f0ea11c20bd69a3da` or their complete dependency closures.

An ordinary arm sample has **eight interleaved 64-attempt blocks, 512 attempts total**, preserving 16 generation groups of 32 and identical payloads. The starting arm alternates over five pairs. Two monolithic 512-attempt warmups per arm and case are excluded. Ordered and warm-suffix samples commit 512 new events; **mixed replay commits 256 new events and reuses 256 exact duplicates**. The baseline appends singletons. The timed candidate submits each ready 64-event block through the real bulk owner API; all fixed envelopes fit within 64 KiB. This direct-owner fixture does not measure the application collector's formation of batches, sparse arrivals or cancellation behavior.

The estimand is each arm's **sum of active append intervals**, including returned-receipt checks and excluding event generation, CPU probes, trace writes, independent verification and inter-arm gaps. The closed-loop source experiment has no asynchronous upstream queue. It records whole-pair time, commit observations and independent durable verification, but active sums cannot substitute for emission-through-final-drainage burst completion. Every block and complete arm independently checks identities, payloads, counts, sequence allocation and cursor receipts.

Each of the five reports contains 12 cases, 60 complete pairs, 750 completed measured blocks, 120 final arm-verification starts and complete owned-resource cleanup. Each has 46,110 measured append attempts across both arms (including 30 single-operation late-gap attempts), plus 18,432 excluded warmup attempts. The quiet Linux host reports Node 26.4.0, x64, 16 CPUs and PostgreSQL 18.1 with shared_buffers 128MB, work_mem 4MB and JIT on. SQL/plan diagnostics run outside the unprofiled acceptance intervals; quiet receipts and full traces are retained in the [manifest](native-event-ingestion-2026-11-03/batching-source/manifest.json).

## Baseline, cursor and batching: separate paired series

The table compares **three independently measured two-arm series**. Each row's left/right medians and observed min–max come from that series' own five alternating pairs; the B0/B1/B2 numbers are deliberately not collapsed into one shared three-arm run. Absolute and percentage reductions use those arm medians. Values are **active milliseconds per 512 attempts**. These aggregate samples do not establish individual-event p95/p99 or another tail distribution. Full case values are auditable in [paired-series-table.json](native-event-ingestion-2026-11-03/batching-source/paired-series-table.json); the B0→B1 raw reports remain linked from PR1 rather than duplicated here.

| History / case | Paired series | Left median [min–max] ms | Right median [min–max] ms | Reduction ms | Reduction | Pairs beyond noise | A/A envelope | Samples/arm |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / ordered | B0→B1 | 3823.24 [3660.19–3890.54] | 3554.43 [3522.66–3603.66] | 268.81 | 7.03% | 5/5 | 1.408% | 5 |
| 1,000 / ordered | B1→B2 | 3640.26 [3561.99–3708.24] | 144.27 [143.33–148.56] | 3495.99 | 96.04% | 5/5 | 2.169% | 5 |
| 1,000 / ordered | B0→B2 | 4022.48 [3822.43–4120.21] | 146.23 [142.27–151.92] | 3876.25 | 96.36% | 5/5 | 1.408% | 5 |
| 1,000 / replay | B0→B1 | 3164.47 [3069.58–3184.94] | 3002.71 [2943.12–3046.23] | 161.76 | 5.11% | 3/5 | 3.982% | 5 |
| 1,000 / replay | B1→B2 | 2372.14 [1601.62–2712.74] | 86.69 [72.86–96.94] | 2285.45 | 96.35% | 5/5 | 0.975% | 5 |
| 1,000 / replay | B0→B2 | 3200.97 [3087.26–3244.23] | 99.19 [96.47–102.08] | 3101.77 | 96.90% | 5/5 | 3.982% | 5 |
| 1,000 / warm-suffix | B0→B1 | 4152.80 [3944.28–4266.96] | 3542.41 [3468.83–3605.36] | 610.39 | 14.70% | 5/5 | 1.884% | 5 |
| 1,000 / warm-suffix | B1→B2 | 3549.66 [3530.10–3569.18] | 145.08 [139.95–147.25] | 3404.58 | 95.91% | 5/5 | 1.444% | 5 |
| 1,000 / warm-suffix | B0→B2 | 4247.87 [4089.47–4276.24] | 145.32 [141.71–146.39] | 4102.55 | 96.58% | 5/5 | 1.884% | 5 |
| 10,000 / ordered | B0→B1 | 4209.65 [4049.05–4255.42] | 3530.64 [3528.65–3597.89] | 679.01 | 16.13% | 5/5 | 1.747% | 5 |
| 10,000 / ordered | B1→B2 | 3597.22 [3521.31–3622.93] | 147.48 [145.31–149.20] | 3449.74 | 95.90% | 5/5 | 1.332% | 5 |
| 10,000 / ordered | B0→B2 | 4136.77 [4054.81–4249.54] | 145.51 [141.02–147.95] | 3991.26 | 96.48% | 5/5 | 1.747% | 5 |
| 10,000 / replay | B0→B1 | 3575.64 [3542.34–3624.19] | 3016.32 [2948.33–3070.96] | 559.32 | 15.64% | 5/5 | 1.630% | 5 |
| 10,000 / replay | B1→B2 | 3041.95 [2978.76–3069.10] | 99.44 [97.92–109.85] | 2942.51 | 96.73% | 5/5 | 4.969% | 5 |
| 10,000 / replay | B0→B2 | 3531.43 [3419.01–3550.92] | 96.69 [95.37–111.48] | 3434.73 | 97.26% | 5/5 | 1.630% | 5 |
| 10,000 / warm-suffix | B0→B1 | 4614.04 [4464.44–4736.47] | 3592.81 [3571.77–3615.23] | 1021.23 | 22.13% | 5/5 | 11.830% | 5 |
| 10,000 / warm-suffix | B1→B2 | 3590.62 [3533.25–3757.47] | 142.45 [139.45–144.64] | 3448.16 | 96.03% | 5/5 | 1.204% | 5 |
| 10,000 / warm-suffix | B0→B2 | 4555.81 [4457.66–4739.21] | 144.60 [141.71–159.84] | 4411.21 | 96.83% | 5/5 | 11.830% | 5 |
| 100,000 / ordered | B0→B1 | 8029.15 [7985.54–8157.27] | 3540.05 [3503.13–3586.66] | 4489.11 | 55.91% | 5/5 | 1.069% | 5 |
| 100,000 / ordered | B1→B2 | 3525.05 [3467.82–3999.37] | 141.43 [139.77–146.35] | 3383.63 | 95.99% | 5/5 | 1.664% | 5 |
| 100,000 / ordered | B0→B2 | 8153.51 [7994.82–8191.84] | 145.65 [144.48–147.88] | 8007.86 | 98.21% | 5/5 | 1.069% | 5 |
| 100,000 / replay | B0→B1 | 7456.02 [7350.07–7471.53] | 2989.01 [2938.51–3000.53] | 4467.01 | 59.91% | 5/5 | 0.933% | 5 |
| 100,000 / replay | B1→B2 | 2955.05 [2950.27–2966.19] | 101.10 [98.16–112.01] | 2853.95 | 96.58% | 5/5 | 2.397% | 5 |
| 100,000 / replay | B0→B2 | 7557.75 [7556.41–7635.84] | 104.02 [102.19–105.07] | 7453.72 | 98.62% | 5/5 | 0.933% | 5 |
| 100,000 / warm-suffix | B0→B1 | 8347.44 [7836.92–8611.93] | 3402.36 [3119.40–3627.88] | 4945.08 | 59.24% | 5/5 | 0.762% | 5 |
| 100,000 / warm-suffix | B1→B2 | 3528.62 [3468.10–3543.50] | 147.81 [147.00–150.55] | 3380.81 | 95.81% | 5/5 | 1.039% | 5 |
| 100,000 / warm-suffix | B0→B2 | 8614.06 [8491.17–8667.97] | 151.02 [149.52–158.14] | 8463.04 | 98.25% | 5/5 | 0.762% | 5 |

Both fresh A/A calibrations pass the prospectively frozen maximum paired difference ≤20% and median arm drift ≤10%. Across nine ordinary cases, B0 A/A's maxima are 11.830% paired noise and 6.133% median drift; B1 A/A's are both 4.969%. B0→B1 uses fresh B0 noise, B1→B2 uses fresh B1 noise, and B0→B2 uses the same prospectively accepted B0 calibration required by the protocol. All three comparisons have nine accepted timing cases and three structural-only cases, with no timing gate failures. All six required 10k/100k cases in each series exceed noise in five of five individual pairs. The 1k cases pass nonregression; B0→B1 mixed replay has only three of five improvements beyond noise and is not promoted to a four-pair improvement claim.

The [summary](native-event-ingestion-2026-11-03/batching-source/summary.json), original [incremental table](native-event-ingestion-2026-11-03/batching-source/batch-result-table.json) and [combined resource attribution](native-event-ingestion-2026-11-03/batching-source/combined-resource-attribution.json) preserve case counts and provenance. Each report contains 12 cases and 60 pairs, five samples per arm and case. The comparison rows are independent series, not reused arms or a fabricated paired three-stage sample.

Late-gap closure remains a five-pair, **single-operation structural diagnostic** outside the timing acceptance gate. Retain each series' observed tradeoffs, including combined 1k **+1.428ms (+20.16%)**, rather than folding them into the ordinary batching claim:

| History | Paired series | Left median [min–max] ms | Right median [min–max] ms | Right minus left | Samples/arm |
| --- | --- | ---: | ---: | ---: | ---: |
| 1,000 | B0→B1 | 7.403 [4.524–8.067] | 9.507 [8.463–11.002] | +2.104 ms (+28.42%) | 5 |
| 1,000 | B1→B2 | 8.203 [7.508–9.030] | 9.431 [8.361–13.108] | +1.228 ms (+14.97%) | 5 |
| 1,000 | B0→B2 | 7.084 [6.530–8.550] | 8.512 [6.907–9.124] | +1.428 ms (+20.16%) | 5 |
| 10,000 | B0→B1 | 7.701 [7.188–9.012] | 8.573 [6.193–8.916] | +0.872 ms (+11.32%) | 5 |
| 10,000 | B1→B2 | 8.398 [6.995–9.333] | 8.167 [7.766–8.487] | -0.230 ms (-2.74%) | 5 |
| 10,000 | B0→B2 | 7.996 [7.774–8.851] | 8.108 [7.081–10.037] | +0.113 ms (+1.41%) | 5 |
| 100,000 | B0→B1 | 24.455 [23.453–27.684] | 9.347 [8.141–9.645] | -15.108 ms (-61.78%) | 5 |
| 100,000 | B1→B2 | 9.145 [8.317–9.639] | 9.507 [7.778–10.336] | +0.362 ms (+3.96%) | 5 |
| 100,000 | B0→B2 | 24.464 [22.097–25.089] | 9.074 [8.671–10.470] | -15.390 ms (-62.91%) | 5 |

## SQL, lock and resource attribution

The separate ordinary SQL diagnostic uses **32 attempts per arm** (late-gap uses one), not the timed sample's 512 attempts in eight 64-event blocks. It records owner prepared-query calls/attempt of 5→0.15625 for ordered/warm-suffix and 4→0.15625 for mixed replay, and transactions/attempt of 1→0.03125. Those diagnostic denominators and query lists are in the raw reports and the [resource table](native-event-ingestion-2026-11-03/batching-source/batch-resource-attribution.json). The counter wraps event-owner Drizzle `preparedQuery.execute` calls; it excludes driver-generated `BEGIN`/`COMMIT` and other wire SQL. Transactions are counted separately. Original JSON field names such as `sqlCalls` remain unchanged. These are neither all wire-SQL statement counts nor directly instrumented query/transaction counts for the timed intervals. Eight candidate bulk invocations per ordinary timed arm follow from the exact source and completed 64-attempt block trace; no timed query rate is fabricated from that fact.

For 100k ordered history, active medians fall 3525.05→141.43 ms/512 attempts. Descriptive median owner CPU falls 1785.85→103.82 µs/attempt and sampled database CPU 1.699→0.078 ms/attempt. Database CPU is tick-quantized at 10ms per block; the eight-block arm sum carries up to 80ms aggregate quantization uncertainty. These CPU values are attribution, not a separate noise-qualified acceptance gate. Owner CPU, heap deltas and RSS describe a shared harness process; they exclude an assembled server, Rust Runner, browser and external load driver. Heap deltas cannot identify owned allocations, and PostgreSQL summed RSS can double-count shared pages.

In the separate 32-attempt SQL diagnostic at 100k ordered history, median client-observed lock-held-through-commit time **per transaction rises 6.14→11.95ms**, while the diagnostic uses 32 times fewer transactions per attempt. Lock-acquisition query medians are about 0.99ms for both arms; this includes network/row-read work and is not pure lock wait. Indexed identity work examines 1→32 rows for a singleton versus that diagnostic batch and stays bounded independently of retained history; all candidate structural guards pass. Longer per-transaction hold intervals are a resource tradeoff, and these single-run diagnostics do not establish concurrent control responsiveness.

## Evidence, reproduction and remaining gates

The [bundle](native-event-ingestion-2026-11-03/batching-source/manifest.json) preserves exact raw B1 A/A, B1→B2 and B0→B2 JSON, append-only traces, quiet receipts, A/A repeatability and actual direct child-command receipts. PR1 retains the common B0 A/A and B0→B1 raw bytes. Gzip uses deterministic metadata; `gzip -dc FILE.gz` restores the original bytes, whose digests are also recorded. The exact B1→B2 and B0→B2 child-command receipts are now retained, alongside their outer launchers, completion/start/exit/quiet receipts and compressed full child logs. The portable commands below use those same measured phases, refs and noise inputs with user-supplied paths. Historical absolute Linux paths identify disposable owned fixtures and are not reproduction defaults.

Use a quiet disposable Linux host with Node 26.4.0 and the exact SOURCE B2 checkout as `SOURCE_B2_ROOT`; ensure the SOURCE B1 Git object exists there. Prepare its independent locked dependencies and normal build before the benchmark window (`pnpm install --frozen-lockfile`, then `pnpm build`). `TOOLS_ROOT` is the checkout containing the exact public helper. Copy it byte-for-byte outside APP_ROOT as `.mts`. Keep builds, profiles and competing workloads out of all measured windows. For a new combined experiment, first obtain a fresh accepted B0 A/A on the same quiet host using the PR1 reproduction instructions; the published archive is evidence, not a replacement for a new host's calibration. Set absolute paths and a new external `EXPERIMENT_DIR`:

```sh
mkdir "$EXPERIMENT_DIR"
unset PAPERCLIP_EVENT_INGESTION_BENCHMARK_DATABASE_URL
cp "$TOOLS_ROOT/scripts/benchmark-native-event-ingestion-interleaved.ts" "$EXPERIMENT_DIR/measurement.mts"
sha256sum "$EXPERIMENT_DIR/measurement.mts"

# First qualify readiness, evidence and cleanup; quick evidence is not acceptance.
node --import "$SOURCE_B2_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B2_ROOT" --baseline-ref=e9b909015ad3d517f28c45f0c66c8f41d6112b4b \
  --quick --phase=aa --output="$EXPERIMENT_DIR/quick-b1.json"

# Only after qualification, establish fresh full B1 noise and compare batching.
node --import "$SOURCE_B2_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B2_ROOT" --baseline-ref=e9b909015ad3d517f28c45f0c66c8f41d6112b4b \
  --phase=aa --output="$EXPERIMENT_DIR/service-aa-b1.json" --require-repeatability
node --import "$SOURCE_B2_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B2_ROOT" --baseline-ref=e9b909015ad3d517f28c45f0c66c8f41d6112b4b \
  --phase=batch --noise-report="$EXPERIMENT_DIR/service-aa-b1.json" \
  --output="$EXPERIMENT_DIR/service-b1-b2.json" --require-acceptance

# Combined series uses its own five new pairs and the accepted B0 A/A calibration.
# B0_NOISE_REPORT is a fresh accepted full c8ad/B0 A/A from PR1 on this host.
node --import "$SOURCE_B2_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B2_ROOT" --baseline-ref=5337df423e622755d44f3ece5447d1e0beef5f40 \
  --phase=batch --noise-report="$B0_NOISE_REPORT" \
  --output="$EXPERIMENT_DIR/service-b0-b2.json" --require-acceptance
```

The helper owns embedded PostgreSQL when the dedicated benchmark URL is unset. An explicit benchmark URL must name a disposable loopback `_test` database; migrations and fixtures run there. The unchanged gate module and exact c8ad measurement bytes are mandatory. Source-only validation adds `--check-source`; existing report validation uses `--validate-report=REPORT` with matching baseline, phase, workload and exact support source. Do not validate against a newer delivery root and relabel it the measured source.

The [earlier complete monolithic A/A](native-event-ingestion-2026-11-03/interleaved-source/excluded-monolithic-service-aa-b0.json.gz) failed unchanged noise gates and remains excluded. The PR1 report preserves its full bytes and failure interpretation. This new B1 calibration neither reuses that noise nor establishes a particular warmup/host failure cause.

**Pending:** an accepted application A/A and matched application/browser comparisons, sparse-stream immediacy, Stop/authorization/result responsiveness under load and blocked writes, remaining full-plan gates and final current-head delivery checks. Both full H4c application attempts failed the original 120-second streaming deadline; no application throughput or browser latency improvement is accepted. Earlier setup and performance failures remain retained. The H5 observation protocol is prospective and unexecuted. Current upstream disk/journal findings are diagnostics, not proof of an application fix or gain. A live-provider or Stop functional journey is separate from these performance gates. All five source stages passing does not complete the full ingestion plan or establish a deployed-production improvement.
