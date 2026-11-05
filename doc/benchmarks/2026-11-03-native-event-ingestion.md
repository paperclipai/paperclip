# Native event ingestion measurements (2026-11-03)

The tables and raw reports below are **historical** cursor service evidence at B0 `83b5f7d` and B1 `7922802f`. Fresh [interleaved cursor source measurements](2026-11-03-native-event-ingestion-interleaved.md) and the incremental/combined source series in [the batching PR](https://github.com/paperclipai/paperclip/pull/18818) now pass all five source stages: B0 A/A, B0→B1, B1 A/A, B1→B2 and B0→B2. Their estimand is active source append cost, not whole-application burst completion. The first common-base monolithic A/A failed and remains excluded; it was not silently converted into a pass. Application acceptance remains open and the full task is incomplete.

The long-history cursor/range operations are bounded; replay still performs its required indexed event identity lookup. At 100k seeded events, the separately recorded baseline plans examine about 100,000 source entries; the candidate performs a one-row identity lookup and bounded projection work. The raw reports retain the SQL and plans.

## Cursor comparison

Each ordinary sample contains **512 append attempts** (16 groups of 32). Five baseline/candidate pairs alternate order; two warmups, seeding, rebuild preparation and verification are excluded. The mixed replay case contains 256 new events and 256 exact duplicates; duplicate attempts reuse receipts and allocate nothing. The table reports median wall time per 512 attempts, not individual event latency.

| Seeded history / case | B0 ms/512 | B1 ms/512 | Change | Pairs beating noise | A/A noise | Owner query calls/attempt B0 → B1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / ordered | 3821.9 | 3602.4 | -5.74% | 0/5 | 14.603% | 5 → 5 |
| 1,000 / replay | 3115.1 | 3044.4 | -2.27% | 0/5 | 5.697% | 4 → 4 |
| 1,000 / warm-suffix | 4172.9 | 3627.0 | -13.08% | 5/5 | 2.429% | 6 → 5 |
| 10,000 / ordered | 3932.7 | 3456.0 | -12.12% | 5/5 | 3.765% | 5 → 5 |
| 10,000 / replay | 3438.1 | 2906.0 | -15.48% | 5/5 | 2.651% | 4 → 4 |
| 10,000 / warm-suffix | 4579.7 | 3588.7 | -21.64% | 5/5 | 2.376% | 6 → 5 |
| 100,000 / ordered | 7966.9 | 3564.6 | -55.26% | 5/5 | 1.261% | 5 → 5 |
| 100,000 / replay | 7417.3 | 2972.4 | -59.93% | 5/5 | 1.829% | 4 → 4 |
| 100,000 / warm-suffix | 8526.7 | 3616.2 | -57.59% | 5/5 | 1.207% | 6 → 5 |

The diagnostic counter records event-owner Drizzle `preparedQuery.execute` calls only, excluding driver-generated `BEGIN`/`COMMIT` and other wire SQL; transactions are counted separately. Historical raw JSON keeps its original `sqlCalls` field names.

All six required 10k/100k cases exceed their observed per-case A/A envelope in **5/5 individual pairs** and in the median. The 1k cases pass nonregression; 1k ordered and replay gains remain inside noise. Every A/A timing case met the preregistered maximum paired difference ≤20% and median drift ≤10%; the largest median drift was 1.791%. Both full experiments completed correctness checks and cleanup.

Transactions remain one per attempt in this cursor slice. For 100k ordered writes, median backend CPU falls from 10.215 to 1.738 ms/attempt; owner-process CPU falls from 1.958 to 1.824 ms/attempt. The backend clock has 10 ms resolution across each 512-attempt sample. Owner CPU describes the benchmark process, excluding the assembled application, Rust, Chromium and load driver.

Late gap closure is a separately seeded **one-append structural diagnostic**. Its median wall time changes +15.15% at 1k, +10.67% at 10k and −65.15% at 100k. These values disclose a small-history tradeoff; they are excluded from the preregistered latency gate and do not demonstrate a general gap-closure speedup.

## Reproduce and inspect

See [experiment commands](../../scripts/native-ingestion/README.md) and the [implementation and acceptance contract](../plans/2026-11-03-native-event-ingestion.md). Exact frozen revisions, all paired samples, sample min/max spread, CPU, SQL diagnostics, history counts and gate results are in the [machine-readable summary](2026-11-03-native-event-ingestion.json). Full original reports are retained below as deterministic gzip files:

| Original report | SHA256 of decompressed original |
| --- | --- |
| [service-aa-b0.json.gz](native-event-ingestion-2026-11-03/service-aa-b0.json.gz) | `92ae98cd5bb22b4bf1b6425150b2615d280d046c3d24ca341358847eede28fe5` |
| [service-b0-b1.json.gz](native-event-ingestion-2026-11-03/service-b0-b1.json.gz) | `11d7f4c5fcfbeab39d9b38224aa151a3cf6430bb103c4d45b847789e72cb2899` |

Use `gzip -dc <report.json.gz>` to inspect the complete original JSON. Its byte-for-byte SHA256 is recorded above and in the summary. No p99 is inferred from five service samples. The initial noisy calibration and failed browser qualifications remain excluded; the final report will record their failure ledger alongside the application comparisons. The [local-journal diagnostic](2026-11-03-native-event-ingestion-local-journal.md) records a separate baseline bottleneck and its measurement limits.

Fresh source acceptance is recorded in the linked source reports; the historical tables above are unchanged. Full H4 application acceptance remains failed: the latest H4c B0 and B2 attempts both missed the original 120-second streaming deadline, and earlier failures remain retained. No application A/A, application throughput gain or browser-latency improvement is accepted. The H5 observation protocol is prospective and unexecuted; upstream disk/journal findings are diagnostic only. Sparse-stream/control responsiveness, successful complete application comparisons, final delivery revisions and current-head CI remain open. The live-provider functional journey passed separately. The full ingestion task is not complete, and this report makes no deployed production or 10,000-agent qualification claim.
