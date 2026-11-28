# Hot-upgrade qualification

Date: 2026-10-22. Owner: the existing Runner protocol, native runtime integration,
and Product E2E harnesses. Related implementation: [hot upgrades](2026-10-21-daytona-hot-upgrades.md),
[continuity runbook](../testing-native-remote-continuity.md), PR #17097.

## Acceptance contract

An admitted remote agent keeps its sandbox, runner process, provider session and
active turn while the control plane is unavailable for up to 300 seconds.
Server-dependent calls wait and reconnect. After HTTP returns, admitted work and
queued launches recover automatically and new work can launch without an operator
drain. The runner's existing 420-second reconnect grace includes server startup
and ownership acquisition; tests must not reset that deadline on each retry.

Postgres, the instance encryption key and the sandbox survive. This does not
promise HTTP availability while the only web server is offline, survival of a
destroyed sandbox, retroactive support in older running binaries, or reconstruction
of an acknowledged display-only log tail. Never repeat a provider turn or external
effect to fill a display gap.

## Review stack and ownership (2026-10-24)

Four PRs, reviewed in this order. PR #17097 is reused for the runner slice.
The full pre-split branch is retained as `codex/hot-upgrades-reference-2026-10-24`
at `858cfd1fdf621c56a8ce7615bdf5aecc9cf1bb61`.

| Slice | Owns | Acceptance evidence |
| --- | --- | --- |
| Runner contract | Optional opaque checkpoints, authenticated cursors, durability barriers, retention and deadlines; one-process scripted executor fixture | Outage progress, waiting, replay, persistence failures and backpressure; consumer compatibility and protocol/dependency checks |
| Server adoption | Postgres migration/encryption, transactional fencing, startup/expired-owner recovery, tool authority, detach/Stop/finalization and bounded retention | Real Postgres races, empty disk, uncertain mutations with independent effect ledger, admission and SQL gates |
| Upgrade qualification | Existing supervisor and installed-artifact verification; immutable A/B upgrade and compatible rollback, phase receipts and hosted paths | Natural lease acquisition, original execution identity, exact artifacts, short/full outages, cleanup and admission within 420 seconds |
| Transcript delivery | Additive WebSocket negotiation and run interests; shared visible browser subscriptions, catch-up and bounded delivery | Native/legacy journeys, subscription races, reconnect, congestion, company/access changes and measured viewer costs |

Tests and documentation ship with their owning behavior. Qualification defects
are fixed in the owning earlier slice. Transcript delivery is functionally
independent and has no migration. Browser interest never changes harness execution,
PRP ACKs, checkpoints, accounting or canonical logs.

The deterministic fixture links the production runner core and a scripted
`CommandExecutor` in one process. Its counter records completed workload steps;
no auxiliary daemon, HTTP service, production test endpoint or fake-provider
admission option is introduced. It distinguishes useful progress from waiting
on control-plane results and from bounded output backpressure. Synthetic execution
never qualifies an underlying harness.

Compatibility starts at the first hot-upgrade-capable protocol release. Test the
oldest supported artifact and previous release, as well as compatible rollback.
A frozen branch artifact is explicitly development-build evidence until releases
exist; HTTP readiness or a replacement task is insufficient evidence of continuity.

## Current execution evidence (2026-10-24)

The review stack is [Runner #17097](https://github.com/paperclipai/paperclip/pull/17097)
→ [Server #17439](https://github.com/paperclipai/paperclip/pull/17439)
→ [Qualification #17455](https://github.com/paperclipai/paperclip/pull/17455)
→ [Transcript delivery #17456](https://github.com/paperclipai/paperclip/pull/17456).
None is deployed. The remaining acceptance gates below are not waived.

The final security review found that cache-independent adoption skipped a
preparation callback which also checked managed-project grants. The correction
keeps policy in the plugin adapter: Runner retains at most two opaque configuration
IDs bound to exact execution identities and calls an optional authorization hook
before registration. The adapter calls existing `check_project_auth` with current
project IDs. Existing consumers without the hook keep the preparation callback;
missing cache or bindings fail closed. No extra process, periodic check, or text
checkpoint is introduced. Four transport regressions fail on the previous code;
28 focused runner tests, the complete 429-test controller/transport suites, all
34 plugin-owner tests and three real-Postgres SDK integration cases pass with the
correction. The SDK regression exercises current-grant revocation through the
actual runtime and plugin serialization, with synthetic provider resources.
One warm-handoff case timed out during concurrent server compilation; the isolated
rerun passed. The first Postgres attempt failed before tests because Docker
returned an engine startup error and no database was listening; after engine and
database readiness were confirmed, the integration rerun passed. Runner/server typechecks and protocol/dependency checks pass. Current
CI and review status remain on the linked PRs rather than treating older heads as
proof of this correction.

The next review found a stale Copilot source identity and a checkpoint fence that
sampled database time before waiting for a row lock. The generated active profile
and existing controller mocks are updated; all 90 affected runner compatibility
and permission tests pass. The writer now locks in a CTE and samples wall time in
the outer query, retaining one SQL statement and round trip. Its real-Postgres
regression fails on the prior writer and passes with the fix, without changing
stored checkpoints after expiry. The full recovery run passed 38 cases and skipped
five optional profiles; two unchanged renewal cases failed while Docker became
unavailable. After restoring the daemon and a confirmed-ready database, both
renewal cases and the new lock-expiry test pass together with natural lease timing.
The repeated 8/512-chunk SQL gate still records eight checkpoint writes, seven
transactions, fourteen changed rows, zero streaming SQL and zero idle SQL. WAL
was 37,424/37,720 bytes (diagnostic only). Runner identity checks and server
typecheck pass. The first CTE implementation failed typecheck on a nested subquery
projection; selecting its three needed fields explicitly fixed it before testing.

The next server review found that instruction update/restore receipts use call
IDs rather than generic idempotency keys. Recovery now reuses their existing
locked receipt and current target-authorization checks in a mode that cannot
reserve or repeat a write. Both lost-commit-acknowledgement regressions fail on
the prior code. All 13 real-Postgres/filesystem instruction tests and 29 existing
tool-authority tests pass, including unchanged bytes and one audit effect,
conflicting arguments, revoked permissions, Stop, unknown outcomes and a receipt
removed before locked replay. An initial companion-suite attempt exhausted macOS
Postgres semaphores before tests; both suites then used the same disposable-host
helper with independent databases. Server typecheck passes.

Transcript review also found legacy catch-up restarting sibling reads and an
interest acknowledgement clearing a stalled delivery deadline. Two legacy
regressions and the blocked-delivery deadline regression fail on the prior code.
The corrected hooks pass 31 focused tests; all 12 delivery tests, UI typecheck
and token gates pass. Terminal refreshes coalesce per run, and resubscription
cannot extend the original five-second backlog deadline. Existing protocol,
checkpoint and canonical-log ownership is unchanged. Updated CI, review and
browser evidence remain attributed to their candidate revisions on the PRs.

The separate Paperclip review found premature local expiry after a delayed
successful renewal and unlimited retries in opportunistic startup retention.
The renewal owner now samples a monotonic deadline immediately before UPDATE,
after acquiring the connection and row lock, while still deducting UPDATE/commit
response time. Its public void-returning API and SQL work are unchanged. Startup
retention stops after three failed passes, including query failures, and defers
remaining rows until the next startup. The delayed-success and both retention
regressions fail on the prior implementation. All 44 renewal/retention tests pass,
including quiet time after the retry cap and successful cleanup at the next
startup. Two real-Postgres renewal cases also pass in 107.45 seconds: one saturates
the liveness pool through two delayed successful renewals with natural 60-second
lease timing; the other retains application-pool isolation, SQL timeout and
expiry-during-lock checks. Server typecheck passes. Final review and CI status
remain attached to the exact candidate revisions on the PRs.

The final runner review found that a rejected persistence callback permanently
poisoned later flushes, and an adoption authorization hook could be silently
ignored without launch preparation. The runner now rejects that invalid option
combination before registration. Persistence keeps the last successful revision,
resets the next write after an uncertain outcome, and calculates queued deltas
against successful state. Three persistence regressions cover failure before
commit, a lost commit response, reconnection with the same lease and command,
and a queued successor. Those tests and the adoption-option regression fail on
the preceding implementation. The corrected controller/transport run passed
432 of 433 tests; the unchanged child-diagnostics test exceeded its five-second
timeout and passed a bounded isolated retry without changes. The failed attempt
is retained. All 39 focused profile tests, both Runner TypeScript checks,
protocol manifest/schema and module-boundary checks pass. The refreshed source
profile is `sha256:fac29e13622eadf9ab6f6dd1c47b2384ffa6307a2edb942dd78d3aae8e8d501f`.
This identity refresh is not new live-provider qualification.

CI 40141476713 found a race in the new persistent-retention regression: an empty
next-deadline value could mean a retry was still running. The test now waits for
the owner's final deferral warning and exactly three failed attempts before
checking three hours of simulated quiet time. All 39 retention tests pass with
disposable Postgres. The first local run timed out in database setup; a warm retry
passed with the same setup timeout. Product retry limits and quiet-time assertions
are unchanged. The runner fixes belong to PR 1 and this test fix belongs to PR 2.
Final CI/review results remain attached to each exact PR candidate.

CI 40144348549 then caught two test issues. The regenerated Copilot identity
still had an old pinned digest in the installation test; the corrected pin
passes all 95 installation/profile/permission tests. The in-process recovery
fixture observed all 64 events at the controller before the last eight
acknowledgements reached the runner. It now waits for the independent runner
receipt to report 64 acknowledged events and zero retained events. All three
fixture cases pass in 16.18 seconds, including filesystem-only compatibility
and deadline expiry. This strengthens the settlement witness without changing
production behavior, the workload count or the reconnect deadline. Both failed
CI shards remain retained; fresh CI is required for the corrected candidate.

| Layer | Latest evidence | Limit / next gate |
| --- | --- | --- |
| Runner | Initial split: 191 controller/profile, 96 Rust, 11 parity tests and three one-process fixture cases passed. After refresh onto master, protocol manifest/schema/replay and dependency-boundary checks pass. `2d72e827c991feb0f88d178aaf1ad1e0628f3e83` has Greptile 5/5 and passing unit, Rust, typecheck and build lanes. | The scoped rerun passed after an earlier browser fixture cancellation hit a lock timeout; CI is green for this revision. Synthetic execution does not qualify Codex/Claude. |
| Server | Refreshed recovery, renewal and plugin-adoption suites: 43 passed, five optional profiles skipped. The subsequent liveness-pool fix passed all 822 native executor/renewal tests with real Postgres. Saturated application-pool, cancelled row-lock wait, expiry-during-lock and natural 60-second claim-lifetime regressions passed. | `57278aa4aa11e3106d645615632571a33764eff5` has passing CI and Greptile 5/5 with no unresolved findings. An earlier unchanged cleanup-page failure is retained. Hosted admission/continuity remains outstanding. |
| Qualification | 80 focused tests, the separately executed real-Postgres observer and both embedded-database ownership tests in Linux pass. `29606367add9d6bc0fbc5ae86f8b41ac9392cb61` has passing CI and Greptile 5/5. Short and full 300-second immutable A→B→A startup smokes passed, with zero agent turns. | Active A/B/A, real migration change, natural stale-owner partition, representative concurrent admission and hosted proof remain outstanding. Local Linux ownership proof does not qualify a hosted agent. |
| Transcript delivery | Native notification and per-run catch-up isolation corrections pass 75 focused tests, UI typecheck, token gates and the native two-view/reconnect/reload journey. Earlier native and legacy browser journeys and 37 delivery regressions pass. | An earlier CI attempt failed the unchanged cleanup-pagination timing test; the unchanged suite passes all 14 tests in local Linux and passes the next CI run. Final revision checks and review remain the PR gate. Deterministic browser dependencies are not live-harness evidence. |

The supervisor observes HTTP readiness, natural ownership acquisition,
authenticated attachment, resumed canonical ingestion, and backlog settlement
separately. The read-only observer uses one repeatable-read database snapshot and
the Runner-owned checkpoint evidence projection. A new durable authentication
count and new canonical source sequence are both required; replaying saved events
cannot pass. The observer never renews or edits a lease or invokes recovery.
Its SQL is qualification overhead, excluded from product SQL cost measurements.
Postgres belongs to the supervisor rather than the killed serving process;
external Postgres is left alone, while an owned embedded database starts empty.
Each serving artifact applies its own migrations.

The credential-free startup smoke used these **development builds**, both 0.3.1:

| Artifact | Serving revision | Complete installation SHA-256 |
| --- | --- | --- |
| A | `f695ca7faac27d055441bb60bf377831bda85622` | `af894bdc71e390f11cfdd9128c828007e94095c0ba7bdab34c0ba1a7ecd01284` |
| B | `5ff132042f1071fdbc45624f6ab1e4d1bfac6598` | `bc3dd69e2c704a6c7c98804a1653d3b8a4e8fd8b88676c043dad891c0e506d15` |

The short smoke held the server down for 1,000 ms per replacement. Readiness
arrived after 25,305.985 and 33,658.933 ms. The full smoke held it down for 300,000 ms
per replacement; readiness arrived after 327,622.436 and 327,668.142 ms, within
420 seconds. Both preserved the database, read existing data, accepted a fresh
company mutation after each replacement, and cleaned up successfully. Receipts
explicitly record `providerTurns: 0` and `activeAgentContinuityQualified: false`.
A/B have identical migration journals: this establishes compatible startup and
rollback, not a nontrivial forward migration. These builds predate the final
server claim-renewal fix, so they cannot qualify that candidate's active recovery.

Private receipt locations: `paperclip-runner-e2e-k6aRaI/replacement-evidence.json`
(short) and `paperclip-runner-e2e-EXG9cW/replacement-evidence.json` (300 seconds)
under the host temporary directory. Harness revisions were respectively
`faaf31890e5ae96227bcfc0270bd5d94a92a2641` and
`446d89245bad472abe6b5a793365004858df1e63`.

Real Postgres cost comparison: 8 and 512 text chunks each produced 8 checkpoint
writes, 7 transactions and 14 changed rows for the same control operations.
Both measured zero streaming checkpoint SQL/transactions/rows and zero idle SQL.
WAL was 37,408 and 37,528 bytes; this diagnostic is not a production capacity
estimate. Receipt: `/tmp/paperclip-hot-upgrade-pr2-sql-cost-20261024-2.json`.
Independent mutation tests covered a lost HTTP response after the business row
committed and a lost runner response after its API receipt was saved. Both
checked the business table independently and counted one dispatch.

Failed attempts remain distinct from evidence: plain `pnpm deploy` omitted
public manifests, bundled dependencies and runtime skills; the existing release
preparers fixed the artifact before it was frozen. An initial 300-second smoke
could not connect to stopped Docker and launched no agents. Native macOS Postgres
setup repeatedly exhausted host semaphores; integration checks moved to a
throwaway Docker database without changing product recovery. The earlier hosted
attempt exhausted BuildKit disk during image export, before launching a sandbox.
No expensive retry should proceed without resolving its infrastructure cause.
The current trusted hosted workflow has no per-run disk-capacity override or
upgrade-manifest input. No local Daytona/model credentials are configured.
Workflow changes on this branch cannot replace its required default-branch
workflow authorization. Hosted continuity remains unqualified until an authorized
path can build the image and consume the immutable A/B artifacts.

After refreshing the stack onto master, workspace typecheck and all 43 targeted
recovery, renewal and plugin-adoption tests passed (five optional profiles skipped).
Master already fixed the stale stylesheet-preload browser fixture. Runner, server
and qualification CI pass at the revisions above. The older broad Linux source
verification of `c7bdc72416c98b6781b11452eba878036a9f862a`,
[run 40127795703](https://github.com/paperclipai/paperclip/actions/runs/40127795703),
was cancelled after the missing embedded-database tests passed directly in Linux.
It is not a full-source pass. Current revision CI remains required.

### Transcript delivery measurements

The fixed workload emits 1,024 events of 2,048 characters in bursts of 16. These
are measurements of the in-process delivery boundary with simulated sockets.
They exclude canonical persistence, real network behavior, browser rendering,
and production capacity. Heap deltas depend on garbage collection.

| Views | Full transcript deliveries | Encoded bytes | Authorization calls | Elapsed ms | CPU ms | Heap delta (bytes) | p95 delivery ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Zero interested views | 0 | 230 | 1 | 2.310 | 3.014 | +1,364,856 | — |
| One view | 1,024 | 2,259,853 | 1,024 | 8.205 | 18.437 | +2,254,512 | 0.082334 |
| Three browser connections | 3,072 | 6,779,559 | 3,072 | 12.543 | 12.780 | −2,520,744 | 0.124167 |
| Congested connection | 464 | 1,023,959 | 465 | 2.954 | 2.903 | −2,499,248 | 0.038083 |

The zero-interest case coalesced one lightweight activity notification. The
normal one-view peak retained queue was 16 items / 35,344 bytes. The congested
case requested resynchronization while staying inside the delivery bound.
Private receipt: `/tmp/paperclip-live-delivery-cost-20261024.json`.

The native Playwright journey passed in 39.5 seconds (50.8 including setup) on
`267d221f4659ff17d95c99ad5fac5e77f37c8538` plus its test-only transport fault
injection and document-scoped connection accounting. It used a real runner,
disposable Docker Postgres, and the deterministic Codex app-server. The run
`efd7ca4d-7b63-4b02-8312-44bbcad32f91` completed once; both views retained the
final output through reload and the business comment table contained one final
comment. There were zero transcript history requests during a settled 2.5-second
streaming interval, exceeding the fallback's 2-second poll interval. Earlier
attempts exposed obsolete test selectors, provider-discovery precedence, and
Chromium's failure to close existing sockets during offline emulation; none was
recorded as a passing reconnect check.

## Evidence layers

| Layer | Execution and owner | What it proves | Cadence |
| --- | --- | --- | --- |
| Protocol | Runner tests; controlled ACK/persistence/effect faults | Replay, authenticated sparse cursors, durable barriers, bounded queues | Every relevant PR |
| Recovery integration | Real Postgres and Rust runner; deterministic provider | Ownership races, encryption, empty cache, side-effect settlement, same turn | Every relevant PR |
| Server replacement | Product E2E wrapper kills/replaces the actual main server; production HTTP workflow | Startup adoption, natural lease timing, same sandbox/run, finalization and admission | Relevant PR; exact hosted cell before release |
| Version compatibility | Immutable server A then B, admitted runner digest, real migrations; compatible rollback | Upgrade contract across different artifacts | Before release |
| Efficiency | Identical scripted workload with and without checkpoints, plus restart burst | Incremental DB work, latency, throughput, backlog and resource bounds | Relevant PR; capacity campaign before release |

Keep these claims separate. A scripted provider is a reproducible correctness
instrument, not a qualification of the real provider or Daytona. A same-version
restart is not an A-to-B upgrade. A wrapper test is not an agent continuity test.

## Fault and workload matrix

Start with one server replacement and one cost comparison; extend the same harness
rather than create parallel recovery implementations or production test switches.

| Axis | Required cases |
| --- | --- |
| Fault | Graceful stop; SIGKILL; transport partition with old owner alive |
| Unavailability | Short; around the natural lease expiry; full 300 seconds |
| Work at boundary | Streaming; server read waiting; mutation committed with response lost; completion during outage; queued launch |
| Competition | Two successors; stale owner resumes; Stop/authority change; second restart during recovery |
| Versions | A to B plus migrations; B to compatible A; unsupported runner fails explicitly |
| Load | Expected peak; twice peak; synchronized reconnects; idle with retained history |

The harness records that the original run was active at injection. An unexercised
boundary fails, even if a later task succeeds. Use deterministic gates for the
scripted workload; wall-clock sleeps alone cannot establish where an effect was.
Never edit lease timestamps or recovery state in a server-replacement journey.

## Hard correctness gates

- Preserve sandbox lease, runner PID **and process start identity**, provider
  session and active turn. The provider call ledger must show one turn start.
- Check an external fixture's effect ledger independently: a write occurs once,
  including when its response is lost. Tool-ID deduplication alone is insufficient.
- An uncertain write is visibly held; an ordinary read can retry under current
  authority. A stale owner cannot write a command or acknowledge an event.
- The original run commits once, including accounting and workspace finalization;
  no stranded operation or recovery action remains.
- Queued/admitted work resumes and a newly submitted task launches after readiness.
- Record fault receipt, actual elapsed outage, server readiness, natural ownership
  eligibility, reattachment and backlog-drained times separately. Recovery must
  fit the original 420-second grace. A healthy HTTP endpoint alone cannot pass.
- Missing provenance, missing boundary evidence, unexpected skips, cleanup failure
  and automatic retry do not qualify an attempt.

## Efficiency gates and measurements

The lean design keeps control state, not a second transcript. The existing run
log, business writes and 20-second lease renewals remain baseline work.

1. **Zero checkpoint writes for ordinary text chunks.** Compare a small stream
   and a much larger stream with the same control operations. Assert callback,
   SQL and changed-row counts, not just final table size. Updates to one row are
   still load. Calibration must make a deliberate extra write fail the gate.
2. **Zero added checkpoint SQL while idle after startup.** Exercise both empty
   and retained history. Retention may do its bounded startup pass; the existing
   filesystem cleanup timer must not query checkpoint rows.
3. **Measure each control boundary.** Capture checkpoint transactions, inserted/
   updated/deleted rows, payload bytes, WAL bytes and lock waits in an isolated
   Postgres database. Report measurement-query overhead separately. Never count
   a mocked persistence callback as a WAL measurement.
4. **Compare normal-operation cost first**, then restart cost: same fixed seed,
   concurrent agents, output rate, tool mix and duration; warmup plus repeated
   paired samples. Report throughput, CPU, peak RSS and p50/p95/p99 control latency.
   Provisional acceptance is at most 5% throughput regression at expected peak;
   establish the baseline and expected peak before treating that as a release gate.
5. **Bound backlog and recovery pressure.** A five-minute outage must fit the
   configured runner outbox budget and drain without starving new commands or
   fresh admissions. At twice peak, pressure must remain bounded and explicit.

Do not infer production dollars or capacity from a laptop timing result. Persist
raw sample counts and distributions; noisy timing is diagnostic, not a flaky
single-sample CI assertion. Structural zero-write checks are deterministic gates.

## Attempt record and implementation order

Every attempt retains the two server revisions/artifact digests, runner digest,
workload configuration, fault receipt, monotonic elapsed times, independent effect
ledger, recovery identity, database measurements and cleanup outcome. Store private
logs under the existing harness private-artifact policy; publish only sanitized
receipts. Keep failed attempts alongside subsequent successes; no automatic retries.

1. Add a bounded, cancellable actual-server outage to the existing restart wrapper,
   with a receipt the remote continuity grader requires. Test missing/incorrect
   receipts and real process replacement. Leave the existing finalization fault
   and local process ownership contracts intact.
2. Add repeatable Postgres checkpoint-write measurements to the existing native
   integration suite, including the zero-stream-write gate and a positive control.
3. Run the exact hosted remote continuity cell at short and full-contract outages.
   Resolve the image-builder disk failure before another paid attempt. Do not
   promote a suite that failed before sandbox launch.
4. Extend to pinned A/B artifacts, deterministic mixed workload/effect faults,
   two-owner contention, outbox pressure and the paired peak-load benchmark.

## Evidence status at the start of this slice

- Existing tests cover authenticated sparse replay, transactional checkpoint
  fencing, uncertain tool recovery, delta updates and idle/retention behavior.
- The 300-second integration proof uses real Postgres/Rust and a scripted provider,
  deletes controller files, and retains the active turn. It **manually expires a
  lease and does not replace the main server**; it is not the server-upgrade gate.
- The hosted `everyday-workflows.runner-codex.daytona.recover-controller` cell
  already replaces the server and grades original-run identity and finalization,
  but needs an explicit outage receipt and configurable crash/outage duration.
- Hosted attempts 39613279281 and 39616972414 failed in image preparation with
  ENOSPC before sandbox launch. No Daytona continuity pass is claimed.
- Different server versions, independent external-effect counting, mixed-load
  capacity/WAL measurements and production cost estimates are not yet qualified.

Implementation results and exact commands belong below, with their limitations.

## Implemented qualification slice

- `tests/runner-e2e/controller-outage.ts` owns bounded fault injection and
  monotonic phase receipts. The actual server wrapper uses it only for the
  explicit remote cache-replacement cell. Signal, minimum hold (0..300000 ms),
  old/new process IDs and incomplete attempts are inspectable. Cancellation
  prevents a successor launch. Missing/short/foreign fault receipts fail grading.
- The existing hosted cell defaults to SIGKILL and a 1000 ms hold, requires this
  receipt, and forbids automatic retries. Its definition version and harness
  fingerprint changed. The full hold is selectable using
  `PAPERCLIP_RUNNER_E2E_CONTROLLER_OUTAGE_MS=300000`; SIGTERM is also selectable.
- `controller-replacement-smoke.ts` is a credential-free actual-main-server
  probe with Postgres owned by the test driver. It checks unchanged Postgres
  start time, existing HTTP data, new HTTP mutations and complete process cleanup.
  It deliberately reports `activeAgentContinuityQualified: false`.
- The native restart integration suite now measures actual checkpoint SQL through
  postgres.js, checkpoint transactions/changed rows/bytes, diagnostic cluster WAL,
  and elapsed time for identical control operations with 8 versus 512 text chunks.
  The fixture holds text until control setup settles, then each released stream
  must add zero SQL statements, transactions or changed rows. Total control setup
  counts remain diagnostic because batching can vary. A subsequent real control
  write calibrates the observer. A settled-stream interval must issue zero SQL. Broader
  idle cleanup remains covered by the existing retention tests. These timings and
  WAL values are not a paired capacity benchmark or production cost estimate.

Commands (run from the repository root):

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit -- --maxWorkers=2
node cli/node_modules/tsx/dist/cli.mjs tests/runner-e2e/controller-replacement-smoke.ts
PAPERCLIP_TEST_CHECKPOINT_COST_REPORT=/tmp/checkpoint-cost-attempt-1.json pnpm exec vitest run server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts -t 'keeps checkpoint SQL independent' --maxWorkers=1
```

Choose a new cost-report filename for each attempt; existing evidence is never
overwritten. Build the existing Rust fake provider after changing its fixture
flags (`cargo build --manifest-path packages/paperclip-runner/runner/Cargo.toml
--locked -p paperclip-runner-core --bin fake-codex-app-server`). No LLM credentials
are needed for these local probes.

Initial evidence on 2026-10-22:

- 50 focused fault/oracle tests passed. Server typecheck passed.
- Actual-main-server SIGKILL smoke passed: a 1000 ms confirmed-down hold, readiness
  62.82 seconds after injection, unchanged Postgres start time, data continuity,
  new mutation and confirmed cleanup. This used source revision 436b2ce12 plus
  the working changes, not two released artifacts.
- The real Postgres/Rust cost gate passed with 64 times as many text chunks.
  Earlier 4096-chunk attempts exceeded the original ten-second observation bound;
  they did not establish a DB regression or pass. The fast gate now uses 8/512
  and a bounded 60-second observation window. Large backlog capacity remains a
  separate gate, not silently qualified by this smaller sample.
- The first smoke launcher attempt failed on workspace package imports before
  server launch. Direct source imports fixed the standalone entrypoint.
- The first complete support-suite run had 3571 passing tests, two explicit skips,
  and five failures in existing catalog version/count and Daytona image-input
  assertions. These must be reconciled before calling this slice PR-ready.

Follow-up validation on the merged branch (`d0a0b830e7`, plus the request-receipt
correlation check):

- The full **300000 ms** actual-main-server SIGKILL smoke passed with Postgres
  continuously alive, old controller cache unavailable, existing data readable,
  a new HTTP mutation accepted and cleanup confirmed. This remains a zero-provider
  startup/DB proof; it does not upgrade the hosted agent result to a pass.
- The complete native restart integration file passed **34 tests**, with five
  Docker-dependent cases skipped. The focused protocol and Copilot identity
  suites passed **191 tests**. Fault/oracle tests passed **50 tests**.
- Workspace `pnpm -r typecheck` and `pnpm build` passed. Earlier typecheck attempts
  found a sandbox IPC restriction and Rust fixture formatting; the permitted,
  formatted rerun passed. The merged source preserves master's Copilot v58 and
  declares the combined recovery transport as v59, including Docker image inputs.
- The reconciled Product E2E support run passed 3573 tests and skipped two, but one
  file's worker failed to start. Its separate rerun passed all three tests, and
  the follow-on Node suite passed 128 tests. The full invocation remains recorded
  as incomplete; it is not relabeled a clean full-suite run.

Measured control-checkpoint cost for one scripted turn:

| Text chunks | Transactions | SQL writes | Changed rows | Plaintext checkpoint bytes | Cluster WAL bytes | Settled-stream idle SQL |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 7 | 8 | 14 | 13618 | 37224 | 0 |
| 512 | 7 | 8 | 14 | 13636 | 37632 | 0 |

Control operations are included; the output stream adds no checkpoint writes.
WAL is a diagnostic cluster-level observation, including possible background
work, not an exact attribution or threshold. This is not the promised paired
peak-capacity campaign. A new control command after each sample produced a real
SQL write, establishing that the observer was active.

Still outstanding: hosted active-agent proof (including the full 300-second
outage), version A/B artifacts and migration/rollback, deterministic mixed
work/effect ledger, natural-lease race matrix, and paired peak/overload measurements.
The hosted blocker was confirmed in the retained build log: BuildKit exhausted
disk while exporting the image, before the workflow could launch any sandbox.

Review found a read-recovery gap: the copied retry list omitted identity, people,
skill and workspace reads. Their saved inputs could remain pending after a lost
response. Recovery now consumes the Runner's existing canonical side-effect
classification, plus read/mutation metadata on server bridge definitions. The
server shim exposes that existing Runner metadata; it adds no alternate authority.
Read replay calls the normal executor and therefore rechecks advertisement,
company/run scope, current grants and file confinement. External tool annotations
never authorize uncertain-effect replay. Four focused Postgres regressions passed,
including actual file reads, company isolation, missing-file settlement, revoked
workspace grants, stale leases and cancellation. Initial attempts used the wrong
catalog projection and lacked the shim export; existing read tests and typecheck
caught both before the corrected run passed.

Master advanced during final verification. The merge preserves its released
0372 workspace-restore migration and regenerates the combined checkpoint table
and header index as 0373_powerful_mentor from the complete master snapshot. The
checkpoint SQL retains its idempotent guards; the latest five snapshots remain.
This supersedes the earlier 0372/0373 checkpoint numbering in the historical plan.

The merged CI run caught a timing assumption in the initial cost comparison:
control messages coalesced into seven SQL writes in one sample and eight in the
other. That is a failed attempt, not a zero-write proof. The fixture now holds
text behind an explicit release file until turn-start events and command results
are durably settled. Each text-only interval must independently cause zero SQL,
transactions and changed rows; total control counts are measurements, not equality
assertions. The existing positive control still verifies the SQL observer.
The first gated local attempt passed: both 8 and 512 chunks added zero SQL,
transactions and changed rows, with zero idle SQL and a successful positive
control. The full merged restart suite passed 36 tests (five Docker-only skips),
and all 29 tool-authority tests passed on a serial rerun after an initial database
setup timeout. Workspace typecheck also passed after the migration merge.

### Final review corrections (2026-10-24)

Completed plugin runs may clear their dispatch flag during normal cleanup. The
qualification boundary accepts that state only for the original succeeded run
with its saved task identity and persisted provider-stop confirmation. Active
runs still require dispatch. Missing stop proof and replacement identities fail.

The server's native renewals now share the existing liveness pool with legacy
renewals. Each active remote lease attempts renewal every 20 seconds, with one
row lock and fenced update inside a transaction and a local 10-second statement
timeout. Expiry is checked after acquiring the row lock. A cancelled attempt
can retry within the original deadline, but a lost or late response cannot
restore expired authority. This adds active-run SQL around renewal; it does not
change the zero-per-text-checkpoint-write or idle-SQL gates. The text-chunk cost
measurement above excludes periodic renewal overhead.

### Restacked candidate and hands-on browser evidence (2026-10-24)

Candidate `54fc7c6494470a9d553ef7bce7d57b3f5a57d7ba` passed full workspace
typecheck and build, 80 focused qualification tests, and the separately executed
real-Postgres recovery observer. This includes server renewal fix
`57278aa4aa11e3106d645615632571a33764eff5` and qualification fixes through
`29606367add9d6bc0fbc5ae86f8b41ac9392cb61`. Final-head CI remains the PR gate;
these local results do not replace it.

A hands-on in-app-browser journey used that candidate, the real runner, the
deterministic Codex app-server and a disposable Docker database. Starting at the
dashboard, the operator created TRA-1 through New Task, opened it from Recent
Tasks, observed live commentary, navigated to Tasks while it was running, returned
to its completed answer and reloaded it. The result and source link remained
visible. API inspection confirmed one successful run
`09cff1ec-5340-48e4-97f0-12334052e4aa` and one final business comment.

Functional outcome: passed. The observed desktop experience was usable, with no
error banner, duplicate result or lost output. A normal loading skeleton appeared
on navigation; an unrelated announcement overlay was dismissed. The screenshots
do not establish smoothness between every sampled frame. No mobile or live-model
claim is made. Final screenshot: `/tmp/paperclip-transcript-manual-completed-20261024.jpg`.

### Native notification catch-up correction (2026-10-24)

Review found that a consecutive native commit notification could be mistaken for
a complete transcript row. The notification contains no PRP body. Native views
now request canonical history through its sequence and never merge the empty
notification over text. The 73 focused hook, projection and sequence tests pass,
including consecutive notifications, delayed duplicates, a notification racing
an older read, failed-read recovery and zero recurring reads for complete live
PRP rows. These tests use the real native transcript projection. Token gates pass.
Payload-free notifications cause event-driven history reads; this is distinct
from the zero recurring reads during settled negotiated streaming.
UI typecheck and the native two-view browser journey also pass after this fix
(39.1-second journey, 53.4 seconds total). That journey rebuilds the shipped UI,
uses the real runner with the deterministic Codex app-server, and verifies socket
reconnect, company changes, terminal catch-up, reload and one final business
comment. It does not qualify a live provider or hosted upgrade.

### Linux ownership proof and retained CI failure (2026-10-24)

The previously blocked embedded-Postgres ownership test passes in a disposable
Linux ARM64 container: both tests in `controller-database.test.ts` pass. Killing
the serving client preserves the same database start time and subsequent writes;
the second test rejects paths outside the fixture and leaves external database
configuration untouched. The source checkout is read-only. A temporary dependency
overlay supplies the matching Linux native packages and an unchanged copy of the
repository's patched embedded-Postgres package. No test or production behavior
was changed for this proof. Initial container attempts failed on missing platform
bindings, Vite cache writes, resolver recursion and misplaced native libraries;
their logs are retained with the passing attempt. This is local Linux evidence,
not hosted Daytona evidence.

CI run 40130375278 on code revision `09d1590432` passed every check except the
unchanged historical-cleanup pagination test: it observed 32 inspections where
33 were expected. Its fixed clock advances can precede completion of asynchronous
database work and registration of the following deadline. The same unchanged
suite passes all 14 tests in the isolated Linux container. The failed CI attempt
is retained and a bounded shard retry was requested; neither test assertions nor
production scheduling were weakened. Final CI status remains visible on the PR.

### Independent native catch-up (2026-10-24)

Review subsequently found that a run's live notifications restarted the shared
history effect, aborting slow historical reads for sibling runs. Live catch-up
now addresses only the affected run. In-flight reads and retry timers are bounded
per run; terminal notifications coalesce into one follow-up read without aborting
the current request. Both regression tests fail against the preceding code and
pass after the correction. One holds two historical pages while a sibling receives
repeated commit and terminal notifications; the other verifies terminal catch-up
does not abort or overlap a request. All 75 focused tests, UI typecheck and token
gates pass. The native browser journey passes again (39.6 seconds, 51.9 seconds
including setup), including two views, company changes, socket recovery, terminal
catch-up, reload and exactly one business comment.

### Agent Detail event preservation (2026-10-24)

A delayed native commit signal could overwrite a full saved event in Agent
Detail. Both page variants now keep signals out of the merge and require canonical
history only when their persisted cursor does not cover the signal. Both new
regressions fail on the prior merge; all eight page regressions, UI typecheck and
token gates pass. Full live rows still merge without recurring history reads.
The extended browser journey passes (42.3 seconds; 56.7 seconds including setup),
covering the existing two-view/reconnect/completion flow plus the agent's run-event
view and reload. It uses the real runner, deterministic Codex app-server and owned
Postgres. Run `7fcdcc41-e035-4bca-88ea-0bc079083b03` completed once. This remains
browser evidence, not live-harness or hosted-upgrade qualification.

### Agent Detail reader isolation (2026-10-24)

The next transcript review found that one native commit signal restarted both
Agent Detail history readers. Event history and shell logs now refresh separately
in both page variants. Each reader finishes its current page and coalesces
terminal notifications into one follow-up. Four regressions hold either reader
while the other receives repeated updates; all fail on the preceding code and
pass with the correction. The first fixture omitted the required agent ID; the
corrected fixture was replayed against both implementations before acceptance.
All 43 focused page/transcript tests, UI typecheck and token gates pass. The actual
native two-view/reconnect/reload and Agent Detail journey passes in 46.1 seconds,
with real Runner, deterministic Codex app-server and disposable Postgres. Run
`b7259b33-bdae-402c-aa25-cc2d827ff454` completed once with one final business comment.
This result remains distinct from hosted upgrade qualification.


### Fresh admission renewal and fixture-key isolation (2026-10-24)

Review found that fresh remote admission acquired its lease before tracing,
accounting-history reads and retained-session preparation, but started renewal
only afterward. The startup owner now starts the existing renewal immediately
after the claim transaction commits and drains it on preparation failure. No new
renewal cadence or idle work is introduced. The controlled preparation-failure
regression fails on the previous implementation. A real-Postgres experiment holds
the claim trace sink until two seconds beyond the original 60-second lease and
confirms the same owner, same attempt and a naturally extended deadline; it
passes in 74.17 seconds. All 824 executor/renewal tests and server typecheck pass.

The first Postgres fixture used a non-UUID lease identifier; the lease assertions
passed but fixture cleanup failed. The corrected fixture passes. An earlier full
suite could not start embedded Postgres because of host semaphore exhaustion.
The external disposable-Postgres run exposed a cleanup-order regression: awaiting
renewal shutdown before removing the settled startup let detachment reacquire the
old session. Removing the startup synchronously before yielding fixes it; the
preceding 823/824 result is retained alongside the final 824/824 result. The final
run took 625.56 seconds while performing fresh migrated databases for the warm
ownership cases; database activity confirmed progress during that run.

The qualification supervisor now removes ambient inline/file master-key overrides
at its existing process-launch boundary, matching the serving child's fixture
configuration. A separate observer child decrypts the actual stored checkpoint
under each hostile ambient override using the same fixture key, without changing
any observed rows. This regression fails with the previous launcher and passes
with the fix (6.39 seconds); 134 observer/support/installed-artifact tests pass.
No recovery or cryptography implementation was added to the observer.

CI attempts 40146472407 and 40146502737 are retained: the former hit the unchanged
agent-device-login route timeout and a following session conflict; the latter
hit EADDRINUSE on port 46274 in the unchanged workspace-runtime HTTPS test. These
are distinct from the fixed lease/observer findings; final candidate CI must run
again rather than deleting the failed attempts or weakening those assertions.

Hosted acceptance remains open. The trusted workflow was rechecked against master:
it has no per-run image-build capacity override or immutable A/B artifact-manifest
input and still selects the same public-pr fleet used by the earlier BuildKit
ENOSPC failure. No repeat paid image build was launched against unchanged capacity.
The outstanding hosted upgrade/rollback evidence still requires that infrastructure
and artifact-input path; local/CI success does not close this acceptance gap.


### Bounded event browsing and stable shared interests (2026-10-24)

The subsequent transcript review found three presentation defects: Agent Detail
automatically drained every saved event, live retention dropped opening details,
and unrelated interest replacements aborted active history readers. Agent Detail
now automatically reads one 1,000-row page, then offers explicit pagination while
full live delivery continues. The live window retains the first 200 events plus
the latest 2,000, preserving opening details through completion. Explicit page
failures keep existing rows and expose an error with retry. Task transcript
recovery still drains its canonical history normally.

The shared interest owner now tracks acknowledged run IDs independently of the
connection's recovery generation. Existing interests remain healthy through
unrelated replacements; new interests require their own ACK. Connection changes
and explicit overflow resynchronization still trigger catch-up. An additional
regression covers overflow from the previous revision while a new interest ACK
is pending, so that optimization cannot hide a real gap.

All seven review regressions fail on the preceding source for their expected
assertions: automatic page count, retained opening details, interrupted native
and legacy reads, and acknowledgement scope. The additional overflow-race test
fails before its correction. All 48 focused transcript tests, final UI typecheck
and token gates pass. Initial large-DOM runs exceeded the five-second test budget;
the two expanded rendering cases now have explicit 30-second budgets, with their
original behavioral assertions unchanged. The final suite took 16.64 seconds.
The earlier partial runs and the corrected before/after replay are retained.

The final native browser journey passes on source commit `a1f75df8a5` in 59.2
seconds (1.2 minutes including setup), rebuilding the shipped UI and using the
real runner, deterministic Codex app-server and owned disposable Postgres. Run
`766f50cd-e0a1-48ff-afed-b779c6abd29a` completes once with one business comment;
two views, company switching, socket recovery, terminal catch-up, reload and Agent
Detail events pass. A preceding browser run also passed in 58.5 seconds before
the extra overflow-race correction. These are browser/presentation results, not
live-provider or hosted-upgrade evidence.


### Supervisor isolation and initial history errors (2026-10-25)

The final launcher check still required embedded database mode, although upgrade
qualification correctly moves its fixture Postgres into the supervisor's process
tree and connects the serving child through normal Postgres mode. This could
reclassify a successful recovery as a permanent infrastructure failure. The
supervisor now records its fixture ownership only after starting the database;
the existing isolation check accepts that exact local connection after verifying
the fixture/config/physical data-directory identity, configured port and database
marker. Missing receipts, foreign connections/owners, mismatched ports and a
symlink escaping the fixture remain rejected. The valid owned-connection regression
fails before the fix; the five rejection cases already pass.

All 117 local isolation/support tests and runner-E2E typecheck pass. A disposable
Linux container runs the real Postgres ownership experiment plus isolation cases:
all eight pass in 2.24 seconds. The actual database remains unchanged when its
serving client is killed, and the launcher check also passes after the supervisor
stops the database. The first Linux attempt lacked a writable Vite cache at the
actual test-local path; mounting only that temporary cache fixes the environment
while keeping repository source read-only. This proves fixture ownership, not
hosted agent continuity.

Review also found that Agent Detail's empty-state return hid a first history-read
error before the error panel could render. Both variants now display that failure
and an explicit Retry events action even with no existing rows. Both new page
regressions fail before the correction. All 50 focused transcript tests, UI
typecheck and token gates pass. The extended native browser journey passes in
43.9 seconds (58.3 seconds including setup): it forces a 503 for initial event
history while presenting an empty shell log, verifies the error rather than an
empty-state claim, then restores the real route and clicks Retry events to recover
canonical output. Run `1c345f26-0acb-47af-aa76-8f6e2e05ca4d` still completes once
with one business comment. The initial database container launch found its chosen
port occupied; that listener was left alone and a dynamically assigned port was
used for the owned fixture. The prior healthy-streaming and reconnect assertions
remain in this same journey. No hosted qualification claim is added.

### First hosted stress campaign and preserved identity failure (2026-10-26)

A new, synthetic test tenant ran the exact published core-only candidate
`00ebac324cc9016a832e7a51e01652af0cbcc758` on Linux, real Postgres and Daytona.
The harness was real native Codex with OpenAI `gpt-5.4-mini`. The authenticated
qualification gateway allowed local tools and namespaces and removed hosted web
search. This is evidence for that profile, not Claude or a full Cloud composition.

All 13 admitted tasks succeeded: an initial baseline, a short restart, ten
concurrent long-outage tasks and fresh post-restart work. For the ten-way case,
the main Node process was frozen for 300 seconds and then killed. Postgres and
Daytona stayed running. No lease timestamp was edited. HTTP readiness was first
observed at 322.354 seconds after the fault began. Natural ownership claims
occurred at about 315.5–315.9 seconds. All original runners authenticated again
and new canonical ingestion was confirmed by 399.505 seconds, inside the
original 420-second grace.

Each original workload completed 480 steps, including 298–300 during the
outage. Its PID, boot/start identity and nonce were unchanged. The largest step
gap was 1.135 seconds. Independent recomputation confirmed all ten final hash
chains and exclusive effect files. Each original turn produced one completion,
result acceptance and terminal receipt. All ten workspace exports committed,
and no scheduled or active recovery remained. Fresh native work started in
1.299 seconds while seven original runs were still active, then completed.

**Strict qualification failed.** The run, runner, native session, PID and sandbox
lease stayed unchanged, but the recorded `processStartedAt` changed to attachment
time in all ten runs. The identity assertion remains in place; the campaign is
not green. The Runner transport reported controller-construction time, and the
remote process handle did not expose the birth time already verified in its
marker. Fixes belong to the runner and server PRs respectively. The two focused
regressions fail before their fixes and pass after. All 293 transport tests,
14 remote supervision tests, repository typecheck and module/package boundary
checks pass on the corrected source. Hosted evidence must be repeated on its
published artifact before this failure can be closed.

The first short fault attempt checked SIGSTOP synchronously and resumed before
killing anything; it is unexercised. A bounded state-confirmation check repaired
the injector before the actual short and long faults. Setup also preserved
hosted-tool rejection, a credential-directory lock timeout and intermittent
Railway SSH timeouts. Normal finalization released ephemeral sandboxes; final
proof files were read from their successfully committed workspace exports with
exact company/run/workspace binding and path containment.

Three samples during the freeze show unchanged write counters in
`heartbeat_run_events`, `heartbeat_runs`, `native_run_finalizations` and
`native_runner_checkpoints` while useful workload steps continued. This is not a
healthy-streaming SQL benchmark or evidence of zero database reads. CPU/memory
deltas, throughput savings and production capacity were not measured.

Final provider receipts recorded 210 requests and **$0.735245850 estimated model
cost**, with no unknown, conflicting or inflight charges. The original $25 cap,
request ceiling and deadline stayed unchanged. Pricing used OpenAI's documented
`gpt-5.4-mini-2026-03-17` snapshot rates; it is not an invoice. The product's rate
card lacks this test model, so campaign policies explicitly allowed unpriced
usage while the independent gateway enforced the cap. Unknown product costs
were not replaced with invented prices. All test work settled before the gateway
closed and test agents were paused.

Different-artifact A/B and rollback, the 25-way profile and the complete browser
viewer matrix remain open. The current Cloud campaign path still requests task
drain before replacement. These app-only fault results do not qualify a normal
Cloud rollout without drain. Keep deployment-policy work with its Cloud owner;
do not weaken Core drain semantics or report active work as empty.

### Reviewed full-stack campaign and asynchronous identity failure (2026-10-26)

The maintained Cloud CLI deployed exact Core-only artifact
`f2945ebeafdffb26fd6234092aeec0c6ff6208ea` to the same dedicated synthetic
Linux/Postgres/Daytona tenant. Publication, rollout and serving health verified
the revision. The approved profile remained production Runner/native Codex with
OpenAI `gpt-5.4-mini`, local tools through the authenticated capped gateway, and
hosted web search removed.

Ten ordinary assigned tasks each completed 600 deterministic steps and streamed
4 KiB per step. The main Node process was frozen for 300 seconds and killed.
Postgres and Daytona stayed running; no lease deadline was edited. HTTP readiness
was observed by 311.735 seconds. Natural ownership was acquired at
315.999–316.434 seconds. All ten original runners authenticated again and new
canonical ingestion was observed by 378.466 seconds, inside the unchanged
420-second grace. A fresh ordinary task started in 0.964 seconds while all ten
originals were still active, and succeeded.

Each original workload made 295–300 useful steps during the outage. Its PID,
boot/start-tick identity and nonce stayed unchanged; the largest step gap across
all workloads was 1.792 seconds. Independent recomputation verified all ten hash
chains and exclusive effect files. Every original run retained its runner,
session, PID and sandbox lease, preserved its canonical event prefix, finalized
once and committed its workspace export. No queued recovery remained.

**Strict qualification remains failed: 0/10.** Every `processStartedAt` moved
forward by 3.040–7.354 seconds to an initial-launch timestamp before the outage.
The prior fix removed replacement-construction time but did not preserve the
asynchronous process owner's getter through `spawnRunner`'s restart wrapper.
Object spread captured undefined before the remote marker arrived. A regression
through this public wrapper fails before the getter-forwarding correction and
passes after; all 143 control-plane tests pass. The correction belongs to PR 1.
This campaign does not qualify that later source. Both failed hosted grades
remain unchanged and inspectable.

Two successful independent frozen-server observations, 69.332 seconds apart,
show identical insert/update/delete counters for `heartbeat_run_events`,
`heartbeat_runs`, `native_run_finalizations` and `native_runner_checkpoints`,
while each workload advanced by about 68 steps. Checkpoint material stayed at
9,688,877 bytes over 1,607 retained rows, including earlier campaign history.
This is neither a healthy-streaming SQL benchmark nor a zero-read claim.

The rerun settled 165 model requests at **$0.595740300 estimated** with no held,
unknown, conflicting or inflight charges. Combined campaign cost is
**$1.330986150 estimated**, below the approved $25 maximum. All eleven synthetic
agents are paused, the model gateway is closed, and the requested CLI access is
retained. Estimates use reported provider usage and documented model rates;
they are not invoices.

Preserved setup failures include an unselected local AWS profile (resolved with
the existing development profile), one normal AI connection probe rejection
followed by a passing diagnostic and scoped binding retry, and one Railway SSH
connection timeout. Later observer connections use a short connection timeout
without changing authentication or host verification. An early incomplete
pre-fault observation remains separate; the actual fault required all ten
complete active boundaries and fresh workload readiness. None of these retries
replaced a workload or edited lease timing.

Different-artifact active upgrade/rollback, normal Cloud drain-free rollout,
Claude, 25-way load and the full viewer/CPU/memory cost matrix remain open. The
current Cloud campaign still requests task drain. PR 3 remains draft.

### Qualification receipt review follow-up (2026-10-26)

The everyday harness digest now includes `controller-recovery-observer.ts` and
`upgrade-artifacts.ts`, whose checks decide upgrade acceptance. The credential-free
smoke captures its owned embedded Postgres PID from the cluster before replacement.
After the bounded database helper returns, it separately requires that process to
have exited before reporting `cleanupConfirmed`. Missing identity, permission
errors and an exit timeout fail confirmation. This probe sends no terminating
signal and does not stop an externally supplied shared cluster; external cleanup
still awaits deletion of only its own disposable database.

A real child-process regression reproduces the old false success when cleanup
returns with its owner still alive. That regression and the missing-identity case
fail before correction; all 69 affected qualification tests pass after it. The
qualification typecheck initially found stale runner declarations in the separate
worktree. Rebuilding the existing dependency fixed those declaration errors; the
retry passed without a source workaround. One credential-free real embedded-
Postgres/main-server replacement then passed, including continued database
identity, ordinary mutation admission and confirmed final process exit. It reports
zero provider turns and does not qualify a hosted agent or a different artifact.

This qualification-only follow-up is separate from the immutable production
candidate `73b65d8718fe763a23c53584ac6a82863965b786` being prepared for hosted tests.

### Strict hosted Codex restart qualification passed (2026-10-26)

Exact Core artifact `73b65d8718fe763a23c53584ac6a82863965b786` passed the
unchanged strict identity/effect grader on the dedicated synthetic test tenant.
The maintained Cloud deployment verified that revision before model use. This
was Linux, real Postgres, Daytona, production Runner and native Codex with
OpenAI `gpt-5.4-mini` through the approved capped gateway, without customer data.

A 15-second freeze/kill control passed first. Ten ordinary tasks then each ran
600 deterministic hash-chain steps and emitted 4 KiB per step. The exact main
Node process was frozen at 18:36:05.374Z and killed at 18:41:06.139Z. Postgres and
Daytona stayed up; no lease timestamp was changed. HTTP readiness was observed
by 316.474 seconds, natural ownership at 319.682–320.245 seconds, and new
authenticated attachment plus canonical ingestion for all ten by 389.839 seconds,
inside the original 420-second grace. These are observation upper bounds.

All ten retained run, runner, native session, PID, process birth time and sandbox
lease while still active after recovery. Each advanced 296–300 useful steps
during the outage and completed all 600 with the independently recomputed chain
and a single exclusive effect. The largest step gap was 1.947 seconds. Each
finalized once, committed its workspace export and left no queued recovery.
Fresh work was admitted while originals were active and completed separately.
The strict grade is **10/10 passed**. The prior two **0/10 failed** grades remain
preserved; the successful getter fix did not remove the process-birth assertion.

This campaign settled 190 provider requests at $0.642828150 estimated model cost.
All three campaigns total $1.973814300 estimated, below the approved $25 cap,
with no held, unknown or inflight requests. Owned agents were paused and the
temporary gateway closed. Test-instance CLI access was retained as requested.
The complete report and evidence work product are attached to the existing
private test task; private URLs are omitted from this public repository.

Candidate CI first lost workers in Vitest/browser shards; logs and annotations
remain recorded. A bounded retry passed on the same revision. Full repository
typecheck/build passed. A frozen SQL observer produced no usable receipt in this
campaign, so it adds no new SQL, traffic, CPU, memory or capacity measurement.
The earlier frozen-write observations remain attributed to their older artifact.

This qualifies a **same-artifact main-process crash/restart for this profile**.
The Cloud rollout path still requests task drain. Active different-artifact
A→B/B→A, a normal drain-free Cloud rollout, other hosted harnesses, 25-way load
and the complete viewer matrix remain open; PR 3 stays draft. Later launch-asset
adoption fixes are not qualified by this artifact's hosted result.

### Post-campaign review corrections (2026-10-26)

Runner correction `1fb535d12b` makes live dispatch and semantic recovery share
per-call ownership. Two authenticated-transport regressions first duplicated a
callback, then pass with one authoritative result and no redispatch. Already
queued results bypass repeated resolution. All 145 control-plane and 296
transport tests pass. The wider 621-test run passed 620 and exposed an old pinned
Copilot digest after source-attestation regeneration; its corrected 56-test
profile retry passes. The active attestation changed; historical released
fixtures did not. TypeScript, protocol generation, source identity and module
boundary checks pass. The earlier failed run remains recorded.

Server correction `e61605e197` recovers completed case/workflow mutations through
their existing adapters and API receipt keys, without HTTP dispatch or another
receipt reservation. Three real-Postgres/authenticated-route regressions fail
before the correction and pass afterward, including missing, changed, pending,
disabled-feature and Stop outcomes with unchanged domain effects. Server
TypeScript passes. The broader run passed 97 tests and failed three held-output
cases because a debug fixture binary remained from the runner-only PR. Its
source and binary capability differed. Rebuilding the server-owned fixture and
rerunning those three cases passes, including zero streaming checkpoint SQL,
zero idle SQL, positive control calibration and empty-controller-file adoption.
Both runs remain recorded. Build the fixture with the owning PR's source before
running targeted native recovery tests after switching branches.

These corrections follow the exact 73b65d87 hosted pass. That campaign does not
qualify later artifacts or other harnesses. The superseded 54f3c879 preview build
was cancelled after the fresh race and attestation findings, before deployment.
The next candidate requires fresh checks and review. Different-artifact upgrade,
compatible rollback and the ordinary Cloud drain policy remain open gates.

### Fresh-call ownership and initial-view recovery review (2026-10-26)

A subsequent review exposed a distinct ownership case: reconciliation could
claim a fresh input during its persistence barrier, then return no saved outcome
and suppress its original callback. Runner correction `e042344de2` reserves live
ownership before that wait. Fresh missing/stale-outcome overlap tests fail before
it and pass afterward, while saved-input concurrent reconciliation still resolves
once. Failed persistence still cannot dispatch. All 146 control-plane and 296
transport tests pass, with a final 146-test control-plane retry and TypeScript
check after the callback-binding refinement.

Agent Detail also needs negotiated tail recovery when acknowledgement aborts its
first history read before a cursor exists. Both page variants now retain one
manual history page, then drain their independent recovery cursor without a new
source event. Two 5,000-row regressions fail before the fix, then show the latest
saved tail, retain manual pagination, and add no recurring reads. All 361 affected
UI tests, UI typecheck and token gates pass.

The 051bc00a candidate build was cancelled before deployment after those findings.
A new candidate must first receive fresh CI and review. Its earlier local browser
journey pass remains attributed to 051bc00a, rather than the subsequent source.
The 051bc00a chat shard also failed an unchanged assertion: a provider-effect
receipt was still processing instead of processed. Its isolated same-job retry
passed, but the original job remains failed. This is recorded as an observed
assertion-timing failure, not a worker-loss incident or a proven production fix.

### Normal-operation cost correction (2026-10-27)

Component comparison uses frozen full-stack source `24e4ea15fc9cb52ea3dec8d51ad551596de2c698`
as before, and `51decdb9fb` as after. This compares two versions of the hot-upgrade
stack, not the pre-feature server. The isolated Linux Node and PostgreSQL 17.11
containers each have two CPUs and 1,536 MiB. Each phase has 300 controller sessions,
10,000 historical tasks and a 65-second fixed offered workload. Checkpoints use
the production encrypted writer, 4 KiB control results and natural 20-second lease
renewals. The machine and Docker storage remain shared with other local work;
this is not dedicated-host or production-capacity evidence.

PR 1 makes external persistence the sole durable controller store. A local marker
requires external restoration on restart. Standalone consumers retain the current
staged file journal; the sandbox runner journal is unchanged. The initial
file-only correction passed the steady profile but failed both burst latency gates
at 602.5 and 687.8 ms. Those failed phases remain in the evidence.

PR 2 gives checkpoint transactions a separate pool capped at two connections per
database owner. Requests and lease renewal retain their own pools. No control
barrier is released early. The real-Postgres backlog regression fails with the
shared request pool, then passes with the bounded pool. It also restores the queued
commands and rejects late writes after shutdown. Cost collection observes both
application and checkpoint clients; a positive control still trips its write oracle.

The final campaign reverses order for each repeat (steady ABBA, burst BAAB):

| Profile | Offered requests | Before read p99 | After read p99 | Before/after checkpoint transactions per phase |
| --- | --- | --- | --- | --- |
| Steady | 500 reads/s, 100 writes/s | 107.6 / 106.1 ms | 107.8 / 107.2 ms | 3,899 / 3,899 |
| Aligned burst | 100 reads/s, 20 writes/s | 689.4 / 584.1 ms | 103.3 / 105.4 ms | 3,600 / 3,600 |

All four after phases pass the unchanged absolute and relative read-latency gates,
99% offered-throughput gate, sub-second drain gate, and database CPU/memory gates.
There are no SQL errors, rejected operations, ownership losses or missed database
admission probes. Each steady phase changes 7,798 checkpoint records; each burst
phase changes 7,200. After phases make zero hot-path local journal fsync calls;
before phases make 7,200–7,798. This does not remove PostgreSQL WAL or fsync.

Client-issued SQL is effectively unchanged: about 909.5 commands/s in steady
phases and 411.9 commands/s in burst phases. Matched steady phases issue
59,119 before and 59,120 after commands. The extra statement initializes the new
client's PostgreSQL type cache. The final burst phase offers one extra normal
request tick, so its raw total is reported separately rather than treated as
checkpoint overhead. Existing hot-upgrade control and renewal writes remain.

The measured tradeoff is up to two additional active connections per instance,
not per agent. Steady PostgreSQL CPU rises from 10.15–10.31% to 11.85–12.05% of
the two-CPU allocation; burst CPU stays near 4.4–4.8%. PostgreSQL cgroup peak memory
is 526–532 MiB, including cache. Node RSS overlaps across variants and does not
establish a memory saving. Controller delivery can wait behind its bounded pool;
after burst control p99 is 379–475 ms. No production spend saving is inferred.

Complete phase JSON, SQL shapes, source/image hashes, sampler output and both
failed and passing attempts are retained under
`/tmp/paperclip-controller-persistence-20261027/`. The real-runner 8/512-chunk
checks still observe zero streaming and idle checkpoint SQL. These component
measurements do not qualify a new hosted artifact, a different harness, actual
A→B/B→A replacement, or the ordinary Cloud rollout policy. Those gates remain
open and PR 3 remains draft. Integrated-stack checks and review status belong to
the exact current PR heads, not to the measured source by inference.

### Integrated persistence review (2026-10-27)

The stack incorporates master `663fe667d6`. Its runner controller suite passes
164 tests and the rebuilt transport/one-process fixture lane passes 303. The
transcript window merge regression fails before correction `bccff8f35d` and
passes afterward with all 327 affected UI tests. The production-runner browser
journey passes at `ca600c76e3`, including two views, company switching, reconnect,
terminal catch-up, reload and zero recurring healthy transcript reads. It uses a
deterministic harness fixture, not a model service or hosted harness.

Fresh review adds three server receipt regressions: title/feedback receipts have
their own stores; committed creation/reassignment still need their idempotent
wake suffix; monitor input and retry keys use owner normalization. All seven
cases fail before `0edb3a736e`. Recovery now reuses those owners without entering
an absent receipt's mutation or cancellation path. The new cases, existing
semantic authority cases and real HTTP/API recovery lane pass all 92 tests on
owned PostgreSQL databases after `d0ce42378c` fixes fixture teardown. That fixture
bug had closed a sibling database's clients on the shared host; its independent
wire-protocol regression fails first, then all four teardown tests pass.

The first HTTP attempt fails embedded-Postgres initialization on this Mac. The
first external-host attempt passes 90 cases and fails its last two after sibling
teardown, plus teardown itself. Both failures remain recorded. The earlier full
Mac suite was interrupted after repeated cluster initialization failures and is
not a green whole-suite result. Qualification units pass 46 cases but fail their
embedded-database setup case locally. These results are separate from fresh CI.

CI's server shard initially passes 2,046 cases and fails three provider adoption
fixtures that omitted required Daytona ingress authorization/capability. Test
correction `47a159e3ba` represents the authorized target without weakening the
production transport check; all four affected adoption cases pass locally.
Workspace typecheck passes after the receipt and teardown corrections, including
protocol checks and Rust. The sandbox-denied tsx IPC attempt is retained beside
the permitted retry. Current-head CI and review are still required.

PR 4 correction `9219fc6bc6` preserves a gap notice that could not be sent before
an unrelated view changed its interests. The reproducer fails first; all 19
server delivery/browser-interest tests then pass. The original congestion
deadline remains active until the browser is told to catch up. This changes
presentation recovery only; it has no checkpoint, execution or accounting effect.

### Completion-only recovery review (2026-10-27)

A later Paperclip review identifies completion inputs that would remain pending
when a standalone caller omits its ordinary-tool outcome lookup. Runner
correction `bcc0785946` wires completion recovery independently in both the
Codex transport and shared external driver. The three restart regressions fail
before their respective corrections and pass afterward, covering both handler
startup orders and an external runner with no ordinary-tool callback. Unknown
ordinary tools remain held. Candidate v66 attestation bytes remain frozen; v67
binds the changed bridge and compatibility declaration without redefining v66.

The controller/attestation lane passes 230 tests. The rebuilt full
Codex/Dot/Muse run passes 326 cases and times out one existing mid-goal adoption
case at 30 seconds. That case passes its isolated retry, then the complete Codex
transport file passes all 302 cases on unchanged source and binaries. The
one-process fixture separately passes all three cases. Conformance and replay
parity pass. The initial timeout remains evidence; these retries do not establish
its root cause or qualify a hosted harness.

CI of the preceding successor heads also reports a login-cleanup idle-work
assertion and an unrecoverable runner close in the timeout-attachment fixture.
Both lie outside this completion correction. The unchanged login-cleanup file
passes all 16 cases against a fresh owned database. The close case passes in the
full 302-case local repeat. Those CI failures remain recorded and fresh
current-head CI is required; an isolated pass does not turn an earlier job green.
The runner-only local API-authority check passes 2,027 cases but its 47 real HTTP
cases cannot initialize embedded Postgres on this Mac. The integrated server's
owned-database HTTP path is verified separately.

A subsequent qualification review catches drift between the Claude continuity
check and its supervisor request: the former requires outage evidence for ACPX,
while the latter creates it only for Codex. The existing Claude Daytona roster
cell fails a selected-cell fault-receipt regression before the correction.
Both consumers now use the same outage policy. The existing Codex and Claude
cells produce valid replacement fault receipts through the supervisor contract;
local, legacy and Stop cells retain their prior behavior. All 108 affected
qualification tests and the runner E2E typecheck pass. This is selection and
receipt-contract proof with injected supervisor operations, not a new hosted
Claude qualification.

Late review also reproduces a fresh remote claim whose lease is already 30
seconds expired because cleanup/candidate work consumed the captured batch time.
Claims now calculate their deadline with the database clock in the existing
UPDATE, after the owner row is locked; no query is added. The real-Postgres
regression passes together with three natural renewal/preparation cases,
including the 90-second pool-delay case. Server typecheck passes. These are
deadline and ownership tests, not a simulated deployment qualification.

Both Agent Detail variants reproduce a disabled history-paging button after
visibility aborts an in-flight manual page read. Resetting that read's loading
state preserves the retained cursor and rejects its late response. Both
regressions fail first; all 28 affected history/visibility tests and UI token
gates pass. CI attempts on the preceding heads also lose several runner services
at the same timestamp; those shutdown/cancellation logs remain in the evidence
and are not reported as assertion failures or passing jobs.

The shared outage selector subsequently reproduces a dedicated-suite regression:
it excludes `daytona-restart-continuity`, suppressing its strict original-process
checks. The everyday default also requests one second despite its catalog's
125-second declaration. Both suites now derive that default from catalog
metadata; the dedicated suite rejects a shorter override. Explicit short
everyday experiments remain available with their actual duration recorded. The
catalog definition advances to version 10. Both new policy cases fail first;
all 149 relevant qualification tests and the runner E2E typecheck pass.

A broader catalog invocation additionally finds existing model-account coverage
drift already present in master `663fe667d6`, and a report CLI fixture that did
not produce its output in the sandbox. Those failures remain in the evidence;
the permitted report-catalog
retry passes all 15 cases. They do not alter the continuity acceptance contract.

Transcript rows now use their run/sequence identity in both Agent Detail
variants. Two regressions first reproduce collisions between database IDs and
synthetic live IDs, then pass without duplicate keys or missing rows. All 30
history/visibility cases pass. This is a presentation fix and changes neither
canonical logs nor checkpoint writes.

### Normal-operation hosted comparison and merge update (2026-10-27)

The hosted release comparison uses Core-only baseline
`5823e9a6646b1624416a1e33f6016037cb88c1a3` and candidate
`445a76563c444188d35ddb4f219ddee8292d4f73`, each with two app CPUs,
1,500,000,000 bytes of app memory, Neon 0.25–1 CU and 2,000 synthetic historical
tasks. The source range includes other Core changes, so it does not isolate the
causal cost of recovery.

A baseline-only 50-read/10-write-per-second warmup overloaded and was stopped:
1,016 offered requests produced 652 successes and 364 client timeouts. The
bottleneck remains incompletely localized. The original ten-agent ABBA, burst
and viewer acceptance profile has not passed.

A separately declared API-only pair at 10 reads and two writes per second uses
120 seconds of warmup and 120 seconds of measurement. Both arms complete all
1,440 requests without errors, with no active agents or viewers. Baseline and
candidate raw Postgres transactions are 430.77/s and 430.56/s, including observer
and background work. App CPU is 12.70% and 13.04% of the two-CPU allocation. Read
p99 is 3,120 ms and 1,979 ms; write p99 is 3,359 ms and 2,384 ms. Both fail the
absolute latency gates. Peak cgroup memory is 1,136.5 MiB and 1,180.8 MiB; the
candidate exceeds the declared 80% memory gate at 82.5%. Main-process peak RSS
is 841.3 MiB and 822.4 MiB. A short ordered pair cannot establish leak behavior,
sustained capacity or active-run checkpoint cost. No checkpoint mutations occur
in this API-only workload. Actual database CPU and statement counts are not
available; transaction counts are not statement counts.

One native Codex/Daytona pilot per arm completes 20 steps, with independent
hash-chain and exclusive-effect file checks. The candidate retains 80 encrypted
checkpoint parts totaling 466,260 bytes. This is not a growth-rate measurement.
Both test companies subsequently pause because gateway model usage is unpriced
to Paperclip. The scaled native comparison remains unexecuted; budget enforcement
is not qualified by these pilots. The immutable report SHA-256 is
`8ccde5cd71fd1076c9046135fdb9a46d7256c863672f63dee3b614b123615bc6`;
the metrics-only evidence archive SHA-256 is
`8c650ba41c0b8f8140a8f654840feb6dc165879068e92f576534a0dc995ee49e`.

The master reconciliation preserves published Copilot v66 and the prior
hot-upgrade candidate identities, and generates v68 for the combined sources.
The focused runner lane passes 290 cases and typecheck. Its first sandboxed
invocation cannot open loopback listeners; the permitted retry passes. The
server now resolves the encryption key once per checkpoint batch and removes
two unused execution-lease declarations. Six key batching/provider cases, server
typecheck, migration safety and boundary/token checks pass. The checkpoint
migration is regenerated as 0385 after master's newer migrations and retains
preview idempotence. Fresh CI and review are required for the updated heads.
These code checks do not close the remaining different-artifact, hosted rollout,
additional-harness or complete active-agent/viewer qualification gates.

Fresh review reproduces a public-reader race during external checkpoint writes.
Lifecycle events, result proposals, progress and command outcomes are visible to
transport polling before their write succeeds. Four new reader cases fail before
the correction; all held/rejected-write variants pass afterward. The controller
now publishes committed metadata and command outcomes, retains immutable event
references and reuses unchanged command decoding. Streaming remains independent
of checkpoint writes, and the last command result flushes without waiting for a
next command. The first combined repeat passes 556 cases and fails two overlap
fixtures that wait for the old provisional public view. Those fixtures now wait
for entry into the persistence callback and require the public event view to stay
empty. The full controller repeat then passes all 168 cases. The other four
combined files pass 390 cases. Runner TypeScript build and typecheck pass.

Fresh qualification review also reproduces three rejected supervisor requests:
the Claude everyday cell and both dedicated continuity cells are selected by the
shared outage policy but rejected by a stale Codex-only guard. The existing file
reader is extracted as the supervisor's request boundary and uses that same
policy. Real request-file tests cover all four supported cells, unsupported cells
and conflicting fault requests. All 93 request/outage/continuity/process-owner
cases and runner E2E typecheck pass. This verifies the supervisor request path,
not a hosted Claude upgrade.

The first master-reconciled CI attempt loses seven runner services together at
21:40:37 UTC. Their retained logs report shutdown and cancellation without test
assertion failures. The subsequent source corrections require fresh CI; no
successful run is inferred from the interrupted attempt or an older head.

A further server review finds the expired-owner inventory query truncating its
known active-run IDs at 100. Repeated blocked issue locks can therefore starve
later recoverable runs. The query now returns all IDs from the caller's finite
active inventory in the same scoped query; empty inventory still makes no SQL
request. A 101-run real-Postgres regression retains 100 blocked owners and claims
the original remaining remote execution. This host's Postgres support gate skips
the fixture, so its execution in Linux CI is required before server merge. Server
typecheck and the independent zero-query empty-inventory case pass locally.

The additional standalone forbidden-import checker reports 11 escaped imports in
existing controlled-eval, CI helper and instruction-test files. All those files
and the checker are unchanged from master09d4ca533e. This pre-existing checker
failure remains recorded; package-cycle boundaries, protocol manifest, module
boundaries and UI token gates pass. Final combined workspace typecheck and
production build pass after the committed-view and supervisor request fixes.

The runner contract lands in master at `0a08d37aa0` after exact-head CI and a
fresh 5/5 review. Integrating that squash result keeps the server PR's remaining
diff scoped to its own behavior. Master has meanwhile added migrations 0385 and
0386, so the checkpoint schema is regenerated as 0387 with identical idempotent
DDL. The final retained snapshots are 0383–0387. Migration numbering/safety and
server typecheck pass. This ancestry/migration reconciliation requires fresh
checks on the remaining three PRs and adds no hosted qualification evidence.

### Merge follow-up: fresh claim contention and transcript authority

Review correction `69e6d415c0` starts fresh execution leases from the database
wall clock in the final claim update, after run locks and lineage reads. The new
Postgres variant observes the actual claim blocked on a run-row lock and requires
a full 60-second deadline after release. It changes no new lease timestamp. The
existing startup-renewal case and server typecheck pass locally. The host skips
the integration suite, including the permitted repeat, so Linux CI must actually
execute both the contention variant and the 101-run expired-owner case.

The full executor file additionally reports 921 passes and 16 failures: all
16 fail at embedded-Postgres startup, before their database assertions. The local
database limitation remains a failure, not a full executor pass. Source CI is
required. No paid harness test or deployed artifact is involved in these checks.

Transcript correction `84e9bc45c8` adds the current HTTP company-scope permission
to full WebSocket event/log delivery alongside existing task access. New real-key
Postgres/WebSocket cases cover both negotiation modes, allowed task access under
low-trust policy, blocked native and legacy content, and policy grant/restriction
on the same connection. The first local attempt fails listener sandboxing; its
permitted repeat fails embedded-Postgres startup and skips all five cases. These
new cases require actual passing Linux execution before the transcript merge.
Server typecheck and 27 existing delivery/WebSocket/toast cases pass locally.

The qualification instructions now state the actual 125-second remote native
Codex/Claude default and the explicit 1000 ms override for a short experiment.
Master then adds its own migration 0387. Reconciliation `96d07efb0f` preserves all
master SQL/journal entries byte-for-byte and appends checkpoint migration 0388
with the same idempotent DDL. Snapshots 0384–0388, numbering/safety and server
typecheck pass. Each updated candidate still needs fresh CI and exact-head
review. Hosted performance, different-artifact upgrade and rollback gates remain
open; merging source does not qualify them.

The replacement-smoke driver also now guards database setup. Its real executable
previously exits without a saved report for both an invalid database URL and a
refused loopback connection. Both cases fail before the correction and pass
afterward, alongside the three existing cleanup cases. Reports distinguish
whether a database or wrapper was created, and cleanup touches only registered
resources. Initial typechecking finds a query-result inference error; an explicit
result type corrects it and the E2E typecheck passes. This experiment starts no
server and runs no provider turn; it qualifies failure evidence, not continuity.

Transcript-head `405bedd189` has a serialized CI shard failure during the
unchanged scheduled-retry route fixture's teardown: a late wakeup references an
agent between deletion of wakeups and agents. The shard reports 283 passes and
one failure. The same serialized shard passes at server-head `d1513f8311` with the
same route test. The failure remains retained; the forthcoming qualification
correction changes the successor head, so the superseded job is not retried.
Fresh current-head CI remains mandatory; this is not a transcript assertion pass
or a waived gate.

The Linux Runner lane at server-head `d1513f8311` executes and passes the
101-run expired-owner regression (2.803 seconds) and the 63.625-second fresh
preparation renewal case. It reports 114 passes, one failure and five optional
skips: the claim-lock variant fails during setup because the parameterized cases
reuse a uniquely indexed environment name. Correction `227dc068a8` gives each
case its own environment and provider-lease identity. This is a fixture repair,
not a retry of the failed head. Actual claim-lock execution and fresh full CI
remain required; the overall earlier Runner lane was not green.

Transcript shared-stream recovery tests move unchanged into their own focused
file. The original is 803 lines and the new file 321. The first split leaves one
helper behind and fails one of 39 cases plus typechecking; restoring that fixture
helper yields all 39 passes, UI typecheck and clean token gates. These are hook
fixtures; they do not establish hosted viewer performance.

Linux general-server shard 1 at transcript-head `405bedd189` executes all five
live-event run-read tests successfully, including both new transcript-permission
variants (2.346 seconds for the file). This is source-bound permission evidence;
that head's other two CI failures remain failures. Master then adds its own
migration 0388. Integration `e5acdc53c6` appends the unchanged idempotent checkpoint
DDL as 0389, preserving every master SQL file and journal entry. The retained
snapshots are 0385–0389; migration checks and server typecheck pass. This integration
requires fresh current-head CI and review and adds no hosted qualification.

### Review follow-up: shutdown and qualification evidence boundaries

Server correction `9bb9d3417e` fences checkpoint-pool creation even when shutdown
precedes first use. The real lazy-client regression fails before correction and
passes afterward; all 12 checkpoint-lifetime/options cases and database typecheck
pass without opening a database connection. Existing created pools stay ended,
other owners remain usable, and test doubles retain their fallback behavior.

The qualification review batch reproduces 14 failures: absent-cache retirement,
missing or mismatched expected artifact pairs, malformed database history, and
invalid outage/manifest configuration without saved evidence. After correction,
all 91 focused outage, observer, executable smoke, cleanup, remote-restart and
artifact cases pass with E2E typecheck. Artifact smoke checks both revision and
frozen tree against the requested A/B/A transition. An absent old cache is safe;
a missing destination parent with a still-present cache remains a failure.
Malformed history fails before checkpoint loading. Seed evidence now precedes
configuration reads, so invalid settings and manifests retain failed reports.

The reported wait on an already-completed original run is already handled by
`waitForRemoteRestartBoundary` and `pollUntil`'s immediate rejection. Existing
cases cover missing, succeeded, failed, cancelled and timed-out runs in one read,
with no clock advance. This remains an unexercised boundary; it does not authorize
a replacement task or claim active continuity after completion. These checks add
no real harness turns, deployed artifacts, or hosted upgrade acceptance.


### Partial outage receipts survive cleanup (October 27 review)

The shared case-evidence collector now copies sanitized supervisor outage
receipts from the temporary control directory into each case's snapshots before
normal cleanup. This is independent of successful restart acknowledgements.
Startup, HTTP readiness, and authenticated recovery failures therefore preserve
the last recorded phase. Restart request files and temporary receipt writes are
not copied. Ordinary cells with no outage retain their existing evidence path.

Three filesystem regressions fail before the collector change. They use the
normal replacement and evidence-packaging interfaces, delete the temporary root,
and then read the published receipt. After the change, all 95 focused
qualification cases and E2E typecheck pass. The tests also confirm redaction and
existing log collection. This is evidence-retention proof, not hosted upgrade
continuity or final performance qualification.


### Current Linux recovery proof and fourth master integration

Server source `9bb9d3417e` executes the previously missing contention case in
Linux job 122521800018: fresh preparation passes in 62.808 seconds, genuine
claim-lock contention passes in 1.227 seconds, and the 101-run expired-owner
case passes in 3.828 seconds. That recovery lane finishes with 115 passes and
five optional skips. These are source-attributed correctness receipts, not
hosted upgrade or production load evidence.

Master `3421366903` adds migration 0389. Integration `9c59bde1a9` preserves
every master SQL file and journal entry, then appends the unchanged idempotent
checkpoint DDL as 0390. Retained snapshots are 0386–0390. Migration checks and
server typecheck pass. The local database owner/lifetime batch initially has
two loopback-listener EPERM failures and 14 passes; with loopback permission
all 16 cases pass. A new exact-head CI and review gate remains required.


### Ordinary warm admission with external checkpoints

The actual external-persistence callback leaves a marker instead of a legacy
full journal. A regression through the public server executor reproduces
`durable_identity_unreadable` on the second completed warm turn. The correction
restores the prior run's opaque checkpoint before identity and reuse checks. It
uses the retained owner's run/issue or a validated native-session checkpoint,
since an original marker can precede later warm identities. Three completed
turns now pass, including selection of the second run's saved checkpoint for
the third turn. The backend and database-load seam are scripted in this proof;
the control plane, persistence callback, identity rotation and filesystem are
real. This does not qualify an underlying harness.

All 288 provider-wiring cases and server typecheck pass. The initial wider
focused run reports two failures: the scripted runner projection had not been
rotated for the third turn, and a legacy missing-checkpoint denial changed.
The fixture now rotates the runner identity and legacy file-backed roots retain
their existing checks. Initial typecheck also reports nullable fixture session
IDs; the fixture is corrected before the passing typecheck. Real-Postgres cases
are skipped by this Mac's support gate, including the new check that a foreign
normalized session fails before any restored directory is created. Require
current Linux CI execution before merge. No new streaming writes or idle SQL
are added; reconstruction is limited to warm admission with an external marker
or an older local projection.


### Delivery read deadlines below the queue bound

Four cases reproduce a live-delivery freeze when a permission or decoration
read never settles, for both old and negotiated clients, with only two retained
items. The five-second pending-read deadline now closes the connection before
overflow is necessary. Disposal clears queued items, prevents late results from
being sent, and leaves unrelated connections responsive. Interest revisions
cannot reset the pending read's original deadline. The underlying read is not
cancelled by socket closure; at most the already-started read remains until its
driver settles. That closed connection can launch no subsequent delivery work.

After correction, all 28 delivery, unchanged workload-cost and WebSocket cases
pass with server typecheck. Six new cases include the four stalled-read variants
and settling/disposal before expiry; they confirm no timer remains when idle.
The workload comparison preserves the existing viewer-interest authorization
call counts. These unit counts do not measure final hosted SQL or CPU savings,
and do not complete the active-agent/viewer performance matrix.


The late-error regression also fails before correction: a rejected read after
socket disposal could create a new congestion timer. Closed deliveries now
ignore that rejection before any recovery work starts. The final combined
delivery/cost/WebSocket/toast batch first has four loopback EPERM failures and
31 passes; its permitted repeat passes all 35 cases. The prior 28-case result
excluded the toast file. Both outcomes remain recorded, and no hosted result
is inferred from these local fault tests.

Master `e9e84bb8a1` then adds migration 0390. The fifth reconciliation generates
checkpoint migration 0391 with the identical prior idempotent DDL, preserving
every master SQL file and journal entry. The five snapshots are 0387–0391.
Migration checks, server typecheck and all 13 warm-admission/configuration
variants pass after integration. Current-head CI and review remain required;
prior source checks are not carried forward as a new-head pass.


### Plugin recipient redaction and post-recovery application reads

The new native live payload reproduced a registered-secret leak through plugin
`agents.sessions.event` notifications. Browser-only redaction did not protect
that separate recipient. Browser and plugin delivery now share the canonical
structural, current-user and per-run registered-secret read pipeline. Plugin
subscriptions use the existing bounded delivery queue, including its stalled
read deadline and disposal rules. No redaction lookup is added to the producer
or an uninterested native stream. Existing plugin company/run/session checks
remain in their owner. Legacy chunks and final text are also redacted.

The regression registers a synthetic run secret through the production registry
and publishes native events through the real bus and host-service subscription.
Database storage and the secret provider are scripted; the registry, recipient
pipeline and worker notification are real. Native, legacy and final messages
stay redacted; disposal suppresses late notification and later reads. The
initial implementation dropped failed redactions. All 47 registry/plugin/delivery/WebSocket/toast
cases pass, with server typecheck. Recipient redaction can add database reads
for active plugin subscribers; final hosted plugin-viewer costs are unmeasured.

A subsequent review reproduced a lost terminal notification when either the
settings read or registered-secret resolution failed. Both regressions failed
before the fix. Plugins now receive one content-free delivery error and their
subscription is removed on any delivery failure. The same path handles backlog
closure and the existing subscription timeout. This error ends notification
delivery; it does not stop the agent or change the recorded run status. No
retry, extra read or browser delivery behavior is added. All 50 cases in the
six-file registry/plugin/delivery/WebSocket/toast lane pass, including both
terminal failures, timeout, no subsequent reads, and existing late-disposal
coverage. Server typecheck passes. Database storage and secret provider remain
scripted in the plugin regression; hosted plugin-consumer recovery is unmeasured.

Two UI regressions reproduce a run missed between the pre-resync refresh and
the server's replacement-interest acknowledgement. Application queries now
refresh after a matching recovery ACK. If a read was already in flight, one
follow-up waits for it to settle; stale scopes and inactive queries cannot
refresh. Initial and ordinary interest acknowledgements add no refresh. All
174 live-provider/recovery/interest cases and UI typecheck pass, including
stale/duplicate acknowledgements and disconnect, hidden, company, session and
unmount races. Token gates pass. This introduces no recurring healthy polling.

### Current Linux receipts and one expiry-worker diagnostic retry

At server `8fbe62b41d`, Linux job 122535673837 passes all 938 native-executor
cases. The warm external-checkpoint regression is included. Job 122535673326
passes the native recovery lane (115 passes, five container-only skips),
including the encrypted-restore session guard, fresh preparation (63.694 s),
claim-lock contention (4.043 s), and 101-owner recovery (4.284 s).

Server job 122535673841 has 3,876 passes, one skip and one failure in the
unchanged expiry-worker retry/drain timing test; cleanup also reports that
test's retained injected error. The entire server/database tree and this
fixture are identical on qualification source `b64cac6951`, whose job
122536300082 passes all 20 expiry cases and all 3,877 shard cases. The fixture
advances fake time while asynchronous retry work can be in flight. One
diagnostic retry of the failed current-head server job is authorized and
requested; the exact timing race is not proven and no assertion is weakened.
A repeated failure requires investigation, not another retry. This record does
not mark that gate green before the retry finishes.

### Per-replacement identity and malformed receipt retention

The last qualification review reproduces two gaps. An intermediate rollback
step could cite another runner or native session for the same run ID; only the
final step checked the full recovery identity. Every step now compares run,
company, issue, runner and native session against its own pre-fault boundary.
Negative cases change an intermediate receipt while retaining a valid final
step, so final success cannot hide the mismatch.

A malformed receipt also threw from the shared collector before evidence could
be packaged. Parse failures now produce an explicit invalid-receipt JSON record
with byte count and digest plus sanitized diagnostic text. The parser's message
is not copied because it can quote private bytes. Other receipts and shared
logs still package after temporary-root deletion; malformed evidence cannot
satisfy an outage grade. Two regressions fail before correction (38 other cases
pass). Afterward all 96 focused qualification cases and E2E typecheck pass.
These are qualification-evidence fixes, with no deployment or provider turn.

### Sixth master integration and completed diagnostic retry

The one diagnostic retry of server job 122535673841 passed as job
122541891915 at 2026-10-28 00:01:54 UTC: all 20 expiry cases and 3,877 shard
cases pass, with one skip. This is recovery evidence, not proof of the exact
timing race; the original failure remains recorded above. No further unchanged
retry is allowed for that head and job.

Master `2adcde162e` adds migration 0391. The checkpoint migration is regenerated
as `0392_daffy_guardsmen.sql`, with the same preview-idempotent DDL. Every
master SQL file and journal entry is unchanged. Snapshots 0388–0392 remain.
Migration checks pass after the sandbox denied TSX IPC on the first attempt.
Server typecheck and all 13 warm-owner variants pass after integration. An
initial test command used the wrong path and ran no tests; only the corrected
invocation supplies the 13-case receipt. Fresh exact-head CI and review are
still required. No hosted fixtures, access, budgets or deployment changed.

All 118 cases in the nine-file qualification support lane and E2E typecheck
pass after integration. The initial sandbox run had 117 passes and one cleanup
failure because process identity inspection was denied. The permitted repeat
passes the real inert process-tree case as well; a subsequent targeted process
check finds no remaining fixture daemon. This is local process evidence, not a
hosted harness or distinct deployed artifact upgrade.

### Seventh master integration and fresh Linux source receipts

Before this integration, server `1ff7bb44f4` passes all Actions checks and
Greptile 5/5; its external review is still queued. Qualification `8dc921f773`
and transcripts `49a8783e9b` pass all checks, have exact-head Greptile 5/5 and
no open feedback. These heads cannot substitute for the new integrated heads.

At server `1ff7bb44f4`, job 122549307215 passes all 938 native-executor cases
(65.497 seconds). Job 122549306469 passes the native recovery lane with 115
passes and five container-only skips. The fresh preparation, claim-lock and
101-owner cases pass in 63.664, 3.961 and 3.824 seconds. The encrypted restore
session guard is included in that suite. At transcripts `49a8783e9b`, job
122549913643 passes all five run-read permission cases, including same-socket
grant and revocation. The current duration partition places this file in
server shard 11; the old shard-1 receipt does not prove it.

Master `553a004926` adds migration 0392. Regeneration produces checkpoint
`0393_elite_angel.sql` with unchanged idempotent DDL. Every master SQL file
and journal entry is preserved; snapshots 0389–0393 remain. Migration checks,
server typecheck and all 13 warm-owner variants pass. No runtime recovery
behavior changes in this integration, and fresh exact-head CI and reviews
are required. No hosted fixture, deployment, budget or access changes.

### Transcript contribution-rule review

The transcript review found explanatory code comments that conflict with the
contribution guide. The 104 comments introduced by that slice are removed, and
the useful ordering, deadline and plugin-delivery explanations are kept in
`doc/live-transcript-delivery.md`. Existing comments and executable test/lint
directives remain. Parsing every edited source before and after removal gives
identical non-comment tokens. The six-file server delivery lane passes all 50
cases, six affected UI suites pass all 91 cases, and token gates pass. No new
test or runtime behavior is introduced; fresh exact-head CI and review remain
required for the new transcript head.

### Eighth master integration after reviewer continuation

Master `2cd747d1b6` is integrated in server `051769955e`. It includes the
published Copilot v70 profiles and new upstream Runner fixes. Those profile
files and every published migration remain byte-identical to master. The
generated checkpoint migration is `0394_conscious_whizzer.sql`, with the same
idempotent DDL; snapshots 0390–0394 remain. Migration checks, the Runner vendor
rebuild and replay parity, server typecheck and all 13 warm-owner variants
pass. The warm cases also pass after the vendor rebuild finishes. Master's
report-lock patch keeps its required context whitespace; the feature delta
passes whitespace checks.

Before integration, server `f2db8a6568` passes all Actions checks and Greptile
5/5. Its workspace setup job 122555672441 fails the 30-second health deadline
while the CLI reports doctor startup, before its server-start step. UI 4,169
cases and CLI 285 cases pass, with one skip. Identical CLI/server/database
source on qualification `a866619d7b` passes the setup and all 286 CLI cases.
The single diagnostic retry, job 122561057225, passes the setup in 33.048
seconds and all 286 CLI cases at 00:49:47 UTC on October 28. This retains the
original failure; its exact timing cause remains unproven. No unchanged retry
may repeat. That old head's Linux native-executor suite passes 938 cases;
native recovery passes 115 with five container-only skips, including fresh
preparation (64.160 s), claim-lock (2.693 s) and 101-owner fairness (3.352 s).
These receipts do not qualify the newly integrated source or a hosted harness.

The existing external server review is resumed after explicit authorization.
It must submit a validated assessment of the current head. New exact-head CI,
Greptile, feedback resolution and normal eligibility remain required. No
deployment, paid harness experiment, hosted fixture or access change is made.

After integration, all 146 cases across 12 qualification support, report-lock
and workflow suites pass, with E2E typecheck. These use local controlled faults,
configuration subprocesses, filesystem packaging and inert process fixtures.


### Project receipt recovery review correction

Server source `5de803c2cd` fixes recovery of a committed `create_project` result
whose HTTP response was lost. Recovery uses the existing project route and audit
receipt owner with receipt-only semantics, current authorization after the receipt
lock, and unchanged input normalization and fingerprint checks. An absent receipt
returns no result before any mutation. Normal execution adds no persistence work.

The transport regression first has two failures and five passes. After correction
and fixing the test's incorrect expectation about schema defaults, all seven
transport cases pass and server typecheck passes. The new real-Postgres/API lost
response, concurrent replay, input conflict, company isolation, cancellation and
no-effect cases belong to the existing chat-project-tools suite. All 20 cases in
that file skip on this Mac. Their Linux CI result is required; a local transport
pass does not prove the database or route behavior.

On prior qualification source `57d3767eac`, jobs 122590643944, 122590643983 and
122590644161 end after runner shutdown/cancellation at 02:18:59–02:19:11 UTC.
They contain no final Vitest result. The host shutdown cause is unproven. No retry
was issued before the necessary server fix superseded that source. These are
retained incomplete/failed attempts, not passing evidence. All new heads require
fresh CI and review. No new hosted deployment, paid harness turn, active-agent
comparison, or A/B upgrade qualification was run.


### Server slice merged; qualification retargeted to master

PR #17439 source `5de803c2cdbdd24d88e411add590edc21954516a` merged into
master as `09ad9adce2cf4742944353a3707a2f908e9bb35e` after all 60 current-head
checks completed cleanly, legacy status passed, Greptile completed at 5/5, the
formal Paperclip review completed at 5/5, and actionable feedback was resolved.
Qualification now targets master. Its diff contains only qualification code and
this evidence document; the server implementation is not repeated in its scope.

Current-source Linux job 122593415890 executes all 20 project-tool tests
successfully (9.480 seconds), including the committed-project lost-response
regression; the shard has 1,627 passes and three unrelated skips. Job
122593415907 executes all 940 native-session-executor tests successfully (61.431
seconds); its shard has 2,358 passes and one skip. The earlier macOS skips remain
local evidence limits and do not replace this actual database execution.

Runner job 122593415475 passes 2,215 cases with one skip in its first lane and
115 native cases with five container-only skips. It includes the encrypted
checkpoint binding guard, fresh remote preparation (63.189 seconds), blocked
claim lock (1.226 seconds), and recovery beyond 101 blocked owners (3.897
seconds). Its real-Postgres SQL cost sample reports zero idle SQL and zero
streaming SQL for both output volumes. These are component correctness and cost
receipts; they do not establish production capacity or hosted active-agent and
A/B upgrade acceptance. All previously retained failures and hosted limits still
apply. The retargeted qualification head needs fresh CI and reviews.


The first post-retarget local batch has four failures and 133 passes across
12 files. All four are in the inherited report-lock test: master #17811 commits
the exact already-approved output lock (`c7f230…b798`), while the fixture insists
HEAD must equal the approved input (`893496…bab4d`). The production helper already
accepts that output unchanged; its policy and patch need no change. The fixture
now checks current HEAD against the two pinned hashes, exercises the real
committed-lock path, and reconstructs the pinned input with the reviewed reverse
patch so its existing unknown-lock, changed-patch and wrong-output failures still
execute. No production validation, dependency, pinned hash or patch changes.
The initial batch selected the one-case process-preservation fixture instead of
the deterministic preservation suite. The corrected batch explicitly includes
both preservation suites and passes all 158 cases across 13 files. The earlier
146-case receipt retains its own source and selection; these counts do not imply
identical test inventories. E2E typecheck also passes after master integration.


After the server squash merge and qualification retarget, the transcript slice
again passes 50 focused server cases, 91 focused UI cases, both typechecks and
token gates. Runner vendor preparation rebuilds the current master inputs before
those tests. No new browser journey or hosted experiment is claimed. The old
browser receipts remain attributed to their source; new-head CI and reviews are
still required before the transcript slice can merge.


### Qualification slice merged; transcript slice retargeted to master

PR #17455 source `8f1d6ec02f5bf6c90e7b27da8156953cabd9a180` merged as
`6987c2f20bf2978c84f9c69b9840586407dfad29` after all 57 current-head checks
completed cleanly, legacy status passed, both completed reviews scored 5/5, and
actionable feedback was resolved. The transcript slice now targets master.
Its evidence-document add/add conflict retains every line of the merged
qualification record and the transcript evidence additions. No production code
changes during this retarget; the 50 server/91 UI cases, typechecks and token
checks retain their prior source attribution. Fresh exact-head CI and reviews
remain required. The hosted active-agent matrix and genuine A/B upgrades remain
open acceptance work; these merges do not qualify them.
