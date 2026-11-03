# Native event ingestion: implementation and acceptance

Goal: reduce durable native ingestion work and improve visible streaming under
load, with no intentional collection delay. Deliver a cursor PR followed by a
dependent batching PR, each with correctness and measured incremental evidence.

## Fixed workload and measurement contract

- B0 is `2e37c73c05fe84aead1883b72fdf6b1653b58c2a`; B1 contains only the cursor
  change; B2 adds batching. Record exact tested commits and dirty-file hashes.
- Use the actual append service with disposable PostgreSQL and 1k, 10k and 100k
  histories. Include singleton writes, duplicate replay, sparse sequences and
  late gap closure. Setup and warmup are outside measured intervals.
- Qualify the harness with a small case. Measure baseline against itself before
  candidate comparison; retain the observed repeatability envelope. Compare at
  least five alternating pairs. Report median, spread, samples and all failures.
- Burst fixtures emit 16, 128 and 512 events, with 1, 10 and 100 concurrent runs.
  Include final drainage and independently compare stored identities/payloads.
- Application proof requires a production build, a separate arrival/load clock,
  and browser render observations. Measure SQL/transactions, lock waits, CPU,
  backlog/memory, event-loop delay and emission-to-render latency. A service
  benchmark alone cannot establish browser or deployed improvement.

## Acceptance gates

| Outcome | Gate |
| --- | --- |
| Flat steady-state cursor work | Indexed cursor/range operations do not scan retained history; long-history append cost improves beyond baseline noise. |
| Useful batching | Burst completion rate improves beyond noise in at least four of five pairs; fewer transactions per event; no missing work or hidden backlog. |
| Immediate streaming | First and isolated text start persistence immediately; no timer or minimum batch size; sparse render latency does not regress beyond baseline noise. |
| Loaded user experience | Combined change improves browser delivery latency beyond baseline noise under the same offered load. |
| Correctness and controls | Replay identities, gaps, conflicts, company scope, outer rollback and commit-before-effect barriers remain correct. Stop and control latency do not regress. |
| Compatibility and quiet | Stale projections use the correct fallback; bounded rebuild survives restart/old writers and stops all recurring SQL after draining. |

Do not lower these gates after measuring a candidate. An inconclusive or failing
comparison needs diagnosis, not a successful-performance claim.

## Implementation ownership and boundaries

- Cursor/range state belongs with heartbeat event persistence. It remains a
  derived optimization, fenced by the run's committed global-sequence marker.
  Existing histories use the correct aggregate fallback while a concrete rebuild
  obligation runs in 512-row transactions through the existing work coordinator.
- The native session runtime owns bounded read-ahead through its existing
  transformed iterator: 64 events / 64 KiB, one pending read and one append.
  Start the first append immediately; submit ready text as soon as the prior
  write settles. Nontext/P0 events remain ordering barriers.
- The control-plane port owns validation, ordered identity redaction and outer
  revocation fencing. Database batches commit before receipts, publication and
  callbacks. No numbered events are merged.
- Raw transport ACK/recovery policy is outside this change. Database receipts
  remain durable; raw ordinary-output ACKs do not universally promise transcript
  durability. The upstream normalized producer queue remains a separate limit.

## Verification record

Baseline SQL-only investigation: PostgreSQL 18.1, Node 26.4.0, five warm samples
per size. The current count/max query examined 1k / 10k / 100k index entries, with
median execution times 0.063 / 0.504 / 5.243 ms. This is mechanism evidence only.

Current state: implementation in progress. No candidate speedup has been
established. The compiled B0 browser fixture passed functional qualification;
paired performance and live-provider acceptance remain outstanding. Dependencies
are installed and the additive migration was
generated with the repository command. The lead owns integration and measurement
windows; workers own cursor services, benchmark harness and isolated runtime work.

Before delivery: run focused PostgreSQL/runtime tests, migration checks, required
typecheck/test/build gates, then the real browser native-run/tool/result/reload
and Stop journeys. Record target, exact revision, provider versus fixture, run
IDs, persisted outcomes and accessible evidence. Each PR uses the repository
template and includes its own measurements and remaining limitations. Deployed
claims require the exact serving revision and a separate matched verification.

## Reproduction and evidence protocol

The owner-path harness is `scripts/benchmark-native-event-ingestion.ts`. It loads
the requested baseline owner and changed supporting services from Git, rather
than borrowing the candidate's append implementation. A baseline that already
has cursor projections is prepared with its own pinned rebuild helper. Both
optimized arms must have current projections before steady-state timing.

```sh
EVENT_BASELINE_REF=2e37c73c05fe84aead1883b72fdf6b1653b58c2a
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/benchmark-native-event-ingestion.ts --baseline-ref="$EVENT_BASELINE_REF" --phase=aa --output=/private/tmp/native-event-aa.json
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/benchmark-native-event-ingestion.ts --baseline-ref="$EVENT_BASELINE_REF" --phase=compare --noise-report=/private/tmp/native-event-aa.json --output=/private/tmp/native-event-cursor.json --require-acceptance
```

For B1→B2, run the same A/A command with B1 as `--baseline-ref`, then use
`--phase=batch` and that B1 noise report from the B2 checkout. The default full
matrix uses five alternating pairs, 16 consecutive groups of 32 events per
sample, and ordered/replay/late-gap/warm-source-suffix cases at all three history
sizes. Warm suffixes start above source sequence 1 and retain a contiguous cursor
of zero. Report the actual history before and after each sample; the size label
is the seeded history, not an assertion that appended rows do not accumulate.

Setup, projection rebuild, warmup, and independent verification stay outside the
timed append interval. Post-sample reads verify durable count, global sequence,
source identity, canonical hash, schema version and exact payload. SQL diagnostics
run separately: actual scan work includes rows removed by filters and index
rechecks. Lock-acquisition query duration includes query/network work; it is not
reported as pure lock wait. Database CPU samples use the backend process with
10 ms CPU-clock resolution.

`--quick` only qualifies the harness. Acceptance rejects quick runs, A/A runs,
fewer than five pairs, incomplete matrices and unfinished resource cleanup.
Noise reports must match the exact harness hash and workload fingerprint.
`--validate-report=<file> --require-acceptance` additionally checks current
supporting source hashes before reusing successful owner-path evidence.

### Retained failed calibration

The first full A/A completed successfully as an experiment but failed the
repeatability requirement. These columns compare the **same baseline with
itself**; they do not demonstrate an optimization:

| Seeded history / case | Arm A median ms | Arm B median ms | Largest paired relative difference |
| --- | ---: | ---: | ---: |
| 1k / ordered | 233.862 | 287.416 | 88.2% |
| 10k / ordered | 324.838 | 277.984 | 82.5% |
| 100k / ordered | 461.712 | 468.998 | 20.2% |
| 100k / warm source suffix | 640.278 | 770.366 | 125.4% |

That protocol measured only one 32-event group per sample. The lead approved
16 fixed groups per sample before measuring any candidate, to average short
durable-commit/storage variation. The noise criterion was not relaxed. Late-gap
closure remains a separately seeded structural diagnostic, not a one-operation
latency acceptance gate. A fresh A/A must qualify the revised protocol.

Original raw evidence is retained at
`/private/tmp/native-event-ingestion-aa-frozen.json` and its `.log`; initial
qualification files are `native-event-ingestion-aa-smoke.json` and
`native-event-ingestion-cursor-smoke.json` in the same directory. These local
paths supplement the inspectable table above and are not final candidate proof.
The original process exited 0 and its owned cluster and temporary source
snapshot were removed. Slow per-company cleanup was diagnosed and removed from
future owned-cluster runs; supplied external test databases still receive scoped
cleanup in dependency order.

### Compiled application and browser path

`tests/e2e/playwright-native-ingestion.config.ts` starts an isolated instance,
the compiled server/vendored runner and built static UI. TSX resolves workspace
DB/shared source exports only. This is a local build dimension, not an npm or
hosted deployment qualification. The test records the compiled build stamp,
ingestion/runtime file hashes and a shared fixture/observer protocol hash.

```sh
PAPERCLIP_E2E_PORT=32762 PAPERCLIP_INGESTION_SMOKE=1 PAPERCLIP_INGESTION_VARIANT=B0-smoke PAPERCLIP_INGESTION_APP_ROOT=/private/tmp/paperclip-native-event-baseline PAPERCLIP_INGESTION_EVIDENCE_DIR=/private/tmp/native-ingestion-browser-smoke node node_modules/@playwright/test/cli.js test --config tests/e2e/playwright-native-ingestion.config.ts
```

Omit `PAPERCLIP_INGESTION_SMOKE` for the full matrix. Choose an owned free port
and evidence directory for every execution. The default command configures the
instance through the existing onboarding boundary with `invokedByRun: true`,
then explicitly starts `server/dist/index.js`. Plain `onboard --yes` starts the
source server automatically and cannot serve as preparation for a later compiled
command. The first qualification caught this, was stopped, and its log remains
at `/private/tmp/native-ingestion-browser-b0-smoke-20261103.log`; no application
or performance success was claimed for it.

The next qualification reached the compiled/static-UI server but timed out at
the 20-second agent-creation request before any measured task began. Its log and
trace remain under `/private/tmp/native-ingestion-browser-b0-smoke2-20261103`.
The fixture now creates ordinary engineer agents, avoiding unrelated CEO default
skill provisioning, with a 120-second setup-only POST deadline. This changes no
streaming or performance acceptance threshold. The cause of the original setup
delay remains unproven until independently isolated; a successful retry alone
does not establish that cause. Owned HTTP and PostgreSQL listeners from that
attempt were confirmed closed.

The engineer retry passed agent creation and exercised the native runtime, then
exposed a fixture parser defect: the automatically shortened task title contained
a truncated gate URL while the full Markdown description escaped `_` and `=`.
The provider selected the title and rejected that incomplete URL. The saved
failed run reached durable settlement and recorded `native.local_process_stopped`.
Evidence remains under `/private/tmp/native-ingestion-browser-b0-smoke3-20261103`.
The parser now decodes nested input strings, handles Markdown punctuation and
requires a complete loopback gate plan; the UI prompt also starts with an ordinary
human title. A separate protocol qualification reproduced that exact input shape
and emitted all 16 expected deltas. Application rerun remains distinct from that
provider-only proof.

The fourth compiled B0 qualification passed on baseline
`2e37c73c05fe84aead1883b72fdf6b1653b58c2a`: all 16 foreground deltas were
visible and independently persisted with unique, ordered source identities. The
Stop run acknowledged canonical native cancellation; all seven visible deltas
were independently persisted. Both transcripts survived reload. The foreground
run was `9bf19cd8-7fa9-4a1e-9736-ec1dcab17a17` and the Stop run was
`81ff804f-79e3-438e-9aa0-ff23a7aa9e66`. Evidence, screenshots and the Playwright
report are retained under
`/private/tmp/native-ingestion-browser-b0-smoke4-20261103`; its extracted
`native-ingestion-evidence.json` records the matching source/build revisions,
compiled hot-path hashes and `qualificationOnly: true`. The test passed in
41.5 seconds after startup; other builds were active, so its timings establish
no performance improvement or baseline noise envelope. Owned HTTP 32764 and
PostgreSQL 54334 listeners were confirmed closed. The full workload matrix,
100-run admission, alternating pairs and live-provider walkthrough remain open.

The provider is deterministic; runtime, persistence, live WebSocket, tools and
UI are real. A separate provider process keeps original intended emission times
even when stdout backpressures. A common gate releases all admitted runs on the
same schedule. The browser snapshots actual text in one animation frame and
timestamps that snapshot in the next, preserving a dirty rescan for later text.
After timing, the test independently reads individual `item.delta` rows for
every foreground/background run and checks count, order and source identities;
completed-item text cannot hide missing deltas. Reload preserves the transcript
and previously visible stopped output.

The full browser matrix contains paced 1×128 output, 1×16 / 10×128 / 100×512
bursts, an existing-history case and operator Stop. Existing-history pressure is
**1,000 actual prelude events in the watched run/source**, committed and visible
before releasing the measured phase; background runs have no prelude. The 100k
history case belongs to the owner-path benchmark. It is not claimed for the
browser fixture.

The policy permits at most 50 concurrent runs per agent; the 100-run fixture uses
two Codex agents configured through the normal API at 50 each. A common gate
requires all requested providers to become ready before emission. Admission
readiness for 100 is a separate qualification obligation; a smaller admitted
count must not be labelled a 100-run measurement or bypassed through direct
database writes.

Run five alternating baseline/repeat application pairs for A/A and baseline/
candidate pairs for comparison. A manifest is a JSON array of entries with
`baselineFile` and `candidateFile`, pointing at the corresponding
`native-ingestion-evidence` JSON attachments. Compare without manual arithmetic:

```sh
node scripts/compare-native-ingestion-browser.ts --phase=aa --pairs=/private/tmp/browser-aa-pairs.json --output=/private/tmp/browser-aa-noise.json
node scripts/compare-native-ingestion-browser.ts --pairs=/private/tmp/browser-ab-pairs.json --noise-report=/private/tmp/browser-aa-noise.json --output=/private/tmp/browser-comparison.json --require-acceptance
```

The preregistered primary loaded case is `burst512`: p95 emission/intended-to-
visible latency and drainage through terminal settlement must improve beyond
A/A noise in at least four of five pairs. Other case metrics are nonregression
controls. Use `--expect=nonregression` for the cursor-only application control;
the combined change still requires the loaded improvement. Comparison rejects
smoke, source-server evidence, mismatched artifacts/protocols, missing background
delta proof and incomplete runs. Live-provider walkthroughs remain a separate
integration gate.
