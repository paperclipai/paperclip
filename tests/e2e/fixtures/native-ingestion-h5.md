# H5c canonical-settlement observation registration (prospective; no execution release)

H4c remains frozen at `7d7e7a88d562a95a1d407b76474763b666c181f5`
(`5db4129bbdc1fa38775121aff5d0e68a8a11762519e41cfdf36eacd90ba7256b`).
Its observed 120-second streaming failures remain failures. Aborted or profiled
attempts cannot be reused as complete timing arms. H5c keeps one normal agent per
concurrent remote participant and waits for the product's canonical settlement,
including supported same-run recovery, within the same terminal deadline.
It does not optimize the product or turn earlier failures into passes.

The aligned fresh application baselines are B0 `bac53ec3bfeaf6546e7aaeaee516487b30534654`
and B1 `07061a601cdc20603c8c7a46f9ddbad7ac5f5939`. Raw B2
`ca7cba171cd5198ed569d75012edc858041cbc44` is the unoptimized batching base,
not a qualified future performance candidate. A later candidate needs its actual
new immutable revision, normal build receipt and inventory; no candidate reference
or matching binary is presumed before those artifacts exist. The historical
a365/d8cd/914 application failures remain evidence of their recorded revisions.

Select H5 explicitly with
`PAPERCLIP_INGESTION_OBSERVATION_MODE=h5c-observe-original-sla-independent-agents-settlement`.
The new default H4e mode uses the same independent-agent geometry with the original
120/180/900-second deadlines. Observation mode uses the explicit H5c protocol.
Both modes hash the same nine source files, including the shared topology helper.
Their source revision and measurement bytes must match for later confirmation.
Old H4c/H5a protocols, geometry, arms and noise are ineligible for H5c. H5b179fe6
and its H4d default proof use the premature terminal-status observer and are also
ineligible. The new H4e proof must use the exact H5c source and geometry.

Run `node scripts/describe-native-ingestion-h5.mjs` to inspect the registration.
This is a dry run only: it starts no app, provider, database or browser and
accepts no execution arguments. It grants no runtime release.

## Independent participant geometry and setup

Create a pool of100 normal remote agents for the full fixture (three for smoke).
Each concurrent remote participant receives a distinct pool agent by index; the
pool is reused only across sequential cases. The100-run case is100 agents × one
run each. Agent POST, normal environment selection, managed files, permission
checks and maxConcurrentRuns50 configuration stay enabled. The separate local
Stop control agent and its normal local environment stay unchanged.

Use exactly eight setup workers, each awaiting normal agent creation and the
existing60s lifecycle-ready poll. Keep index order despite completion order.
Attempt and settle the whole pool; any setup error fails the invocation before
case activation. Record every attempt, start/settlement time and status. No
partial pool, silent retry or reduced load can qualify. The existing per-case
READ ONLY authority snapshot must prove distinct agent_id values for every
remote participant, all drawn from the ready pool. No event polling is added.

Agent creation occurs before the existing300s activation/readiness window starts.
That start point remains after the pool and background issue creation. All agent
setup remains inside the owning public900s default/1200s observation invocation;
no setup work is moved outside those timers or into measured epochs. The existing
waves of two provider activations, readiness polls and common source epoch stay
unchanged. All arms use the same geometry and eight-worker setup. Its actual
setup cost and100-agent full qualification are unverified until measured.

This changes managed-directory contention and agent-list cardinality. A result
will describe independent-agent ingestion, not50 concurrent runs sharing one
agent. Do not generalize it to the retained old2×50 failure below.

## Retained H5a negative result

H5a7388 on application B0a365 used two normal agents with50 concurrent runs each.
All100 participants were admitted and clock-ready. The original120s poll failed
with54/512 visible markers; all512 became visible296.555s after that wait began.
All100 runs reached a terminal status55.234s later, with86 succeeded and14 failed.
Independent read-only PostgreSQL checks found all51,200 expected lossless deltas
and one accepted result for each run. This did not pass full qualification or A/A.

Each of the14 failed runs recorded native_session_interrupted from a30s
agent-directory merge-lock timeout; each finalization retained retryable_failure
with native_workspace_sync_out_failed and an ACTIVE unreleased lease. Seven
failures mapped to each agent's shared file-sync root. Task workspace and lease
identities were distinct; no provider failure was recorded. The new geometry
removes that shared-agent contention from this experiment. It does not fix or
qualify the product's old2×50 concurrency limit or justify disabling file sync.

A separate background presentation40P01 involved a run that succeeded. The
retained log shows its coordinator→issue→run wait, but lacks PostgreSQL's full
opposing lock cycle. Its cause and relationship to other contention are unproved.
It is not evidence that the14 run failures came from a database deadlock. All
historical failures remain separate; no failed H4c/H5a arm is reused as H5c noise.

## Retained H5b failure and canonical settlement correction

H5b179fe6 on aligned B0bac53 admitted100 distinct normal agents before the common
epoch. Its original120s poll failed with61/512 foreground markers; all512 became
visible282.734s after the wait began. The observer stopped54.737s later on83
succeeded and17 failed statuses. Independent PostgreSQL checks found all51,200
lossless deltas and one accepted result per run. Qualification failed; history
and Stop were not reached. This arm is not noise or performance evidence.

All17 errors were provider_transport_failed with the generic message that the
runner did not durably suspend before checkpoint. Existing run logs instead
show runnerSuspended=true and providerDrained=false: the exact runner.drain
receipt was still pending after its five-second drain window. Why the receipt
was late remains unproved. These were not the earlier shared-agent lock errors.
All17 finalizers were retryable_failure at attempt1 with a scheduled+30s workspace
retry; application teardown finished before the earliest retry was due. ACTIVE
leases and prepared workspace-sync receipts remained unfinished. Later recovery
was not observed and is not presumed to pass.

The exact B0bac53 run-failure-report.ts44–50 contract states:

> A native run that waits for a same-run retry is stored as `failed` with
> `nativePhase: "retryable_failure"`. That is not terminal: the retry or the
> workspace copy-back retry can still finish the run as succeeded.

Normal company-run lists omit
runtimeMode/nativePhase. Normal GET /api/heartbeat-runs/:id exposes both through
the existing full run columns. Inside the same single180_000ms terminal poll,
resolve only failed list candidates through that detail GET and classify its
current result. Keep failed/native/retryable_failure pending; permanent/unknown
failures and GET errors reject. The observer sends no retry or provider command.

Record bounded state changes per run with time, status, runtimeMode, nativePhase
and errorCode. Missing list-only fields are null, not inferred. Cap at16 changes
per run and fail on overflow rather than discard observations. Retain total
unique retryable runs, recovered runs, nonretryable failures and per-error-class
unique-run counts. Every observed retry must recover successfully within
the unchanged180s window; a deadline miss remains censored failure, never a
completed latency. All100 successful native runs, exact deltas/results, reload,
lease cleanup, existing-history and local Stop gates remain required.

After recorded settlement, acknowledgement, lease timing, reload and normal
event verification, take one company-and-exact-run-set READ ONLY REPEATABLE READ
snapshot through the existing owned PostgreSQL helper. Retain current error-code
fields and the closed schema/errorCode/observedAt fields of
result_json.recoveredExecutionFailure, plus descriptive finalization attempt.
Require every actual run, exact identities, settled status, valid shapes and a
closed connection before the next case. No event HTTP or database polling loop
is added. The existing independent completion upper bound includes this check;
the measured settlement and lease timestamps stay unchanged.

The durable recovery marker is copied from the run's error fields when successful
finalization clears them (native-run-projection.ts114–121 in B0bac53). It can
therefore retain a failure recovered before terminal-window polling. Union its
codes and current recorded errors with observed transition codes by run identity.
The normal Stop path's closed cancelled code is retained as cancellation
evidence (run-control.ts1345); other current Stop error codes remain failures.
Use these all-recorded unique-ever-failed-run counts/rates for comparison, and
retain the observed-only counters separately. This marker records the retained
failure, not an exhaustive sequence of every error class or attempt. Do not claim
omniscient error history. Finalization attempt is a claim counter that can be
preserved across workspace repair (native-run-finalizer.ts237–240); it is not a
failure count and supplies no rate gate.

Successful committed ordinary runs must have both current error fields cleared,
as required by native-run-projection.ts180–193. A still-current error fails the
proof; a succeeded status alone cannot turn it into recovered failure evidence.

Fresh A/A retains all histories and freezes, per case, total and per-error-class
all-recorded unique-ever-failed-run rates plus the maximum absolute paired rate difference. Zero baseline
counts are valid; no relative division is used. Each candidate may use only
error classes observed in that baseline A/A. Every paired total/per-class rate
increase and its median must stay within that frozen absolute noise envelope.
A single-arm retry storm cannot hide behind the median. Recovery and its final
backlog remain inside drainage timing; observing recovery does not mean the
earlier errors disappeared. All recorded failures must have recovered, and every
run still needs its exact independently persisted accepted result. No product
retry policy or drain limit is changed.

## Fixed work and observation boundaries

Keep the five streaming event workloads and original local Stop case exactly as H4c:
paced 1×128 at25ms; burst 1×16; burst10×128; burst100×512; existing-history
1000 foreground prelude deltas plus measured10×128; local Stop1×512 at100ms,
clicked after at least three observed markers. Keep normal API/UI activation,
waves of two, shared300s readiness, actual GET+clock hellos, verified TLS,
closed READ ONLY REPEATABLE READ authority snapshot, source identities and
payloads, original nonawaited source-clock writes, and the existing2RAF observer.
No normalized-event polling channel, per-event HTTP, injected provider receipt,
raw recovery-policy change, diagnostic instrumentation or replacement app entry
is added. Fake-plugin streaming remains separate from real-cloud Stop proof.

| Boundary | Original requirement | H5 observation |
| --- | --- | --- |
| Foreground markers | Original Playwright120s wait | Continue to an absolute600s ceiling from that same wait start |
| Canonically settled runs |180s after foreground completion (and Stop click) | Same single180s after eventual foreground completion; supported retries remain pending, permanent failures reject, deadline misses fail |
| Stop acknowledgement and leases | Existing30s polls and ordering | Unchanged; full click→acknowledgement metric retained |
| Invocation | Original900s test budget | Actual1200s observation timeout, separately disclosed |

The first120s poll is the original matcher. Only that exact known matcher
deadline can extend observation. Page/API errors, other assertions, terminal
failures and cleanup failures never become an allowed SLA miss. There is no
collection wait when markers are available. The600s ceiling is absolute from
the original wait start; continued observation uses only its remaining budget.

Record the original wait start/deadline, actual last count and its observation
time, assessment time and error before continuing. Keep the original failure
after completion. The original120s clock starts before the common source epoch;
it is not silently rebased to epoch+120s. Derive a separate paint-deadline count
from retained2RAF timestamps; do not mislabel it as the original poll's count.

The recorded `deadlineMs` is the nominal configured boundary and
`assessedAtMs` is the actual matcher return time. Frozen Playwright1.62.1 can
report its timeout before that nominal boundary when the next polling interval
would cross it. Its original matcher outcome, known timeout error and incomplete
count establish the original failure; timestamp ordering against the nominal
deadline does not change that outcome. Retain both raw times and continue only
until the unchanged absolute600s observation ceiling.

If120s fails, original terminal processing was **not reached**. Later180s
terminal observations are separately labeled and cannot make the original
protocol pass. Keep epoch→all-terminal drainage unshortened. An additional
independent completion upper bound follows existing screenshot, reload,
persistence, clock and lease checks; it includes verification overhead and is
not an exact last-commit time.

The owning public Playwright JSON result supplies duration, startTime, retry,
status, errors and configured timeout. Its observed total duration is an
independent conservative assessment of the original900s budget; hooks/teardown
can be treated differently by the original timeout. It is not an exact original
timer-expiration observation. A final candidate must have total duration<900s
in every arm and later pass one unchanged H4e default-mode full invocation on the
same final SUT revision and full qualified artifact inventory.

## Complete evidence and eligibility

H5 `observationComplete` means all six cases reached finite correct outcomes,
with every expected participant and foreground marker. It does not establish a
pass of the original deadlines. Every remote run must succeed in native mode, retain every normalized
delta's complete payload/identity/order, have exactly one independently read
`run.result.accepted`, and pass the existing reload/result/clock/lease checks.
The100-run case must independently verify all51200 deltas. Stop keeps its
original cancellation, durable acknowledgement, local journal, PID/group/provider
absence and lease checks; it must not acquire an accepted success result.

An observation ceiling, failed/cancelled remote run, missing event/result,
unexpected API error, incomplete source clock, replay conflict or cleanup error
is ineligible. Preserve its raw partial evidence and censoring state. Never
substitute the ceiling as latency, compute a512-event tail from a visible prefix,
discard a slow arm, retry it into the sample, cancel background work to make a
pair finish, or hide work remaining after the measured interval.

Each comparison-manifest entry contains `baselineFile`, `candidateFile`,
`baselinePlaywrightFile`, `candidatePlaywrightFile`, `baselineInventoryFile`, and
`candidateInventoryFile`. The owning Playwright result must contain exactly that
evidence attachment, one passed observation attempt, retry0, no errors, and the
actual1200s timeout. An inventory sidecar binds that report hash to the exact
gzip inventory bytes, full descriptor aggregate, summary and qualified build
receipt hashes, source/build revision, and reported serving/native fingerprints.
These frozen artifacts are evidence of the qualified build; the external owner
still checks the live checkout/build inventories before each arm. A sidecar does
not itself attest that the live filesystem stayed unchanged.

| Role | Allowed original failures | Required result |
| --- | --- | --- |
| Fresh B0/B1 A/A arms | Known burst512 streaming120 miss; explicit conservative observed-duration900 miss | Complete finite correct observation; root-reviewed noise suitability |
| B0→B1 cursor-only candidate | Only an exact registered known miss also present in the paired baseline: burst512 streaming120 or conservative observed-duration900 | No additional deadline failures; latency/control nonregression plus separate incremental SQL evidence; never claim SLA fixed |
| Final B2 candidate in either comparison | None | Every arm meets original streaming/control checks and conservative900 gate; loaded improvements and later H4e proof |

Only burst512's streaming miss is registered as a known workload SLA failure.
New failures in other workloads require diagnosis. The existing Stop poll
ordering is preserved; no invented absolute click→ack30s requirement replaces it.

## Stage order and acceptance

Prospectively freeze **B0 A/A → B1 A/A → B0→B1 nonregression → B1→B2 → B0→B2**.
Each stage has exactly five fresh alternating pairs, separate disposable state
per arm, matched payloads/load/resource/cache policy, no reused baseline arms,
and no concurrent builds/profilers/benchmarks on the measurement VM. Root reviews
and freezes both complete A/A envelopes before any further product fix. Local
product implementation can then proceed while the unchanged B0→B1 stage runs;
the candidate VM build waits until that stage is quiet.

Keep the existing per-metric maximum absolute paired A/A envelope, median gate,
and at least4/5 individual noise-exceeding loaded wins. Each loaded p95
emission-to-visible, p95 intended-to-visible and terminal-drainage metric must
improve; other fixed latency/control metrics must not regress outside noise.
Do not infer p99 from sparse observations. There is no new fixed percentage A/A
cutoff: root must reject unsuitable noisy/nonstationary calibration explicitly.

Use `--observation-mode=h5c-observe-original-sla-independent-agents-settlement` for the comparator. Candidate
comparisons also require `--candidate-policy=cursor-nonregression --expect=nonregression`
or `--candidate-policy=final-b2`. Final comparisons expose `performancePassed`
separately; `acceptancePassed` remains false until `--original-h4e-proof` and
`--original-h4e-inventory` establish the later fresh H4e default-deadline functional pass.
That H4e proof is full, unprofiled, retry0, default mode with original120/180/900s
bounds, on the same frozen H5c harness source, nine-file measurement bytes and
independent-agent geometry, and the exact final SUT revision/qualified inventory.
It uses a new disposable company and starts after all candidate arms. Old7d/H4c
proofs and H5a observations cannot confirm this geometry. Prior failed H4c attempts remain in the record.
Confirmation reuses the measured arms' authority, physical Stop, local lease and
remote lease binding/settlement checks. The original30s polls keep their existing
ordering; no absolute click-to-acknowledgement deadline is added.
Use the explicit H5 `--require-performance` gate for the two final comparison
stages while that later proof is pending; this requires every performance and
candidate original-SLA gate, but grants no final acceptance. After the one later
H4e default-mode qualification, recompute both reports against their unchanged paired
manifests with the proof and `--require-acceptance`. This re-evaluates retained
evidence; it neither reuses an arm in a different comparison nor reruns failures.

Before any runtime release, review the exact H5 protocol/comparator/helper
hashes, registration dry run, outcome/eligibility tests, types and test listing.
Then qualify the changed observation path before fresh A/A. Each later stage
requires a separate root release pinning exact driver, build/inventory and
reviewed noise-report bytes; verify the noise hash before the first arm and
again before comparison. Product or workload changes require new prospective
provenance and affected requalification; do not loosen gates after results.

Separate successful full-window diagnostics may later assess Node/PG CPU,
queue/backlog, delay and memory with identical capture hooks. Aborted profiles
remain diagnostic-only and cannot establish complete CPU/event costs. No CPU
requirement or profiling is added to this timing comparator. Local results do
not establish deployed improvement.
