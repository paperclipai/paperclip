# H5 complete observation registration (prospective; no execution release)

H4c remains frozen at `7d7e7a88d562a95a1d407b76474763b666c181f5`
(`5db4129bbdc1fa38775121aff5d0e68a8a11762519e41cfdf36eacd90ba7256b`).
Its observed 120-second streaming failures remain failures. Aborted or profiled
attempts cannot be reused as complete timing arms. H5 repairs observation of the
final outcome; it does not optimize the product or turn those failures into passes.

The fresh application baselines remain B0 `a36567f9fbf805ad72207d54f539516e3121741e`
and B1 `d8cd3be0aeed4f9fb93ecc3cf725f1d46d5a0310`. Current B2
`914129afb141d81c0d6d8c5f0ea11c20bd69a3da` has an observed original120s failure;
it is not already qualified. A later candidate uses its exact new immutable
revision, complete build receipt and inventory; no old binary is presumed equal.

Select H5 explicitly with
`PAPERCLIP_INGESTION_OBSERVATION_MODE=h5-observe-original-sla`.
The default code path retains the H4c 120/180/900-second behavior. H5 emits a new
protocol version, hashes its added helper with the driver sources, and records a
separate registration/workload SHA. The original comparator mode rejects H5.

Run `node scripts/describe-native-ingestion-h5.mjs` to inspect the registration.
This is a dry run only: it starts no app, provider, database or browser and
accepts no execution arguments. It grants no runtime release.

## Fixed work and observation boundaries

Keep the five streaming cases and original local Stop case exactly as H4c:
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
| All terminal runs |180s after foreground completion (and Stop click) | Same180s after eventual foreground completion; hard failure at the ceiling |
| Stop acknowledgement and leases | Existing30s polls and ordering | Unchanged; full click→acknowledgement metric retained |
| Invocation | Original900s test budget | Actual1200s observation timeout, separately disclosed |

The first120s poll is the original matcher. Only that exact known matcher
deadline can extend observation. Page/API errors, other assertions, terminal
failures and cleanup failures never become an allowed SLA miss. There is no
collection wait when markers are available. The600s ceiling is absolute, so a
120s miss leaves at most480s additional observation, not another600s.

Record the original wait start/deadline, actual last count and its observation
time, assessment time and error before continuing. Keep the original failure
after completion. The original120s clock starts before the common source epoch;
it is not silently rebased to epoch+120s. Derive a separate paint-deadline count
from retained2RAF timestamps; do not mislabel it as the original poll's count.

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
in every arm and later pass one unchanged original H4c full invocation on the
same final SUT revision and full qualified artifact inventory.

## Complete evidence and eligibility

H5 `observationComplete` means all six cases reached finite correct outcomes,
with every expected participant and foreground marker. It does not mean H4c
passed. Every remote run must succeed in native mode, retain every normalized
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
| Final B2 candidate in either comparison | None | Every arm meets original streaming/control checks and conservative900 gate; loaded improvements and later unchanged H4c proof |

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

Use `--observation-mode=h5-observe-original-sla` for the comparator. Candidate
comparisons also require `--candidate-policy=cursor-nonregression --expect=nonregression`
or `--candidate-policy=final-b2`. Final comparisons expose `performancePassed`
separately; `acceptancePassed` remains false until `--original-h4c-proof` and
`--original-h4c-inventory` establish the later fresh original functional pass.
That proof is full, unprofiled, retry0, original900s, on the exact final SUT
revision/qualified inventory, with a new disposable company and a start time
after all candidate arms. Prior failed H4c attempts remain in the record.
Use the explicit H5 `--require-performance` gate for the two final comparison
stages while that later proof is pending; this requires every performance and
candidate original-SLA gate, but grants no final acceptance. After the one later
original H4c qualification, recompute both reports against their unchanged paired
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
