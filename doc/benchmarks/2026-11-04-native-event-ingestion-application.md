# Native ingestion application acceptance

Status at 2026-11-04 10:00 UTC: **application acceptance remains open**. Source
append measurements passed their registered gates. No production-application
A/A calibration, paired browser improvement, or deployed improvement is claimed.
Both delivery PRs remain drafts.

This report records the application inputs and qualification evidence. The
[source report](2026-11-03-native-event-ingestion-interleaved.md) measures active
append-service work; it does not establish application burst drainage or browser
latency. The dependent batching PR owns incremental and combined results.

## Matched application builds

All three inputs normally merge upstream
`4a83ba4050f6e6d334fe4cb6e3ace050097530ce`. They use independent normal locked
application installs and production builds. The browser driver has a separate
frozen install; the application checkouts' test files are not the executed driver.

| Arm | Immutable application revision | Role |
| --- | --- | --- |
| B0 | `bac53ec3bfeaf6546e7aaeaee516487b30534654` | Matched baseline |
| B1 | `07061a601cdc20603c8c7a46f9ddbad7ac5f5939` | Cursor change |
| B2 base | `ca7cba171cd5198ed569d75012edc858041cbc44` | Unoptimized batching base |

All three normal builds exited zero. Their shared native inputs have Rust tree
`bbe29bba574ce8d5cfddf2f7461ae0eb5983df07` and binary SHA256
`abb65bdc073991e428bd37f9809603ee7564543cca0ed0305dc231137c93070f`.
Native target reuse was limited to the same 15 native build inputs. Each
application has its own Node dependencies and compiled output.

The qualified-build receipt SHA256 is
`a1259ba760f3cbbe44817e333f9f620bcf3769fb0a6c16f9ce2f0f5b2ed60d94`.
The inventory-summary SHA256 is
`d3766fc4206d569d10fd02224433f1e9a2caa6992a7c62216e80af368aa4e44d`.
Inventories cover `server/dist`, `ui/dist`, `packages/db/src`, and
`packages/shared/src`: 12,884 / 12,898 / 12,906 files respectively. Every measured
arm must validate its actual files, preferred-UI-shadow absence, native binary,
clean source and compiled revision against the qualified inventory again.
Source/build-input comparisons match the frozen B1/B2 to the delivery branches;
this excludes test/tooling differences rather than executing the delivery lock
as the browser driver.

These are build qualifications, not performance results. A further Rust change
needs its own immutable revision, normal build, binary and qualified inventory.
The existing B2 base cannot stand in for that candidate.

## Retained full-load qualification failures

Earlier H4c application attempts missed their original streaming deadline;
[their report](2026-11-03-native-event-ingestion-h4c.md) remains retained. Later
qualification failures are also excluded from paired performance samples.

| Driver registration | Application baseline | Workload authority | Original 120s streaming observation | Eventual foreground completion | Final observation before teardown |
| --- | --- | --- | --- | --- | --- |
| H5a, `7388e24d` | Historical `a36567f9` | Two agents, 50 runs each | 54 of 512 foreground markers | 512 at 296.555s from poll start | 86 succeeded; 14 retryable failures |
| H5b, `179fe6fa6da1b24ca08c1162301538d3e3788af6` | Matched `bac53ec3` | 100 independent agents, one run each | 61 of 512 foreground markers | 512 at 282.734s from poll start | 83 succeeded; 17 retryable failures |

Both attempts independently verified all 51,200 durable deltas against original
emission identities, payloads and clocks, and 100 accepted results. Those counts
do not establish final settlement or lease cleanup. Existing-history and Stop
cases were not reached.

H5a's 14 failures encountered 30-second merge locks on the two shared agent
directories. The later independent-agent experiment does not establish a product
fix for that topology. A separate PostgreSQL deadlock on a succeeded run does
not establish the failed runs' wait cycle.

H5b's 17 failures were different: their logs recorded suspension but no timely
provider-drain receipt after the five-second wait. The reason the receipts were
late remains unproved. The observer treated failed native `retryable_failure`
runs as terminal and stopped the application before their first supported retry.
The first retry was due at 05:40:32 UTC; teardown occurred at 05:40:26 UTC.
The global scheduler was enabled. Eligibility and recovery execution were not
observed, so this failure does not establish either recovery success or failure.

The complete raw attempts, stopped-database read-only checks and source logs
remain sealed privately. Public summaries include only the fields above; raw
process, configuration and provider logs are not wholesale publication inputs.

## H5c qualification

The frozen driver is
[`e431ec63d41fe90c6fd68bd2fc2bb969feeca917`](https://github.com/paperclipai/paperclip/tree/e431ec63d41fe90c6fd68bd2fc2bb969feeca917),
tag `native-ingestion-h5c`. Its nine-file measurement SHA256 is
`2265aabe9c7344f5d4b9c8b08a5c6bbd5571a6e2de9ae7b72a8d1733250e609f`.
The [registered protocol](../../tests/e2e/fixtures/native-ingestion-h5.md) and
[exact execution helpers](../../scripts/native-ingestion/h5c/README.md) provide
reproduction commands, dependency provenance, bounded resource ownership and
pass/fail gates.

H5c observes retryable finalization inside the same single 180-second terminal
window. It records observed transitions and current/retained recovery errors.
Final success, complete events/results, and lease cleanup remain mandatory.
The retained recovery marker contains the last failure; it is not an exhaustive
history of every retry. Comparisons reject new recorded error classes and retry
rates outside freshly frozen baseline noise. No manual retry or new provider
turn is introduced.

The original 120-second streaming and 900-second invocation limits remain.
Extended observation preserves original deadline misses as failures. The final
candidate must pass every original limit in every arm and later pass a separate
default-mode original-SLA invocation with the same source and qualified build.

The SMALL B0 functional qualification passed one Playwright attempt without
retry: 49.6 seconds including hooks, 33.0 seconds in the test body. Three remote
fixture runs retained 48 deltas with unique identities and original clocks,
three accepted results, reload persistence, and successful lease cleanup. A
separate normal local Stop run retained eight canonical deltas, zero accepted
results, native cancellation acknowledgement, independent runner/group/provider
absence and a released lease. Both cases recorded zero retries. This small case
does not exercise recovery under the 100-run load and does not qualify real
cloud Stop.

The small report SHA256 is
`1c1ec8a0163e09fd75cabf3616374e8b185165a23c425f57794840c72b40782c`;
the 25-file seal manifest is
`6db1d2d41375a965fefa266a1d2bd47ddf9ad6f8d07773d7bde8a7bb8786b959`;
the sealed archive is
`50837389f0d2737a7f7ec249e75760da0aee366eeea881a9ce58f99025f20f83`.
Independent lead review verified those bytes, the owning attempt's attached
report, original clocks, recorded-failure proofs and external process/port
cleanup. The legacy raw `performanceAcceptanceEligible` flag denotes an
unprofiled run; `qualificationOnly: true` is independently rejected by the frozen
performance assessor. No flag or raw report was rewritten to change eligibility.

## H5c full failure and independently verified persistence

Full H5c B0 qualification failed at its unchanged 1,200-second observation
limit during independent durable-event verification. The foreground showed
66 of 512 markers near the original 120-second deadline and all 512 at
283.391 seconds after the epoch. All 100 runs succeeded within 75.926 seconds
of the original single 180-second terminal window. Fourteen transient provider
transport failures recovered; no nonretryable failure remained.

Independent lead review verified the owning report, 56 raw files and eight
read-only stopped-PostgreSQL supplement files. All 51,200 durable deltas match
the original emission identities, payloads, ordering and clocks; all 100 results
were accepted, finalizers committed and leases released with successful cleanup.
This does not establish that those events committed before the original
streaming deadline. The owning Playwright attempt timed out after verifying
only 33 of 100 runs through its API oracle. Existing-history and Stop cases
were not reached. API cleanup encountered a disposed request context; separate
physical-quiet and port checks passed. The attempt remains failed and ineligible.

The failed report SHA256 is
`4946558e5a04377650661cbe2c0d5d45b755ef77f5064399e4df8889c3f7b595`;
the raw seal manifest is
`2adb8afed5a10c6dc2091d7946a2e2d3bfc8ad6677613b46c20b1190d5ce47c8`.

## H5d prospective correction

The separately frozen driver is
[`2df9897e1ce2ca90be29fa097d776c3766e217ad`](https://github.com/paperclipai/paperclip/tree/2df9897e1ce2ca90be29fa097d776c3766e217ad),
tag `native-ingestion-h5d`. Its nine-file measurement SHA256 is
`e1d8930c47b4d3a287aa0f3baf09fbd3aa04ac30b9313b707616dea7a3fec5d4`;
the comparator SHA256 is
`09daef50fad5eef4dbda4e63a191749d0d167d3ae9d38bfd22df8721e2aac4a3`.

Plain assertions replace individual Playwright steps in bulk readback while
preserving payload, identity, original-clock, ordering, result and Stop-prefix
checks. Workloads, browser observation, APIs and deadlines stay fixed. A
separate no-application diagnostic measures oracle cost; it establishes no
product performance gain. H5d has now completed its own small and full functional observation. Fresh
A/A calibration remains separate; qualification attempts are not reused.

Before observing A/A data, the comparator registers suitability limits for
paired difference and chronological/role drift. It freezes actual absolute and
relative noise; its two-millisecond timestamp representation floor never pads
a regression allowance. Short measurements cannot support subfloor, percentage
speedup or p99 claims. Fully verified completion now has its own quantitative
gate: faster browser delivery or terminal status cannot hide slower final
drainage, missing readback or unclosed leases. Its conservative completion rate
includes verification, reload and lease observation; it is not the exact last
commit time. All comparison arms must be fresh, and every final-candidate arm
must meet the original limits as well as a later same-source original-SLA run.

## H5d qualification and calibration status

SMALL passed one owning attempt: 48 normal deltas across three remote fixture
runs, three accepted results, reload persistence, and a separate local Stop with
nine canonical deltas, zero results, acknowledged cancellation, Runner PID/group
and provider PID absence, a bound server retirement receipt and released lease.
Lead review verified all 40 sealed files and the exact owning attachment.

FULL passed one owning test attempt without retry in 853.339 seconds; the whole
command took 870.711 seconds. Independent readback completed all six cases:

| Case | Measured deltas | Accepted results | Fully verified drainage from epoch |
| --- | ---: | ---: | ---: |
| Paced single stream | 128 | 1 | 8.662s |
| 16-event burst, one run | 16 | 1 | 6.589s |
| 128-event burst, ten runs | 1,280 | 10 | 15.287s |
| 512-event burst, 100 runs | 51,200 | 100 | 402.584s |
| Foreground history under ten concurrent streams | 1,280 | 10 | 17.088s |
| Local Stop | 9 | 0 | 3.948s |

The history case is **one foreground run with 1,000 persisted prelude events
under nine fresh concurrent streams**. The frozen workload explicitly gives
background streams no prelude. A normal event-API read verified the foreground's
1,000 unique prelude events and retained global head 1062 before the common
epoch. It does not establish that all ten runs have 1,000-event histories.

The baseline still failed the original loaded-streaming limit: 41 of 512
foreground markers were visible at the last observation near 120 seconds.
Foreground completion took 287.750 seconds; terminal settlement then took
103.326 seconds, followed by 12.483 seconds of verification. Forty-three
recorded provider transport failures recovered; all 100 runs succeeded and their
leases closed successfully. The original 900-second owning-test gate passed.
This is complete functional observation with a retained responsiveness failure,
not passing application performance acceptance.

The full report SHA256 is
`d12ad9128d6a30bc335a69761d6004b2b3618fc275a07a84ef5434cfdb00b1e1`.
Lead review verified 38 sealed files, exact owning attachment, all source-clock
prefix joins, counts, results and leases, and reran the frozen assessment on
those bytes. An independent postreader initially assumed the foreground was the
first element of an API run list. The actual foreground was element 9. The
preserved failure was corrected in a separate offline reader by joining the
foreground token, durable proof, provider clock, activation and authority row;
event-count and timing checks remain. The owning attempt, raw seal, measurement
source and workload were unchanged. No failed application attempt was regraded.

A separate no-application diagnostic confirmed assertion-framework overhead for
synthetic 1,000-event inputs: five samples each gave medians of 3,859.190ms for
the old Playwright assertions and 1.954ms for plain assertions. Playwright
samples increased chronologically from 1,843.546 to 5,655.339ms; plain assertions
ranged from 1.363 to 3.017ms. This is neither a stable product-cost distribution
nor an exact attribution of the earlier full-run timeout.

Fresh B0 A/A began at 09:30 UTC. Two of ten invocations have completed and the
third is running. No noise envelope or paired application gain has passed.

## Blocked-write Stop qualification

The separate companion emits its own 1,000-event prelude through normal
ingestion, confirms a real append blocked by an owned run-row lock, then presses
Stop through the UI. During a fixed hold after the actual HTTP request it
requires no committed cancellation intent or audit, a pending response, ongoing
emissions and both birth-identified process groups alive. Public Stop must
commit its own intent under the same run lock; postrelease measurements retain
that durable boundary rather than treating a blocked intent as dispatch delay.

Two qualification failures remain excluded. V1 failed before the measured
epoch because it incorrectly assumed the provider shared the Runner process
group. Its cleanup left live processes; separately recorded manual cleanup
retired those owned processes. Manual cleanup is not successful Stop evidence.
V2 measured the held-write boundary, its own acknowledged intent and audit
records, and physical exit of both independent groups. It then failed an
unsupported unconditional `native.local_process_stopped` assertion. Transcript,
reload and lease checks after that assertion were not reached. Normal cleanup,
port and strict physical-quiet checks passed without manual signals.

The product supports two termination-proof states: retained original process
identities with verified physical absence, or cleared identities with a
server-authored retirement event bound to the latest launch/identity. The
retirement event is authoritative evidence for identity clearing; immediate
cancellation acknowledgement does not universally require it. The separately frozen
v3 oracle checks this distinction in a coherent authority snapshot after the
existing lease poll, without adding a wait budget. It also retains the own-intent,
audit, physical-group, lease, transcript and reload requirements. V2 cannot be
regraded or reused as an accepted arm.

V2 source is `6e5349cdbd5e3a197877f1082f84a17e866c03e7`; its failed report
SHA256 is `0ab6c383a07c57f5eb16f226d0e458c70b6d6800e3d9dce051e3d2ca53bba20e`
and 42-file manifest is
`f81168c2d0c2218d658e1c6422b074fe80d10de9d88ad752c0b04fc54b1cde65`.
Independent lead review verified those bytes and the owning attempt's attachment.
Those two failed trials remain excluded. V3 at
`bc33f09cae26404352848169d92a20c89480a5f5` subsequently passed one independent
qualification. Fifteen held samples covered 1,010ms after the actual Stop POST
with no committed intent/audit, response pending, and both original groups
alive. After release it verified the same own native intent and audits, both
identified PIDs and both independent process groups absent, cleared mutable
identity backed by the latest bound server receipt, and the exact local lease
released without failed cleanup. The 1,000-event prelude, twelve canonical Stop
deltas, zero results and persisted reload were verified. API cleanup and strict
physical quiet passed without manual signals.

Lead review independently verified all 49 files, the ten arm-artifact seals,
the exact owning Playwright attachment, and the frozen functional oracle. V3 raw
report SHA256 is
`66ebb86acfb5de5a3140ec4a5db104775265fc296c8e831d2964d065359a739b`.
This qualifies that functional path; control-latency acceptance still needs its
own fresh baseline noise and paired comparisons, distinct from the main matrix.

## Remaining acceptance

No application A/A or paired browser improvement has passed. No proposed Rust
optimization is implemented. Remaining gates are fresh B0/B1 application and companion noise; all three paired comparisons; loaded browser
and complete-drainage improvement; sparse/control nonregression; complete-window
resource accounting; original-SLA confirmation; affected live-provider and real
cloud Stop journeys on the final runtime; and current-head checks/review.
Local evidence establishes no deployed improvement.
