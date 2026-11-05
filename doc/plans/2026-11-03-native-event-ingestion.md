# Native event ingestion: implementation and acceptance

Goal: reduce durable native ingestion work and improve visible streaming under
load, with no intentional collection delay. Deliver a cursor PR followed by a
dependent batching PR, each with correctness and measured incremental evidence.

## Fixed workload and measurement contract

- Fresh B0 is `83b5f7d486e70e484acd9a41bc957054f4e10175`; B1 contains only the
  cursor change; B2 adds batching. The original `2e37c73c` control remains
  historical calibration evidence. Record exact tested commits and dirty hashes.
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

Current state: the full real-PostgreSQL cursor comparison passed its frozen
performance and correctness gates. All six 10k/100k timing cases beat observed
baseline noise in five of five pairs; the 1k cases pass nonregression. The
[measurement report](../benchmarks/2026-11-03-native-event-ingestion.md) retains
all paired samples, units, SQL plans and the small-history gap-closure tradeoff.
The live-provider browser journey passed separately. Application performance,
batching performance and assembled diagnostic qualification remain outstanding.
The additive migration was generated with the repository command. The lead owns
integration and quiet measurement windows.

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
EVENT_BASELINE_REF=83b5f7d486e70e484acd9a41bc957054f4e10175
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/benchmark-native-event-ingestion.ts --baseline-ref="$EVENT_BASELINE_REF" --phase=aa --output=/private/tmp/native-event-aa.json --require-repeatability
node --import ./server/node_modules/tsx/dist/loader.mjs scripts/benchmark-native-event-ingestion.ts --baseline-ref="$EVENT_BASELINE_REF" --phase=compare --noise-report=/private/tmp/native-event-aa.json --output=/private/tmp/native-event-cursor.json --require-acceptance
```

For B1→B2, run the same A/A command with B1 as `--baseline-ref`, then use
`--phase=batch` and that B1 noise report from the B2 checkout. The default full
matrix uses five alternating pairs, 16 consecutive groups of 32 events per
sample, and ordered/replay/late-gap/warm-source-suffix cases at all three history
sizes. Warm suffixes start above source sequence 1 and retain a contiguous cursor
of zero. Report the actual history before and after each sample; the size label
is the seeded history, not an assertion that appended rows do not accumulate.

Fresh B0 is the exact unoptimized parent of B1, currently
`83b5f7d486e70e484acd9a41bc957054f4e10175`. The initially pinned
`2e37c73c05fe84aead1883b72fdf6b1653b58c2a` remains historical calibration/smoke
evidence. Aligning the control removes intervening unrelated recovery, GitHub,
CI and idle-history changes from application comparisons; it changes no
workload, durability, cache or acceptance contract. Pin the final B1/B2 commits
and matching compiled build stamps before fresh measurements.

The lead approved explicit A/A repeatability limits before any revised timings:
every ordered/replay/warm-suffix case at each history size must have maximum
absolute paired relative latency difference **≤20%** and absolute median-arm
drift **≤10%**. All nine timing cases must pass; late-gap timing stays structural
only. `--require-repeatability` records these gates from raw samples and exits
unsuccessfully for failure, smoke, insufficient pairs, a missing matrix or
unfinished evidence/cleanup. It can also check an existing report with
`--validate-report=<file> --require-repeatability`. A comparison validates this
calibration before starting candidate database work. Failed calibration stops
the sequence; preserve evidence and diagnose without weakening the limits.

Improvement additionally requires at least four of five **individual paired
improvements to exceed the observed A/A noise**, plus median improvement beyond
that noise. Four merely positive changes do not suffice: with 10% noise,
`[30%, 30%, 30%, 1%, -1%]` fails. Shared gates and browser CLI rejection of
smoke/source/profile evidence are checked by:

```sh
node --test scripts/native-ingestion-performance-gates.test.mjs
```

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
A/A noise in at least four of five individual pairs. Other case metrics are nonregression
controls. Use `--expect=nonregression` for the cursor-only application control;
the combined change still requires the loaded improvement. Comparison rejects
smoke, source-server evidence, mismatched artifacts/protocols, missing background
delta proof and incomplete runs. Live-provider walkthroughs remain a separate
integration gate.

### Browser protocol v2, registered before fresh A/A

The first full v1 baseline qualification failed in the paced 1×128 case. Its
paint observer accumulated 127 markers and missed index 127. Independent,
read-only PostgreSQL inspection found all 128 deltas with unique source
identities and no gaps. The run succeeded. The normalized completed item and
final comment were each exactly 4,000 characters with a truncation marker and
only complete marker indices 0–55. Raw Playwright DOM snapshots confirmed the
same 4,000-character terminal text, after streamed DOM text reached 9,033
characters. This is not an accessibility-snapshot truncation assumption.

The existing Rust provider normalizer bounds completed text at 4,000 Unicode
characters. UI projection treats a completed item as authoritative and replaces
its streamed deltas. Long in-band diagnostic clocks made the fixture's completed
answer exceed that preexisting bound. No application or normalizer policy is
changed to make the experiment pass. V1 failed artifacts, trace, decoded paint
observations and SELECT-only database receipts remain evidence of an unqualified
experiment; none establishes a speedup.

V2 changes the browser measurement protocol for every arm before any fresh A/A:

- A visible chunk is `[rrII] `: a unique two-base36-character run code followed by
  its base36 index. A full 512-chunk answer is 3,548 ASCII characters and bytes.
  The existing-history fixture keeps its 1,000 actual single-character prelude
  deltas and sentinel; that prelude plus 128 compact chunks totals 1,907 characters.
  Explicit checks keep these completed payloads below the unchanged 4,000 bound.
  Before releasing measured emission, an independent normal event-API read verifies
  all 1,000 prelude deltas and source identities; the report records that pre-gate proof.
- Full nonce, index, original intended emission time and original provider-process
  emission time travel on one streamed HTTP clock channel per provider. The
  channel opens and sends its hello before the common gate releases. There is no
  per-token HTTP request or wait for clock drain/response before writing text.
- The browser still captures a DOM snapshot in one animation frame and assigns
  that snapshot's paint-opportunity timestamp in the next. It records that time
  immediately, even when the clock channel has not arrived. It joins original
  clocks afterward, preserving the original browser timestamp.
- Every visible marker and every independently read durable delta must match its
  original full nonce/code/index clock. Missing, duplicated or conflicting clocks
  fail. Stop may terminate the clock stream with a partial unacknowledged raw
  tail, but no observed or database-acknowledged prefix receives a synthetic clock.
- The provider completes its assistant item before invoking semantic progress
  and Finish tools. Tool/result/terminal output does not wait for the clock upload
  response. Standalone qualification deliberately withholds that response through
  terminal settlement and Stop acknowledgement.
- All 16/128/512 event counts, 1/10/100 run counts, emission schedules, history
  counts, payload-identity checks, drainage checks, timeouts and performance gates
  remain fixed. Removing diagnostic clocks makes the browser text payload smaller;
  this is explicit and matched across all v2 arms. The owner-path workload retains
  its original 128-byte text payload and unchanged source/gate hashes.
- Timed A/A and comparison runs disable Playwright trace, video and screencast.
  Their metadata records the actual configured capture modes; the comparator
  rejects recording, legacy v1, smoke, profile and incomplete evidence. The two
  animation-frame observer remains declared measurement overhead. Manual
  screenshots occur after timed terminal drainage. Separate diagnostics may
  capture browser traces and app-only Node CPU profiles and stay ineligible.
- A failure attachment retains the active case, requested and ready participants,
  observed marker timestamps, raw rendered text, DOM marker inventory, received
  source clocks, stream errors and the latest independent durable read.

The separate browser harness H is based on application ref
`7922802f069ab3b39e9f79368c46615ba2201ba9` with only the v2 fixture, observer,
recording metadata, comparator, tests and this record changed. H uses explicitly
identified driver-only tooling dependencies. Each measured application retains
its own independent locked dependencies, clean source checkout and matching
compiled build stamp: B0 `83b5f7d486e70e484acd9a41bc957054f4e10175`, B1
`7922802f069ab3b39e9f79368c46615ba2201ba9`, B2
`6afeba4edafd47120e8117f736641d5424b27d4a`. Reports retain H's own revision,
source status, individual protocol hashes and lockfile hash. No application
build stamp is rewritten for a test-only change. Exact H commit and combined
protocol hash are frozen with the qualification receipts before new A/A starts.

Qualification must pass the source-clock protocol smoke and the full B0 browser
matrix, including actual 100-participant readiness and independent background
persistence. Fresh A/A still precedes any candidate comparison. The owner-path
20% maximum paired variance / 10% median drift limits and the requirement that
four individual candidate pairs exceed observed noise are unchanged. Failed v1
samples are never reused as v2 evidence.

Registered v2 browser protocol SHA256: `5498ed8dfc7139285aeda582c540eb572f07a1ad3e73de6e0f12c5af4c45e0ba`.
Comparator SHA256: `d8cf6f55339ad811ca1743f4bc73b74afa3a321b93e17ef913fc0339b47b4d7d`. Individual source hashes and
H's exact committed revision are retained with each qualification/execution receipt.

### V2 admission qualification correction, before fresh browser A/A

H `96b1a5f1a4497d1389c21b0cc52d55b86641690d` passed the compiled
single-run smoke and completed paced 128, burst 16, and ten runs of 128 events.
Its first full baseline qualification then failed during setup for the 100-run
case, before the common emission epoch was released. All 100 issues existed,
but only one provider/clock hello arrived and no measured deltas were emitted.
Ten concurrent normal task-activation requests timed out; cleanup also timed
out and masked the original exception. The complete failed report and an
independent SELECT-only database inspection remain excluded from acceptance.
The active issues were 50 todo, 49 backlog, and 1 in_progress; 31 runs existed
(3 running, 28 queued), with no measured item.delta rows.

Static inspection found a separate potential pool-starvation path: each native
wakeup transaction can await a responsible-user lookup on the outer database
client, whose default pool is 10; a group of ten activation wakeups can consume
that pool. This is an observed pre-epoch startup-contention failure with a
matching static candidate, not a runtime-proven deadlock diagnosis: no live
pg_stat_activity capture exists. The product admission hazard remains separate
from this ingestion change; increasing pool size or request timeouts is not
part of the experiment.

Before any fresh browser A/A, H now schedules each background using the same normal
PATCH, then requires that exact participant's provider GET and original-clock
hello before scheduling the next. All 100 providers remain live behind the
closed common emission gate. A **shared 180-second readiness budget starts
before activation**; this is stricter than starting the same readiness budget
after activation. The 600-second overall test limit, 20-second request limits,
event counts, payloads, rates, 100-run measured concurrency and every performance
gate are unchanged. Source owner-path protocol and gates are byte-identical.
The report identifies this admission protocol explicitly, and its comparator
rejects reports without it. Original exceptions, exact activation progress and
separate cleanup errors are retained without accepting a cleanup failure.

Registered corrected browser protocol SHA256:
`5430314c028c9e05ddf4e27e6e22a0191ee0d4a61ffc61649627fd93777acebc`.
Comparator SHA256:
`c1b7249022a95ff2186e72784247ca83125550c02910d8ad2bf52e1389cf9afc`.
The corrected H commit and source hashes are recorded before its full baseline
qualification and new browser A/A. Earlier H96b samples never enter that series.

The original sparse-stream acceptance also requires no regression in gaps between
rendered chunks. After terminal drainage, H derives consecutive gaps between
distinct observed paint timestamps from the existing retained `visibleMs` values.
Reports include paint count, gap count, median gap and maximum observed gap;
no tail quantile is inferred from a small gap sample. The comparator requires
observed paced-stream gaps and gates the maximum observed gap against the same
five-pair A/A noise envelope. This adds the previously missing acceptance check
before browser A/A; it changes neither the streaming observer nor emitted work.
The independent source-owner A/A may run during local H work because its workload,
measurement code and gates remain unchanged.

### Setup readiness observation correction, before browser A/A

The full H `e27b338315034c062b18606c0f3ff7d883e3dfed` qualification
reached activation index 95, with 95 provider GETs and clock hellos, then hit the
unchanged shared 180-second deadline. No common epoch was released and no
measured emission clocks existed. The retained report records the primary
984-millisecond remaining-budget timeout and a separate cleanup 409 response;
it is ineligible for acceptance. After teardown, an independent process check
verified no owned Node, PostgreSQL or Rust Runner processes remained before the
separate source-owner cursor comparison began.

The default readiness poll backoff is a suspected contributor to the approximately
1.85-second setup cadence. That failed run did not record clock-hello receipt or
readiness-observation times, so it does not prove poll quantization. Before fresh
browser A/A, H changes only the two setup predicates to a fixed 50-millisecond
observation interval. Both predicates read local provider/clock maps; they issue
no database or application request. The shared 180-second hard deadline, 600-second
overall limit, exact-participant checks, 100 live providers, common epoch, measured
event schedules, counts, payloads and performance gates remain unchanged.

Future qualification records pre-epoch provider GET receipt, clock-hello receipt
and background readiness-observation timestamps to expose any observation lag.
These are setup diagnostics, distinct from the unchanged original provider
emission clocks and browser paint observer. The comparator requires the frozen
50-millisecond setup interval. Earlier failed samples remain excluded.

Registered browser protocol after setup observation correction: `902c6a208793f0bcde1b326a1fee46d85df3274117754e3bfbbf77a65dc730ee`.
Comparator SHA256: `e50d958532906d037413db6f66bdc02e60c93ddcacfe2e18e5b731d302f6a785`.

## November 4 current campaign and tool packaging

The [application report](../benchmarks/2026-11-04-native-event-ingestion-application.md)
owns current qualification and acceptance status. The [H5e package](../../scripts/native-ingestion/h5e/README.md)
retains exact neutral V4 and resource V3 snapshots, meaningful parent/compiled/
receipt fixtures, source reviews, the resource measurement protocol and portable
offline checks. Earlier frozen protocols and failed attempts above stay intact.
Published driver tags remain main `73ea8516…` and companion `a89f321a…`; neither
the mixed delivery checkout nor packaging changes replace those drivers.

Current75 TypeScript batching has its own normal production build, isolated
native target and exact receipt. It needs no Rust product change. CF SMALL/FULL
and the old-wrapper companion have completed functional observations, retaining
FULL's original loaded 120-second miss (63/512 foreground deltas). Main B0 A/A
is active at this packaging snapshot; no accepted noise or application gain is
claimed. Neutral V4 requires a new companion functional qualification and A/As;
resource V3 needs actual Linux/accounting and six-hook SMALL qualification.

The fixed resource protocol uses five alternating B0/B1/B2 blocks (15 FULL
invocations), with five matched pairs per contrast and shared observations
disclosed. Exact durable denominators, terminal versus independently verified
drain windows, six interior samples and 10% per-numerator boundary precision
remain unchanged. No CPU improvement beyond uncalibrated CPU noise is claimed.
Resource diagnostics remain separate from unprofiled application/control gates.
Completed paired results, durable raw-artifact links, final-source live/cloud
Stop evidence and current-head checks/review remain to be added by their owners.
