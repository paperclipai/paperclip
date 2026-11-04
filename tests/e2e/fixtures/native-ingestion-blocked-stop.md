# Existing-history blocked Stop companion (prospective v1)

Status: local source and pure oracle calibration only. No application, browser,
PostgreSQL, VM or quantitative arm has run. No runtime qualification or performance
claim follows from the pure tests. Execution needs lead release after independent
source review. This is separate from the immutable H5c 50-arm campaign.

## Registration and ownership

Explicit config: `tests/e2e/playwright-native-ingestion-blocked-stop.config.ts`.
Explicit source: `tests/e2e/native-event-ingestion-blocked-stop.journey.ts`.
Protocol: `blocked-stop-history-v1`; workload digest comes from the exact exported
`WORKLOAD` JSON in `native-ingestion-blocked-stop-protocol.mjs`.

The config inherits the unchanged H5c production-built app bootstrap, local
Codex command fixture, normal local environment, and shipped UI. It selects only
the companion source and fixes a 900-second test budget. There is one owned
control agent and one task created and assigned through visible normal controls.
Provider execution is a deterministic existing Codex leaf fixture, not a live
model or a real Cloud provider. This companion grants no Cloud Stop qualification.
No resolver override, HTTP/API change, persisted outcome seeding or app/product
code change is included. Authority/gate/paint code is a bounded copy from H5c
`e431ec63d41fe90c6fd68bd2fc2bb969feeca917`; the original nine measured files stay
unchanged. The new files have their own source identity and review.

## Fixed workload and functional gate

All variants emit 1,000 actual prelude deltas, independently read back through
normal event APIs before the common gate releases. They then emit 256 compact
markers at 100 ms, fitting the unchanged 4,000 character Rust text bound together
with the prelude. Readiness is bounded at 300 seconds, measured streaming at
120 seconds, terminal settlement at 180 seconds; original later 30-second ACK
and lease observations remain after settlement. Setup stays inside the owning
900-second test budget. Server bootstrap retains its existing separate limit.

After at least three visible markers and before Stop, a separately owned
PostgreSQL connection acquires `FOR UPDATE` on the exact company/run row. A
second connection reads `pg_stat_activity` and `pg_blocking_pids` and must see
an actual append query waiting on that holder. Its SELECT projection prefix is
checked against the B0/B1/B2 source signatures, distinguishing cancellation's
full-row SELECT. Raw SQL metadata is retained privately; no product hook is used.

The ordinary visible Stop button must cause the actual matching public POST.
For at least 1,000 ms after that observed request, repeated independent snapshots
must show pending HTTP, no committed native cancellation intent or audit, the
same runner/provider PID births alive in their exact group, and an open fixture
clock. The fixture closes that clock on `turn/interrupt`. Provider emissions must
continue across the hold. The hold is not subtracted from action-to-ACK latency.
A late sample/query/timer can overrun the minimum; actual boundaries stay visible.

Release records both COMMIT request and COMMIT response acknowledgement. Neither
is claimed to be the exact PostgreSQL commit instant. Independent observations
then require the cancellation intent and its own matching committed audit,
native acknowledged dispatch and its own matching acknowledgement audit,
normal cancelled settlement, successful Stop HTTP, server-authored
`native.local_process_stopped` receipt for the exact prior PID/group, independently
absent runner/group/provider, and the exact owned local lease released without
failed cleanup. Transcript checks require complete compact payloads, unique source
identities, ordered canonical prefix, original emission clocks, zero accepted
results, and persistence after reload. The raw transport recovery policy stays
unchanged: raw fixture emissions after the canonical prefix are not represented
as universally database-durable.

The native receipt, shared `executionCancellation` metadata (including absence)
and public cancelled run are recorded separately. The native dispatch audit must
match the same intent and intent audit, `dispatched: true`, and nullable decision
ID. A non-null decision is independently correlated through the owned
`status_decisions` company/issue/run row. Run-only Stop may have no decision; a
missing optional decision or shared field is not silently invented. A shared ACK field is not synthesized from
row `recordedAt` or a provider clock. Source/runtime review must confirm which
shared receipt contract the serving revision exposes before releasing the probe.
No universal 30-second click-to-ACK gate is introduced.

Every actual ACK query and process check through its first success retains its
start, completion, duration and boolean observation. An uncertainty bracket runs
from the last negative query/check start (conservative for snapshot-read timing)
or release-COMMIT-ACK when no negative was seen, through first successful
completion. Both negative and successful operation durations stay explicit.

Timing includes action-to-observed-native-ACK, release-COMMIT-ACK-to-independently
observed absence, and release-COMMIT-ACK-to-observed-native-ACK. Both release
request-origin values also remain. Last unsuccessful and successful-query/check
bounds are retained with a 50-ms poll interval; query duration and scheduling add
uncertainty. Screenshots and reload happen after those timing observations.

Any failure, timeout, censored observation, query/clock fault or cleanup error
makes the arm ineligible. Partial raw Playwright results and the final attachment
remain even after failure. Cleanup first releases/rolls back only the owned lock,
closes both connections, retires its clock, settles only its owned run and restores
owned experimental settings. The external operator must independently prove the
server, database, runner, provider and browser are gone before the next arm.

## Separate quantitative registration (50 short arms)

Generate the explicit registration without executing an app:

```sh
node tests/e2e/fixtures/native-ingestion-blocked-stop-validate.mjs --registration
```

Order is B0 A/A five fresh alternating pairs, B1 A/A five fresh alternating pairs,
then B0→B1, B1→B2 and B0→B2 five alternating pairs each. Each pair is two fresh
owned invocations with matching data/load/payload/resource/cache conditions.
There are no repeats hidden inside an invocation. Keep the original main 50 arms
and their noise files untouched.

Before any companion data, freeze this exact suitability rule independently per
metric. The precision budget is `max(2 * 50 ms, 0.10 * pooled ten-arm A/A metric
median)`. Both the maximum absolute paired difference and the absolute median
drift between the first five and last five chronological arms must fit that
budget. Every raw ACK/absence observer bracket must also fit the corresponding
metric budget; action-to-ACK uses the ACK observer bracket. This is a
measurement repeatability rule, not a product Stop deadline.

Only suitable calibration freezes its observed maximum absolute paired
difference as noise. B0 comparisons use B0 A/A; B1→B2 uses B1 A/A. Every paired
candidate difference and their median must remain within that own frozen noise,
and all comparison observer brackets must fit the frozen baseline precision
budget. No unblocked Stop noise is reused. An unsuitable ten-arm calibration
retains every raw arm and produces no usable noise envelope: no silent
replacement, budget increase or inflated envelope follows from noisy data.

`noiseEnvelope(pairs)` takes five logical `[baseline, candidate]` raw-report
pairs whose chronological order alternates baseline-first then candidate-first.
It validates the full functional oracle for every arm, requires ten distinct
owned runs/companies with nonoverlapping arm times, and returns the structured
`paperclip.native-ingestion.blocked-stop-noise.v1` artifact. This contains
sample counts, all raw arms and report digests, logical pair bindings, actual
absolute/percentage median differences, spread, chronological drift, budgets,
query/check uncertainty brackets, suitability, and nullable noise values.
Percentage fields are null when the 100-ms precision floor determines the
budget. Those metrics are labeled **100 ms resolution floor** and cannot support
subfloor, p99 or percentage speed claims. Ten observed arms do not establish p99.

`assertNoiseEnvelope(artifact)` revalidates all retained functional proofs and
recomputes suitability and numeric limits; unsuitable or inflated artifacts
throw. `comparePairs(pairs, artifact)` validates every comparison arm's complete
functional proof and returns per-metric `.pass` results using only that
baseline's unchanged frozen noise and budget. It rejects reused runs,
nonalternating/overlapping arms, missing lock/ACK/process/lease/transcript proof,
and forged `complete` flags. Preserve all failures and censored arms outside
these successful artifacts as well. A single functional probe is not
quantitative nonregression evidence.

## Reproduction and execution gates

Credential-free local checks, with Node 24:

```sh
node --test tests/e2e/fixtures/native-ingestion-blocked-stop-protocol.test.mjs
node --check tests/e2e/native-event-ingestion-blocked-stop.journey.ts
node --check tests/e2e/playwright-native-ingestion-blocked-stop.config.ts
node tests/e2e/fixtures/native-ingestion-blocked-stop-validate.mjs --registration
```

Before runtime, the lead must review/freeze the companion source, workload digest,
registration, validator and companion-only release descriptor. Keep the reviewed
H5c private runner `6b6376b01de6cdc15ca05343a0bdd5c00424f1d6c546b9b4d61cd76716b253c4`
unchanged. A companion orchestrator should import its checked exported
`validateVariantBuild`, `validateActualInventory`, `assertNoPreferredUiShadow`,
`physicalQuietGuard`, `sealArmArtifacts` and `verifyRawArtifactSeals`; it must not
invoke or alter the original stage plan. Bind each arm to exact source/build/UI,
qualified receipt, full inventory manifest, Node/dependency/native pins, unchanged
frozen fixture hashes, companion hashes, recording-off flags and a clean source.
Use original B0 `bac53ec3`, B1 `07061a60`, unoptimized B2 `ca7cba17` only where
explicitly released; a future optimized B2 needs its own qualified descriptor.
The existing build receipt `a1259ba7…`, full inventory `d3766fc4…` and native binary
`abb65bdc…` are provenance, not substitutes for current artifact validation.

Only the performance owner may stage/execute on the sole benchmark VM, after
lead release. First do discovery, narrow static typecheck, and one smallest
functional qualification with raw Playwright, server/banner, PostgreSQL blocker,
process/clock and external cleanup evidence. Validate its extracted attachment:

```sh
node tests/e2e/fixtures/native-ingestion-blocked-stop-validate.mjs RAW.json RECEIPT.json
```

Do not start the 50-arm registration until the source and runtime probe qualify.
Capture quiet before/after-arm receipts, owning Playwright exit/status/duration,
raw API/SQL/process evidence, immutable report seals, and all cleanup outcomes.
The source validator is an additional functional oracle; it cannot establish the
owning Playwright pass, infrastructure cleanup, build authenticity or performance
on its own. Freeze separate B0/B1 A/A noise before nonregression comparisons.
