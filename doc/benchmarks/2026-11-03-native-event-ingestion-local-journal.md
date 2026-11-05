# Local journal diagnostic (2026-11-03)

The original local-process, 100-run browser fixture could not qualify its baseline. All 100 providers became ready and emitted all 51,200 measured deltas, but only 7 of the foreground run's 512 markers became visible within the 120-second streaming budget. The experiment failed; later database counts do not establish delivery within that budget. No candidate result or throughput gain is claimed for this workload.

The fixture used baseline `83b5f7d486e70e484acd9a41bc957054f4e10175` and driver `f5c560d80d9d4ee089297d3b3f300c052db17c9e`. A separate instrumented baseline replay investigated the limiting stage. Its profiles are **diagnostic only** and excluded from acceptance measurements.

## What the profiles establish

The early 31.063-second profile was 84.33% idle by weighted samples. A diagnostic flush accounted for 4.40%, making observer overhead material. This window does not establish a CPU bottleneck throughout the experiment.

A separate 30.847-second profile captured the hot queue after the browser fixture had already failed. Synchronous `fsync` occupied 45.38% of weighted self samples; the parent-directory sync frame occupied 48.09% inclusively, and `withStagedPrivateWrite` occupied 67.43% inclusively. These inclusive percentages overlap and must not be added. They identify costly work in the existing local raw journal, outside the event-ingestion transaction.

The serialization wrapper occupied 21.26% of weighted self samples, but the probe also counts bytes there. That figure is **not** pure production JSON-encoding CPU. Async file-sync elapsed time also overlaps across operations and includes callback scheduling; it is not main-thread blocked time. The retained PostgreSQL observations distinguish idle client waits from idle transactions.

V8 weighted stack samples include idle and native blocking time. They are not a measure of process CPU utilization. The two windows describe different phases, and the latter cannot be substituted for an unprofiled successful run.

## Scope of the subsequent experiment

The supported remote-controller path already avoids full local file-journal rewrites for ordinary externally checkpointed output. The revised browser fixture uses that normal path for streaming and keeps a separate local Stop case. It changes neither transport recovery policy nor the ingestion code to bypass persistence. All compared application revisions receive the same fixture, and its baseline must qualify before candidate measurements begin.

Any later remote-streaming improvement is scoped to that tested configuration. It does not establish that the original local-process, 100-run workload passes. Ordinary raw transport ACKs still do not universally guarantee database durability. Database receipts and consequential side effects retain their commit barriers.

## Inspect the evidence

The [manifest](native-event-ingestion-2026-11-03/local-journal-diagnostic/manifest.json) records exact original hashes and compressed sizes. Inspect the [failed browser report](native-event-ingestion-2026-11-03/local-journal-diagnostic/native-ingestion-evidence.json.gz), [post-failure database counts](native-event-ingestion-2026-11-03/local-journal-diagnostic/measured-delta-counts.json.gz), [owned-process cleanup](native-event-ingestion-2026-11-03/local-journal-diagnostic/external-cleanup-receipt.json.gz), and [read-only forensics](native-event-ingestion-2026-11-03/local-journal-diagnostic/forensic-receipt.json.gz) alongside the two raw profiles and [PostgreSQL observations](native-event-ingestion-2026-11-03/local-journal-diagnostic/pg-live.ndjson.gz). The [weighted summary](native-event-ingestion-2026-11-03/local-journal-diagnostic/weighted-cpu-summary.json) can be reproduced with:

```sh
python3 scripts/native-ingestion/inspect-cpu-profile.py \
  doc/benchmarks/native-event-ingestion-2026-11-03/local-journal-diagnostic/focused-100-run-app.cpuprofile.gz \
  doc/benchmarks/native-event-ingestion-2026-11-03/local-journal-diagnostic/postfailure-hotqueue-app.cpuprofile.gz
```

The separate replay's [app counters](native-event-ingestion-2026-11-03/local-journal-diagnostic/app-46347.ndjson.gz) contain 2,105 samples over 596.787 seconds. The observed upstream normalized queue reaches 22,992 events and sampled RSS reaches 3,234,127,872 bytes. The final sample records 36,552 full snapshots encoding 13,740,085,068 bytes, with 50.971 seconds of serialization elapsed and 149.033 seconds of synchronous directory-sync elapsed. Those are cumulative diagnostic observations, not accepted throughput or user-latency measurements. The normalized queue is upstream of the bounded collector, so the collector's limit alone cannot bound it.

The [counter summary](native-event-ingestion-2026-11-03/local-journal-diagnostic/app-counter-summary.json), [diagnostic command](native-event-ingestion-2026-11-03/local-journal-diagnostic/diagnostic-command.json), same-directory original instrumentation sources and [quiet return](native-event-ingestion-2026-11-03/local-journal-diagnostic/diagnostic-quiet-returned.json) make the observer and cleanup inspectable. Reproduce the counter summary with:

```sh
python3 scripts/native-ingestion/inspect-app-metrics.py \
  doc/benchmarks/native-event-ingestion-2026-11-03/local-journal-diagnostic/app-46347.ndjson.gz
```

This diagnostic is not a production improvement or deployment-qualification claim.
