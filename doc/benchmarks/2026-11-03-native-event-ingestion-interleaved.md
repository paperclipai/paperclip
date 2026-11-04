# Interleaved append-service measurements (2026-11-03)

The fresh source-layer B0 A/A passed the unchanged noise gates, followed by a passing B0→B1 cursor comparison. At 10k histories, median active append cost falls about **16–22%**; at 100k, about **56–60%**. Every required long-history case beats its observed A/A noise in **5/5 individual pairs**. This measures the real append service and PostgreSQL under the preregistered interleaving. It does not establish application burst completion, browser delivery, batching performance, or production improvement. The remaining source and application gates are pending; the full task is not complete.

## What was measured

The frozen SOURCE refs are B0 `5337df423e622755d44f3ece5447d1e0beef5f40`, B1 `e9b909015ad3d517f28c45f0c66c8f41d6112b4b`, and B2 `fcb5d94848b3c4b0b32096ff5e023618e0f0637b`. Only B0 A/A and B0→B1 are reported here. The separate latest production-built APP refs are B0 `a36567f9fbf805ad72207d54f539516e3121741e`, B1 `d8cd3be0aeed4f9fb93ecc3cf725f1d46d5a0310`, and B2 `914129afb141d81c0d6d8c5f0ea11c20bd69a3da`. Source-layer results are not relabelled as measurements of those entire applications.

The [prospective protocol](native-event-ingestion-2026-11-03/interleaved-source/prospective-protocol.md) was frozen before the new samples: protocol SHA256 `302c11ec61d5170822c08e47f798ca582b8e5afefd9d223fb9023d9ead7a2ad3`, measurement SHA256 `c8adaf5ac16cab67513d6c8b888afa44d95fa3688d4831b8126fe3d997f1d039`, workload SHA256 `ca4894b0723d0bffff0fc88d1596d64aa8fd75aa1dd8d861372ea993db24e164`, and unchanged gate SHA256 `ded8bcbb8f05732348f6520b9c5e41b7c35bc098997eb263a9dcb174eede75fc`. The archived protocol's initial source-only status predates the separately recorded [full release](native-event-ingestion-2026-11-03/interleaved-source/full-release.md) and execution receipts.

Each ordinary measured arm sample contains eight interleaved blocks of 64 attempts: 512 attempts total, retaining the original 16 groups of 32 and payloads. The first arm alternates across five pairs. Two monolithic 512-attempt warmups per arm remain excluded. Ordered/warm-suffix samples insert 512 new events; **mixed replay samples insert 256 new events and reuse 256 exact duplicates**. Duplicate receipts allocate nothing. Histories and source sequences are matched at corresponding blocks, with independent identity/payload/count verification after every block and over the complete arm sample.

The estimand is the **sum of an arm's active append intervals**, including receipt checks and excluding generation, CPU probes, verification, trace writes and inter-arm gaps. It is not the wall time from emitting a burst through final application drainage. Raw reports separately preserve whole-pair elapsed time, first/last observed commit bounds, independent final verification, and bookkeeping gaps. There is no asynchronous source queue in this closed-loop experiment.

Both full reports contain 12 cases and 60 complete pairs, with 750 started/completed measured blocks, 120 final arm-verification starts and one cleanup-complete record. Each report contains 46,110 measured append attempts across both arms, including 30 single-operation late-gap attempts, plus 18,432 excluded warmup attempts. The dedicated quiet Linux host recorded Node 26.4.0, 16 CPUs, PostgreSQL 18.1, shared_buffers 128MB, work_mem 4MB and JIT on. Exact environment and commands are in the raw reports; unprofiled acceptance intervals were separate from SQL/plan diagnostics and builds.

## Cursor cost and repeatability

Values are median **active milliseconds per 512 attempts**, followed by observed min–max across five samples. Reduction is computed from the two arm medians. This is not an individual-event tail-latency distribution.

| Seeded history / case | B0 median [min–max] ms | B1 median [min–max] ms | Reduction | Pairs beyond noise | A/A envelope |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 / ordered | 3823.2 [3660.2–3890.5] | 3554.4 [3522.7–3603.7] | 7.03% | 5/5 | 1.408% |
| 1,000 / replay | 3164.5 [3069.6–3184.9] | 3002.7 [2943.1–3046.2] | 5.11% | 3/5 | 3.982% |
| 1,000 / warm-suffix | 4152.8 [3944.3–4267.0] | 3542.4 [3468.8–3605.4] | 14.70% | 5/5 | 1.884% |
| 10,000 / ordered | 4209.6 [4049.1–4255.4] | 3530.6 [3528.6–3597.9] | 16.13% | 5/5 | 1.747% |
| 10,000 / replay | 3575.6 [3542.3–3624.2] | 3016.3 [2948.3–3071.0] | 15.64% | 5/5 | 1.630% |
| 10,000 / warm-suffix | 4614.0 [4464.4–4736.5] | 3592.8 [3571.8–3615.2] | 22.13% | 5/5 | 11.830% |
| 100,000 / ordered | 8029.2 [7985.5–8157.3] | 3540.0 [3503.1–3586.7] | 55.91% | 5/5 | 1.069% |
| 100,000 / replay | 7456.0 [7350.1–7471.5] | 2989.0 [2938.5–3000.5] | 59.91% | 5/5 | 0.933% |
| 100,000 / warm-suffix | 8347.4 [7836.9–8611.9] | 3402.4 [3119.4–3627.9] | 59.24% | 5/5 | 0.762% |

All nine A/A timing cases met maximum paired relative difference ≤20% and median arm drift ≤10%; their largest observed values were 11.830% and 6.133%. Every required 10k/100k case passes both the median and individual-pair improvement requirements. The 1k cases pass nonregression. In particular, 1k mixed replay has only 3/5 pairs beyond noise, so it does not meet the four-pair improvement requirement. The [summary](native-event-ingestion-2026-11-03/interleaved-source/summary.json) retains all comparisons and sample counts.

A separately seeded SQL diagnostic at 100k ordered history records a baseline retained-history scan of 100,032 entries versus a one-row retained-event identity lookup and bounded projection work for B1. All candidate structural guards pass. SQL calls/attempt remain 5→5 ordered and 4→4 mixed replay; warm suffix falls 6→5. Transactions remain one per attempt. These counts describe the separate diagnostic workload; fewer calls alone are not the performance result.

For 100k ordered samples, descriptive median backend CPU is 10.332→1.719 ms/attempt and owner-process CPU is 1.960→1.839 ms/attempt. CPU is not a separately qualified improvement gate here. Linux backend observations are tick-quantized at 10ms per block; an eight-block sum can carry up to 80ms aggregate quantization uncertainty. Owner CPU and memory describe the shared benchmark process, excluding an assembled server, Rust Runner, browser and external load driver. Heap deltas do not identify owned allocations or establish allocation efficiency. The separate 32-transaction SQL diagnostic records median lock-held-through-commit intervals of 14.17→5.89ms; acquisition query duration includes network/row-read work and is not pure lock wait.

Late-gap closure remains a five-pair **single-operation structural diagnostic**, outside the preregistered latency gate. Its 1k median rises 7.403→9.507ms (**+2.10ms**), and its 10k median rises 7.701→8.573ms (**+0.87ms**). At 100k it falls 24.455→9.347ms. These tradeoffs remain visible; single operations and five samples establish no tail-latency claim.

## Source attribution and its limits

[Immutable source comparisons](native-event-ingestion-2026-11-03/interleaved-source/source-app-core-equivalence.json) verify the selected append/allocator/cursor/port/collector, heartbeat event schema, canonical/lossless codec, DB client and work-signal paths between each frozen SOURCE and its corresponding APP ref. The [four-table snapshot receipt](native-event-ingestion-2026-11-03/interleaved-source/upstream-table-snapshot-equality.json) records unchanged event/cursor/range/run tables in the normal upstream merge. Static locked-graph checks for [B1](native-event-ingestion-2026-11-03/interleaved-source/source-b1-app-b1-dependency-graph.json) and [B2](native-event-ingestion-2026-11-03/interleaved-source/source-b2-app-b2-dependency-graph.json) find 28/28 DB runtime nodes, 14/14 pg nodes and 29/29 tsx-launcher nodes identical, including package-integrity/snapshot entries. drizzle-kit 0.31.10→0.31.11 and its one-run get-tsconfig development-tool edge are outside those graphs.

This is **selected core and runtime-DB-graph equality**, not whole application or whole transitive-closure equality. Extra vendor-index exports, Runner Codex diagnostics and ACPX environment/Claude-key handling differ outside that selection. The new run-log wrapper, native executor/finalizer and Rust changes require separate application and Stop qualification. Installed bits, OS and build provenance remain separate evidence. The source harness intentionally uses a compatible migrated APP_ROOT schema/client and unchanged support dependencies for both service arms; it does not create independently built whole applications per arm.

The [earlier complete monolithic A/A](native-event-ingestion-2026-11-03/interleaved-source/excluded-monolithic-service-aa-b0.json.gz), SHA256 `cfcfeb3c12812dbe48c2afe6013320922d5670a410d033d6ad9a3a2f91236ef8`, failed the unchanged noise gates and remains excluded. No candidate used it as calibration. The prospective interleaved design changes the source estimand and therefore starts a new same-workload A/A; it does not turn that failure into a pass. No specific warmup or host cause is established by the subsequent passing experiment.

## Reproduce and inspect

All raw reports and append-only traces are deterministic gzip files under [interleaved-source](native-event-ingestion-2026-11-03/interleaved-source/manifest.json). The manifest records compressed and exact decompressed hashes. The executed command receipts, repeatability result, release and quiet-return receipt are retained. `gzip -dc FILE.gz` restores the original report/trace bytes. Historical absolute Linux paths in those exact raw receipts are disposable task-owned fixture paths; no private account/credential metadata is published.

Use a quiet disposable Linux host with Node 26.4.0 and independently install the frozen SOURCE_B1 checkout's locked dependencies (`pnpm install --frozen-lockfile`). The benchmark starts and cleans up its own embedded PostgreSQL when `PAPERCLIP_EVENT_INGESTION_BENCHMARK_DATABASE_URL` is unset. A supplied database must be disposable, loopback-only and named with the `_test` suffix; migrations and fixtures run there. Select that exact checkout as `SOURCE_B1_ROOT`; `TOOLS_ROOT` contains the current public helper. The measurement file must be copied byte-for-byte **outside** APP_ROOT with an `.mts` extension, preserving ESM execution. Never run builds, profilers or other workloads concurrently. Use new external output paths for each experiment:

```sh
# Set absolute paths; EXPERIMENT_DIR must be a new external evidence directory.
mkdir "$EXPERIMENT_DIR"
unset PAPERCLIP_EVENT_INGESTION_BENCHMARK_DATABASE_URL
cp "$TOOLS_ROOT/scripts/benchmark-native-event-ingestion-interleaved.ts" "$EXPERIMENT_DIR/measurement.mts"
sha256sum "$EXPERIMENT_DIR/measurement.mts"

# First qualify a new host/harness. Quick evidence cannot establish full acceptance.
node --import "$SOURCE_B1_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B1_ROOT" --baseline-ref=5337df423e622755d44f3ece5447d1e0beef5f40 \
  --quick --phase=aa --output="$EXPERIMENT_DIR/quick.json"

# Review qualification and cleanup, then run a fresh full A/A and comparison.
node --import "$SOURCE_B1_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B1_ROOT" --baseline-ref=5337df423e622755d44f3ece5447d1e0beef5f40 \
  --phase=aa --output="$EXPERIMENT_DIR/service-aa-b0.json" --require-repeatability
node --import "$SOURCE_B1_ROOT/server/node_modules/tsx/dist/loader.mjs" "$EXPERIMENT_DIR/measurement.mts" \
  --app-root="$SOURCE_B1_ROOT" --baseline-ref=5337df423e622755d44f3ece5447d1e0beef5f40 \
  --phase=compare --noise-report="$EXPERIMENT_DIR/service-aa-b0.json" \
  --output="$EXPERIMENT_DIR/service-b0-b1.json" --require-acceptance
```

The designated immutable SOURCE tags are `native-ingestion-benchmark-2026-11-03-fixture2-{b0,b1,b2}`; APP tags are `native-ingestion-benchmark-2026-11-03-ce33-{b0,b1,b2}`. Resolve them to the exact full commits above before running; their names do not replace commit verification. The pinned SOURCE_B1 root must be `e9b909015ad3d517f28c45f0c66c8f41d6112b4b`, not a newer delivery checkout. The gates remain the unchanged published module. Source-only validation uses the same command with `--check-source`; report validation uses `--validate-report=REPORT` and the matching phase, baseline and exact measurement/source bytes. The [dependency helper](native-event-ingestion-2026-11-03/interleaved-source/compare-runtime-dependencies.cjs) accepts repository, immutable before/after refs and a new output JSON path; its path/role-label-only adaptation is separately declared. It reads Git and the locked yaml parser without launching a database.

B1 A/A, incremental B1→B2 and combined B0→B2 source measurements, application/browser comparisons, batching/control responsiveness gates and final delivery checks remain separate. Nothing in this source report establishes completion of the full ingestion plan or a deployed-production gain.
