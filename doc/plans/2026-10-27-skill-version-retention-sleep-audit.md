# Skill-version snapshot retention

Parent: slice 63, PR #17876, at
`31c12f1d68ff4a51e06fc2be2abf2c2aee9f9d3a`. Pinned integrated master:
`8548173fc9efdc0fa07644fb92dcc0b6851a95e5`.

This slice is implemented and locally verified. Remote review and CI are pending.
It does not qualify deployed host or database suspension.

## Existing obligation

`skill-version-retention.ts` removes materialized filesystem caches, never the
version rows. Startup waits 60 seconds, then an independent hourly interval
selects companies and inspects their version directories. One-second timers
continue a truncated pass. The code protects current versions, configured newest
versions, agent pins, captured run pins, and recent access. It validates restorable
bytes and rechecks mutable pins under the existing cache advisory lock before
atomic rename. Trash cleanup occurs after releasing that lock.

The cache directories, access-marker timestamps, version inventories, agent
configuration, run context, native finalizations, and environment leases already
persist the necessary facts. No per-worker table or persistent queue is needed.

## Implemented lifecycle

- Reconstruct once at startup/resume using bounded company and directory pages.
- Wake the affected company when cache publication/access changes, skill versions
  or permanent pins change, or run/finalization/environment ownership changes.
- Schedule access or staging grace expiry from its saved timestamp. Reconstruct
  terminal controller-lease expiry from its saved deadline.
- Retry concrete failed inspection, lock contention, incomplete pins, and failed
  trash removal in the affected company. Unknown directories and permanently
  unrestorable immutable snapshots remain protected without a blanket scan.
- Leave current/newest/agent-pinned and fully settled retained history quiet when
  no timed or uncertain obligation remains.
- Preserve dirty requests through drain and changes during a page. Close cache
  directory iterators only after admitted work has stopped.

The existing scanner holds directory iterators between pages. It caps each page
at 50 inspected entries/removals, limits live scans to 16, and expires abandoned
iterators after five minutes. Starting every company's cursor in a fair round-robin
worker could exceed that cap, evict iterators, and restart large directories from
the beginning. Preserve the existing single active company continuation and bounded
company page before introducing cross-company cursor concurrency. A due-company
queue and per-company deadlines can remain in memory; startup reconstruction owns
recovery of that scheduling state.

## Producer audit

| State change | Owning boundary to use |
| --- | --- |
| Materialization success or interrupted staging | `runVersionSnapshotFlight` completion, including failure |
| Reuse of a materialized version | `touchSkillVersionCache` atomic marker replacement |
| New version/current/newest selection | `companySkillService.createVersion` inside its caller-owned or local transaction |
| Failed fork cleanup and skill deletion | Existing company-skill deletion transactions |
| Agent pin edit, hire approval replay, setup completion | Existing agent-configuration and hire transaction hooks |
| Agent/company deletion | Existing instruction-collection invalidation before cascades |
| Legacy/native run terminalization | Existing instruction-collection producer fanout; see slice 42 audit |
| Native finalization ownership/phase | Existing finalization notification boundary |
| Environment cleanup/export settlement | Existing native-environment-settlement and retained-session notification boundaries; reused-task prior-owner retirement uses `writeEnvironmentCleanup` |
| Terminal controller lease expiry | Saved lease deadline; no write is required at expiration |

Before retiring the interval, verify direct terminal, finalization, lease, and pin
writers against these boundaries. In particular, a terminal run can still hold
pins while finalization or cleanup is unfinished. Terminal presentation is not
permission to delete a cache. Pin protection and immutable-byte validation remain
with the existing cache/retention service. Notification helpers only carry a
company scope; startup only wires the coordinator.

Supported writers are the existing service/API owners in one server process.
Filesystem writes from unrelated processes and raw SQL from independent replicas
need an explicit ingress contract. Startup reconstruction does not establish live
cross-process delivery. Keep Cloud sleep-safety and alarm coverage unchanged.

## Acceptance required

- Existing cache rehydration, pin, lock, symlink, staging, orphan, and bounded-page
  cases pass against isolated real PostgreSQL databases.
- No repeated worker SQL or filesystem scan after empty reconstruction or a pass
  containing only permanent pins/completed history.
- Ordinary materialization and version/pin edits wake a quiet worker. Outer
  commit wakes it; rollback does not strand an intent.
- Saved access/staging/lease deadlines are honored. Fresh access replaces an old
  deadline; a pin added before rename prevents removal.
- Terminal ownership and environment settlement release caches only after their
  existing durable predicates permit deletion.
- Unknown pins/contention/I/O failure retain scope and recovery. Other companies
  do not require an instance-wide recurring scan.
- Bounded continuation crosses company pages and directory pages without losing
  earlier grace deadlines or repeatedly evicting live iterators.
- Drain/resume, a write during a page, held startup work, disabled configuration,
  and shutdown preserve ownership and readiness.

No host suspension, Cloud wake, or fleet-cost claim follows from these local tests.

## Implementation and writer coverage

`skill-version-retention-work.ts` owns company discovery, one active directory
cursor, dirty company hints, scoped failures, and the earliest observed deadline.
It registers through `registerDeadlineWork`. The helper now forwards committed
scope hints through an optional `onSettled` callback. Existing consumers omit
that callback and retain their behavior. The coordinator still owns transaction
reconciliation, admission, overlap prevention, timers, and shutdown joining.
The worker stores no provider protocol and performs no SQL in `next`.

The cache owner returns per-page deadlines with its existing prune result. The
worker retains their minimum across directory pages. Only terminal, finished
runs with a database-live controller lease contribute a lease deadline. Current,
newest, and agent-pinned versions suppress that deadline. PostgreSQL still owns
the lease predicate. If the application clock reaches the saved timestamp before
the database clock, the same concrete lease is rechecked after one second; the
worker never treats application time as proof of release.

The producer audit covered every production writer of `currentVersionId`, agent
adapter configuration, `nativeRunFinalizations`, and `environmentLeases`:

- `createVersion`, `cleanupFailedFork`, and `deleteSkills` signal in the transaction
  that changes version/current protection. Caller-owned transactions remain owners.
- Agent configuration and hire-approval replay compare normalized desired skill
  entries. Setup completion also signals because it replaces a draft agent row.
  Plugin-managed edits use the canonical agent configuration path. Other agent
  writers change lifecycle, budgets, identity, or metadata and do not remove pins.
- `notifyInstructionCollection` covers legacy/native terminalization and agent or
  company deletion. `notifyNativeEnvironmentSettlement` includes the finalization
  fanout and environment cleanup writes. `notifyRetainedNativeSessionCleanup`
  covers stop/absence receipts that can release a retained run without an ordinary
  environment release. Each carries only company scope to this worker.
- The direct finalization writers outside those fanouts create or maintain an
  uncommitted/terminal-failure row, change failure detail, or clear an owner only
  without a committed result. They do not satisfy the committed finalization
  predicate that releases a captured pin. A later committed transition uses the
  existing finalization notification boundary.
- Environment runtime release/destroy and lease cleanup use `environmentService`
  or `writeEnvironmentCleanup`. Reused provider-task completion also releases prior
  retained owners; that update now uses the same transaction boundary. Direct
  credential/project-auth, cleanup-attempt, identity, and recovery-evidence metadata
  updates do not change this service's ownership predicate. Removing the completed
  workspace-export marker from an active, unreleased lease still leaves its lease
  pin; its later release uses the ordinary cleanup boundary.
- Filesystem publication/reuse signals are local callbacks, including a rejected
  snapshot flight. They do not invent a database transaction around filesystem I/O.

Startup registers the worker only when retention is enabled. Its first promise
is tracked as background work without delaying HTTP readiness. Shutdown removes
the cache subscription, stops and joins the delivery coordinator, then closes
retained directory iterators. No additional SQL table or migration is introduced.

## Local verification and failure record

At the slice-64 working tree on parent `31c12f1d68ff4a51e06fc2be2abf2c2aee9f9d3a`:

- 91 tests pass in the full retention, immutable cache, and environment-task suites.
  Retention/cache cases use separate guarded external PostgreSQL databases with
  migrations applied. The environment-task suite uses its existing controlled
  plugin boundary. No test is skipped in this acceptance run.
- 95 startup cases pass, including disabled registration and a held reconstruction
  that remains tracked while readiness is available.
- 51 existing native-environment and retained-session cleanup lifecycle cases pass
  against two additional isolated PostgreSQL databases after the notification fanout
  changes. The later task-owner retirement change is covered in the 91-case run.
- Server TypeScript checking and the full server build pass. Repository-wide
  tests/typecheck/build have not been rerun for this slice.

The first acceptance run exposed three external-database fixture accesses that
still read the embedded database object. The fixture now resolves both clients
from the same selected external URL, and the full suite passes. The first startup
run asserted that all unrelated mock workers had no errors; their pre-existing
minimal DB doubles cannot run five unrelated workers. The assertion now checks
this worker's error queue and readiness/active-work behavior. No production
fallback or timeout was weakened for either harness correction.

Evidence includes empty and permanently protected history quiet for three former
hourly periods; ordinary materialization/access/version creation/deletion and agent
pin mutation; outer commit/rollback; all three settlement fanouts; saved access,
staging, and controller deadlines; database clock fencing; restart; scoped failure
and incomplete-pin recovery; 55-company discovery and 18 live directory-page
continuations; a change during a held page; drain/resume; and shutdown joining.
Existing cache cases retain byte restoration, symlink, late-pin, lock-contention,
legacy manifest, native-finalization, and interrupted-trash protection coverage.

The related in-flight [PR #17907](https://github.com/paperclipai/paperclip/pull/17907)
adds keepalive for an actively held skill-cache advisory-lock transaction. That is
an independent lock-liveness repair. This slice preserves that lock boundary and
does not duplicate its implementation. An active-operation keepalive is distinct
from the hourly idle discovery removed here.

## Review repair: interrupted pages and operator reports

Greptile identified unfinished page work that the old hourly sweep had recovered.
Controlled drain during byte inspection reproduced a retained old cache; drain
immediately after rename reproduced an abandoned trash directory behind the
continuation cursor. Both cases resumed, reached apparent quiet, and still left
work behind before this repair. A third regression confirmed that dry-run
candidate/byte reports were absent.

The prune result now records whether its continuation predicate was ever denied.
The worker restarts that company's scan after interruption, even if admission
reopens before the page returns. This recovers both candidates and trash before
disarming. Ordinary bounded-page continuation still resumes its cursor. Successful
pages again log the existing counters, company scope, and dry-run mode, so an
operator can inspect a dry run before enabling deletion.

All three controlled regressions fail before the fix. The full 34-case retention
suite and server typechecking pass after it on the owning slice-64 branch.
Evidence: `sleep64-interrupted-page-red`, `sleep64-interrupted-page-green`, and
`sleep64-interrupted-page-types` local logs. Earlier suite/build receipts remain
at their recorded revisions; current remote CI/review is required after the push.

## Ponytail repair: remaining deletion producer and bounded fresh scans

The full deletion-writer audit found `reconcileLocalPathSkillSources`, in addition
to the already covered explicit delete/fork/company paths. A normal list refresh
after a local source disappears reproduced the orphan leak: the row was deleted,
but its cache remained after the worker became quiet. The reconciliation delete
now registers its company hint in the owning transaction.

Repeated instruction-collection transactions also reproduced multiple fresh
company scans inside thirty seconds. That first repair limited successfully
observed companies while keeping one-second page continuations and actual saved
deadlines precise. It initially excluded empty and uncertain passes because a
blanket floor hid the first materialization. The later security repair below
supersedes that exclusion: timestamped per-directory hints preserve those cache
deadlines while the floor applies to every completed fresh pass. No speculative
recurring timer is armed merely to retain the limit in memory. Disposal also
removes the cache-change subscription idempotently.

The missing-source and busy-notification cases fail before repair. The initial
five-second test used a new wall-clock read rather than the stored access marker;
it was corrected to read the authoritative marker. An intermediate full run then
caught the empty/uncertain materialization race introduced by applying the new
scan limit indiscriminately. The original materialization/grace assertions remain
intact and passed at that revision. Its owning verification passed all 37 retention cases and
server typechecking. See local logs `sleep64-pony-red`, `sleep64-pony-green`,
`sleep64-pony-final`, `sleep64-pony-focused`, `sleep64-pony-acceptance`, and
`sleep64-pony-final-types` for the failure and repair sequence.


## CI fixture repair: fail the orphan write after replacement allocation

The current remote CI run exposed the warm-task spool fixture rejecting every
database transaction. Retiring the prior physical-task owners now correctly uses
the environment-settlement transaction boundary, so that blanket fault stopped
the test before it allocated the unowned replacement or reached the orphan spool.
The unchanged fixture reproduces the exact CI assertion locally: the deferred
cleanup listener is never called.

The fault now starts after the replacement ownership write fails. Prior-owner
settlement can commit, provider cleanup still fails, and orphan persistence still
encounters the simulated database outage. All existing assertions remain: one
wake, durable spool append, retained recovery after failed flush, shared concurrent
flush, and a recovered pending-cleanup lease. The complete 19-case suite passes
after this test-only repair. A guarded dedicated external test database makes the
real transaction path available locally without relying on embedded PostgreSQL.


## Security review repair: scoped wakes and bounded fresh inspection

Five real-PostgreSQL regressions reproduced remaining amplification and deadline
loss: ten settlement writes caused eleven fresh scans for an empty company; an
uncertain company was inspected three times inside its existing retry window;
runless notifications repeated global discovery nine times; administrative
settings writes repeated discovery eleven times; and a cache written after a
company scan's read lost its five-second grace deadline. All five fail before
the repair and pass afterward.

The producer audit confirmed all thirteen `writeEnvironmentCleanup` call sites
already supply company scope, including the native backup writer named by the
scanner. The helper now requires that scope at compile time. The actual unscoped
production source was custom-image setup: those writes carry no heartbeat run
(`issueId: null, heartbeatRunId: null`) and do not release captured skill pins.
They keep the existing environment cleanup notifications but no longer imply a
global skill-cache reconstruction. Scoped environment and instruction settlement
continues to notify retention for its owning company. Instance settings uses a
separate explicit reconstruction signal when its global execution setting changes.
No supported pin-release producer was removed.

Every completed fresh company scan now records the thirty-second floor, including
empty and uncertain results. An already saved due deadline still bypasses that
floor, and bounded page continuations retain their one-second cadence. A fresh
instance reconstruction is also coalesced for thirty seconds; changes arriving
during discovery retain one follow-up reconstruction without restarting its cursor.
None of these in-memory limits arms a recurring scan after work is reconciled.

Local cache events carry their directory, source and timestamp. An access event
uses the timestamp just persisted in the access marker; materialization uses the
start of its actual flight as a conservative inspection hint. The worker keeps
per-directory pending deadline hints until a company scan consumes them. Reuse
replaces the earlier hint for that same directory. Hints arriving during a scan
survive its completion, so they can register a new five-second deadline even while
fresh scanning is limited. The existing retention service exposes its configured
grace duration and remains the authority for reading filesystem state, pin checks
and removal eligibility. Notifications never authorize deletion themselves.

All 42 retention cases pass, including the five new regressions and unchanged
materialization, five-second deadline, interrupted-page, drain and cleanup tests.
The combined cache, startup, environment-settlement and retained-session selection
passes 215 cases with no skipped cases; server typechecking passes, including the
required company scope on every cleanup writer. The startup fixtures include the
new explicit grace-duration contract. Fresh remote CI, Greptile, Ponytail and the
security scan remain required after publication.

## Follow-up: overdue company eligibility and fresh test databases

A real PostgreSQL and filesystem regression with 410 directory entries reproduced
a thirty-second pause between continuation pages while a different company's
grace deadline was overdue. Due deadlines now become ready company work: their
old timestamps leave the deadline maps and their fresh-scan floor is cleared.
The dirty company remains owed a scan even while another company owns the active
cursor. Future directory hints and failure backoffs remain intact. The same
regression passes with all directory-page gaps below three seconds.

The external retained-plugin-task fixture now applies pending migrations before
opening its client. All nineteen cases passed against a newly created, blank
dedicated test database. The previous fixture correction assumed a migrated
local database; it did not establish this fresh-database path.

All 216 cases across the five full retention/cache/startup/environment/session
suites pass, along with server typechecking and build. The new pagination test
and both interruption cases also pass together. One earlier child integration
run passed 203 cases and failed because the rename-interruption hook had not
fired before its test timeout. Both interruption cases passed unchanged on the
owning branch before this fix, and again in the full 216-case selection. That
first timing failure remains recorded; these passes are not evidence that it
never happened. An initial consumer command used incorrect filenames and an
incorrect cache database override and was interrupted; it is not acceptance.
Fresh remote CI and automated reviews remain required after publishing.

## October 29 reconciliation, review repair and current acceptance

This existing skill-retention slice was reconciled with the qualified agent-timer
parent through normal merges. Startup preserves both retention unsubscription and
task-drain expiry shutdown; the shared deadline helper keeps the new optional
settlement callback and the parent's continuation option. Other paths match the
automatic merge. Packages remain byte-identical to the qualified profile-80 tree.
The later monitor-parent audit changes no retention runtime or selected test.

Greptile's remaining P2 about own-company page completion was reproduced. A cache
access hint can expire while that same company's directory cursor is active. The
worker records the company as dirty and consumes the expired timestamp, but scan
completion then applies a new 30-second fresh-scan floor. A directory already
passed by the cursor therefore waits despite its expired grace window.

The repair records a `rescanOwed` bit on the active company when its saved expiry
or cache deadline is consumed. Completion keeps that company eligible instead of
reapplying the ordinary floor. Starting the fresh scan clears the bit. Ordinary
change batching and failure backoff keep their existing behavior; no expired
timestamp is retained to force a busy loop, and no new polling or durable table is
introduced. The existing filesystem records remain restart truth.

The new worker regression uses real cache-change publication and the real shared
coordinator with a paged prune fixture. The unchanged prior worker completes four
pages, then delays the owed fresh scan. The repaired worker starts the fifth scan
with a fresh cursor within the same deadline pass, disarms, and performs no further
scan during another minute. The same assertions and timers fail before the repair
and pass afterward. This is scheduling-boundary evidence; the complete real-filesystem
retention suite separately checks actual pruning, leases, pins and path safety.

Source `3d06de2a8f490e62f8022b8894ba7bbc3a985752` passed **799 cases across
32 complete files**, without skips, in 350.36 seconds. Coverage includes real
skill retention/cache/configuration and producers, runtime selection/concurrency,
environment-task and plugin-warm-task behavior, native environment/finalization
and retained-session cleanup, configuration/settings, startup, and the shared
deadline consumers including agent timers, monitors and routines. Database build,
production server typechecking/build, module boundaries, target migration order
and Runner profile identity pass. Eighteen fresh PostgreSQL 17 schemas plus
per-file fixtures applied all 412 journal entries through index 413. All selected
source hashes and temporary local fixture imports were restored exactly.

An additional fresh-database check ran all 19 plugin-warm-task cases against a
blank dedicated PostgreSQL database with no separate migration command. The
fixture itself created the schema and the full file passed in 10.28 seconds,
proving the earlier external-database migration finding is addressed. These
19 cases are already included in the 799 unique-case count, not added again.

This is bounded local acceptance and a verified repair of the stated P2. Final
publication must adopt the actual merged agent-timer prerequisite and receive
fresh CI/security and reviews on its exact head. No full local repository-suite,
live provider, production load, external wake, measured host/database suspension
or fleet-savings claim is made. Earlier historical results and limitations above
remain attached to their original revisions.

## Final current-master qualification before publication

The source for final publication is reconciled normally through
`d9277b1858a2230bdb726974c90a0c9bc5c5ebe6`, including actual agent-timer squash
`ba07f85cadede4673a06c96becc4c4eed2193b93` and current master
`7e27bc5007c8f9cb8cdce06c24f9813e27f7120f`. This preserves all 24 retention-owned
paths and all 95 unrelated upstream paths byte for byte. The complete package,
UI, E2E-test and map trees equal current master. The earlier profile-80 package
identity statement describes the earlier acceptance revision, not this later
upstream context. No unrelated upstream implementation is removed.

On the first combined master context, 36 complete server files passed **869
cases**; six complete adapter/Runner files passed **140 cases**, with one
intentional Linux-inotify-only launcher case skipped on this macOS host. Two
Rust targets passed **28 cases**, including both configured-environment tests
and the full 26-case native backend target. The Runner and adapter packages
were rebuilt; Runner typechecking includes Rust formatting/workspace checks.
These counts describe 1,009 passing TypeScript cases across 42 complete files
and 28 passing Rust cases, rather than a full repository or live-provider run.
All selected source hashes and temporary PostgreSQL fixture imports were restored.

Two subsequent upstream changes introduced the task activity index and compact
task reads. On the final source, **85 cases across six complete files**
passed again: actual skill retention, cache and worker, task cold-open reads,
task-list query/result/planner behavior, and migration invalid-index/concurrent
replay recovery. These focused cases overlap the earlier retention selection;
they are not added to a unique-case total. Fresh PostgreSQL 17 schemas applied
all **413 journal entries through index 414**. Database build, production server
typechecking/build, module boundaries, target migration order and generated
TypeScript/Rust release-profile consistency all passed.

The separate Copilot source-identity check now fails unchanged on upstream
inputs: the merged OpenCode observability change adds its reserved key to the
identity-bound Rust environment source without regenerating that provider
attestation. All 72 inputs to that identity computation, including the manifest
and historical/current fixtures, are identical to current master. This is an
explicit inherited validation exception, not a claimed pass. This retention PR
does not regenerate or claim new live qualification for a provider release
identity. Fresh exact-head required CI/security and Greptile 5/5 remain merge
gates; a real actionable review finding still requires repair.

The local own-company-deadline P2 regression, fresh blank plugin fixture check
and earlier historical failures remain documented above. No test assertion or
timeout was weakened. No deployed suspension, external wake, full local suite
or fleet-savings claim is made.

## Current-head CI browser-readiness repair

Head `1923b2624be25974a9f83c480534a0374127985b` received fresh Greptile
5/5 and Ponytail 5/5 with an unconditional Ship verdict and only three optional
nits. Required CI/security completed cleanly except the fifth browser shard
and its aggregate. Four connection-review journeys failed their final saved
status visibility check immediately after reload. The browser artifacts show
Loading conversation with the retained history DOM concealed. Approval, decline,
failed execution and actual continuation checks had already passed. Upstream's
task-layout change now waits for stable width frames before revealing history;
the journey also retains a second Connections tab. This is a UI-readiness race,
not evidence of lost review execution.

All four original journeys passed unchanged on the local macOS host (2.7 minutes),
so a deterministic local reproduction is not claimed. CI's four failures and
their screenshots remain the baseline evidence. No unchanged-head CI retry was
used. The fixture now returns focus to the task tab, reloads, and explicitly
requires visible conversation history within 30 seconds before checking the
saved result. The application already bounds its first reveal at 15 seconds.
Every existing saved-result visibility assertion, provider call-count assertion,
continuation check and timeout remains in place; the new readiness condition is
separate from the existing final assertion. There is no production change.

The complete connection-review file then passed all four supported default-server
journeys on a new isolated PostgreSQL 17 database. Its controlled-restart case
remains intentionally skipped by the default configuration, matching CI. The
product interaction, real fixture provider calls, cross-tab synchronization,
resume run identity, persisted result details and Always allow continuation all
remain exercised. Runtime/package/UI sources and all previously accepted sleep
test sources are unchanged. Fresh required CI/security and automated reviews
must be obtained on the new published head; the earlier head's passing reviews
are not reused as a current-head pass.
