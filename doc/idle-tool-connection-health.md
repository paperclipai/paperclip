# Tool connection health while idle

The health worker replaces the aggregate maintenance tick's repeated connection
inventory query. It preserves the existing 15-minute proactive health interval
for eligible connections. This is a deadline migration, not removal of proactive
health checks or proof of host suspension.

## Ownership and lifetime

`tool-access/catalog/health-schedule.ts` owns eligibility and saved deadlines.
The existing health and catalog services still own provider behavior. The worker
uses the shared delivery coordinator for admission, wake coalescing, retry,
drain/resume, and shutdown. Startup reconstructs eligible deadlines from existing
connection rows. No new table, polling listener, or private interval is added.

Eligible rows are active and enabled, excluding `chat_sdk`, `runtime_auth`, and
applications of type `paperclip_plugin`. Disabled experimental connectors have
no deadline until the settings producer enables them. Application status and
company status are not new filters: this migration preserves the old policy.

An unchecked row is due immediately. Otherwise its deadline is `healthCheckedAt`
plus 15 minutes. Individual writes carry a connection ID and reload only that
connection. Application mutations refresh only that application's connections;
company deletion invalidates the company's cache. Startup and instance feature
settings can refresh the whole instance. Inventory reads use UUID keyset pages
of at most 100 rows and observe shutdown cancellation between pages. Refreshes are
coalesced with a 30-second minimum spacing when no due backlog remains.
Batches retain at most 25 checks and continue after one second while already due
rows remain, so the batch limit does not cap dispatch at 50 checks per minute. There is no scheduled refresh when
there are no eligible rows or unresolved changes. Future checks cause no SQL
before their deadline. Each pass checks at most 25 due connections, taking turns
across companies and preserving due order within each company. The company cursor
rotates across passes when more companies are due than fit in one batch.

Before a provider check, the service reloads current eligibility and deadline.
A saved health result, including a failed health observation, owns the next
15-minute deadline. A check that cannot persist an observation retains recovery
debt with exponential backoff from 30 seconds to 15 minutes. A failed scoped
refresh does not prevent checks outside that connection, application, or company. Dirty scopes arriving during
a refresh remain pending. Drain retains them without passive database reads.
Shutdown joins admitted work; it does not abandon a provider call midway.

## Producer coverage

| Owner | Scheduling change |
| --- | --- |
| Tool access API and examples | Create, enable/disable, reconfigure, revive, or restore a connection; setup grants, credential bindings, and runtime slots commit before a creation wake |
| Gallery setup and failure handling | Activation, temporary quarantine, failed-identity restoration, and failed setup deletion |
| OAuth callbacks and finalization | Direct, Cloud, Vercel, and personal/shared activation; reauthorization-required disablement |
| Connection removal | Archive and disable in the owning transaction |
| Health/catalog publication | Successful or failed saved health observation moves the deadline |
| Gateway actual use | Saved remote connection health moves the deadline |
| GitHub installation events | Health observation commits with the installation-event transaction |
| Email setup/control/health | REST connection activation, pause/resume/removal, successful receipt health, and failed health observations |
| Shared chat lifecycle | Voice health activation, setup, pause/resume/removal, resource reconciliation, inbound activation, and failure observations; SDK-only chat mutations do not wake this worker |
| Access removal | Losing the last applicable credential grant disables the connection |
| Smoke Lab | Connection setup and fixture health updates |
| Company deletion | Removes cached deadlines after cascading deletion commits |
| Instance settings | Experimental connector eligibility changes use an administrative all-company hint |

Notifications are awaited before the relevant SQL write. Existing transactions
remain the owner; standalone mutations use the same small transaction helper.
Nested calls retain the shared database client's outer-commit, rollback, and
uncertain-outcome protocol. Provider requests are outside newly added
transactions. The health worker never interprets provider protocols.

Credential-only refresh, refresh lease acquisition/release, client registration,
OAuth authorization-start metadata, legacy credential repair, Slack-search OAuth,
aggregator account metadata, and install markers do not change health eligibility
or `healthCheckedAt`. They do not gain health notifications. A due probe reads
current credentials. AI writers use the excluded runtime-auth transport.
Application display/status updates do not change the old health eligibility.
Application deletion refuses linked connections; company cascade is covered.
New draft-only connections remain ineligible until their activation producer.

## Limits

The supported live writer model is this server's instrumented services. Offline
restore is reconstructed at startup. Independent SQL writers and other replicas
need their own wake integration; process-local hints do not cover them.

Existing manual health checks and catalog operations can overlap. This migration
does not introduce a credential-version CAS or change provider failure policy.
The scheduled worker itself is non-overlapping and rechecks the current row before
probing. A naive `updatedAt` CAS would reject a health check's own catalog writes.
Voice remains eligible under the old sweep's policy even though its generic
health probe can report an unsupported transport. Changing that policy belongs
to the voice owner, separately from this scheduling migration.

The Cloud sleep-safety proof is unchanged. An in-process deadline cannot wake
stopped compute; unsupported external wake obligations remain blockers.

## Verification in progress

The original startup regression showed repeated idle health sweeps. It now proves
one scheduled-worker reconstruction and no health inventory work from aggregate
ticks. Seventeen real-PostgreSQL lifecycle tests pass: empty/configured quiet,
excluded transports, first writes, nested commit/rollback, drain/resume, saved
observations, restart, page progress, real API activation/disable/archive,
company failure isolation, feature toggles, company deletion, voice activation,
concurrent producer writes, failed persistence, and admitted shutdown.

The first consumer run passed 514 cases and failed a rollback fault fixture tied
to transaction call order. The fixture now rejects the actual restoration update
with a PostgreSQL trigger. All 515 startup/tool-access cases pass afterward.
Another 163 gateway/settings cases pass. Server typechecking passes after fixing
two mutable values captured by transaction callbacks. Additional producer/chat
consumers, query-plan inspection, build, and remote review/checks remain pending.

An initial additional-consumer command ran before its external-database fixture
patch applied: embedded PostgreSQL failed to start and 72 tests were skipped.
That run is not passing evidence. The corrected run uses validated disposable
PostgreSQL databases; results will be recorded before PR acceptance.

The corrected producer run first passed all 44 email cases but contaminated the
other suites with shared fixture rows, causing foreign-key cleanup failures.
Separate freshly initialized databases preserve each suite's original isolation;
all 72 access/email/GitHub/smoke-lab cases then pass. Three selected chat credential
and pause cases pass; 1,414 deselected cases are not counted as passing coverage.
The producer mapping/voice wake contract is covered by the health lifecycle test.
Server build passes. The scoped inventory SQL with 40,000 archived and 10 active
rows uses `tool_connections_company_enabled_idx`, 13 shared buffer hits, and
0.022 ms execution; the diagnostic data was rolled back. No new index is needed
for this observed query. The local passing selection totals 770 distinct tests.
Full workspace and remote acceptance gates remain required.

Review repair: a controlled 503 probe persisted its failed health observation,
but the warning regression failed before the fix. Scheduled probe failures now
log company/connection identifiers and a fixed message, without provider prose.
The saved 15-minute deadline still controls the next check. All 64 health/startup
cases and server typechecking pass after repair; total selected coverage is now
771 unique tests. Fresh remote gates are required for this repair.


Review follow-up: fair round-robin company batching replaces the global oldest-25
selection. The two-company regression failed before the repair; 19 health-worker
and three shared batching cases pass afterward. Each probe's pre/post eligibility
query already includes the connection ID, so those indexed current-state checks
remain. A scheduled observation still emits the normal transaction signal and
now refreshes only that connection following the security repair below. This
preserves uncertainty and concurrent-writer recovery without a silent-write exception.

The real-service producer suite now proves AgentMail activation triggers its first
health probe, pause cancels the next deadline, GitHub installation events update
the cached deadline, and member removal cancels a personal connection's deadline.
The GitHub newer-access branch retains its old health deadline, as intended.
These tests use the actual coordinator, transaction notifications, schedule query,
and service mutations; AgentMail also runs the actual health service against its
controlled provider. Subsequent idle windows assert no SQL.

The first run exposed two incorrect fixture expectations: AgentMail setup leaves
healthCheckedAt null until its first probe, and a stale GitHub installation event
does not overwrite a newer access refresh. The tests now preserve those policies.
A targeted rerun reused AgentMail's retained fixture user and failed setup with a
duplicate key; a fresh disposable database fixes that isolation issue without
changing application behavior or weakening assertions. All 66 access/email/GitHub
cases pass on the final run. Server typecheck/build pass. Cumulative selected
coverage is 776 unique tests; full-suite and fresh remote review/checks remain
acceptance gates. No whole-instance sleep or provider suspension is claimed.


The Discord child review also exposed fixed-batch throughput as a risk for health.
A probe-timestamp regression measured a 30.7-second gap before the 26th already
owed check. The worker now schedules a one-second continuation only when the due
selection exceeds its bounded batch. Failed work retains backoff; an empty or
fully future-dated inventory has no continuation. This is scheduling concrete
backlog, not a periodic idle scan. The initial deadline-only assertion passed
incorrectly because a pending transaction notification temporarily reported an
immediate coordinator wake; acceptance measures actual probe timestamps instead.


## Security review: bounded refresh scope

Security review identified amplification in the original company hints. Five
separate real `updateConnection` calls in a company with 205 eligible connections
returned 1,025 inventory rows. A regression reproduced that result. The repaired
producer contract returns exactly five rows across those updates. Saved probe
observations use the same single-connection scope, so draining a due backlog no
longer reloads its whole company after each batch.

The typed hint accepts an existing connection row (only company and connection
IDs are encoded), or an explicit application target. Company/global scopes remain
for company deletion and administrative feature changes. Smoke Lab allocates a
new connection ID before its insert so the transaction intent is registered before
the write. No schema, outer transaction ownership, or provider policy changes.
Application eligibility changes retain their own scoped refresh. Single-connection
refreshes remove an old cached deadline even when the row was deleted, disabled,
or moved to an excluded application; unrelated deadlines remain intact.

Inventory queries use 100-row UUID keyset pages. A 205-row regression initially
observed one unbounded query and now requires three pages with all 205 distinct
IDs retained. Cancellation is checked between pages. Results replace a scope only
after its complete load succeeds; failed loads retain recovery and other scopes
can proceed. Malformed hint shapes request full reconstruction instead of dropping
later scopes.

The first amplification fixture lacked its required remote endpoint and failed
validation before reaching its assertion. After adding a controlled endpoint
lookup, the baseline reproduced 1,025 versus five. The first typecheck found a
partial access-service projection without companyId; the target now supplies the
already-owned companyId explicitly. These failures are retained as evidence, not
counted as passes. Final verification and remote review are recorded below.


Final scoped-refresh verification: 26 health/batching cases, 63 email/access
cases, 56 GitHub/Smoke Lab/startup cases, 469 tool-access cases, and 92 gateway
cases pass (706 targeted tests on this repair). Server typecheck and build pass.
The full local test matrix was not rerun; prior remote Actions passed at
f8ad26f0ff, which still had the security finding. Fresh remote checks/security
review on the repaired head are required and are not inferred from those results.

## GitHub health unit fixture after master integration (October 27)

Fresh CI on #17649 failed server shard 12 in the new GitHub suspended-installation
recovery test. Its minimal database fake only implemented reads and updates;
health changes now go through the existing transactional write owner. The test
therefore received `db.transaction is not a function` instead of its expected
422 response and installation settings links. The same failure reproduced on
this owning PR before correction.

The unit test now substitutes the health-write collaborator while preserving
all of its original error, message, connection-health, and URL assertions. This
is the boundary of that error-projection fixture, not a change to production
transactions or a substitute for transactional acceptance. The separate complete
`tool-connection-health-work` suite still uses the real write owner and a fresh
PostgreSQL database. Both complete files pass all 24 cases with no skips on owner
source based on `d2068f59a30f6f33b4543a79b539016294cbfe15`.

The failed CI job is
[server shard 12](https://github.com/paperclipai/paperclip/actions/runs/40470614670/job/122077293740).
Fresh remote CI is still required on the follow-up head. Other review findings
on health scheduling remain separate; this fixture correction does not resolve
them or claim deployed sleep.

## Acceptance follow-up after the plugin parent merged (October 27)

PR #17518 is merged as `96727b3cfefb61f85ffe1fbc29a9b6dd6837efe8`.
The health branch includes that actual master through a normal merge. Its 47
health-owned paths are the only differences from that master; it changes no
database files. All 18 preceding sleep PRs are merged. Older statements above
about an unmerged stack and prior acceptance describe their recorded revisions.

A second security finding exposed a remaining application-wide invalidation in
example installation and Smoke Lab. With 205 unrelated eligible connections
under an installed application, five actual repeated installs loaded 1,035 rows
for the example and 1,045 rows for Smoke Lab. These are failing row-count
regressions, separate from the earlier individual-connection amplification.
Metadata-only upserts now retain connection-scoped hints from the actual fixture
writes. Application-wide refresh occurs only when its type changes eligibility.
The same tests restore an excluded application through each real installer and
require all 205 unrelated connection IDs to return to the live schedule.

The upsert reads the current type under its owning transaction's PostgreSQL
`FOR NO KEY UPDATE` lock. This matches the non-key update and permits foreign-key
key-share locks. An earlier lookup cannot establish the current type after a
concurrent writer commits. A real lock-wait test confirms that the installer
notifies the restored application after the other writer releases its lock.
Replacing that current-type comparison with the earlier lookup reproduces a
missing settled hint; the original source is restored after that mutation check.
No provider call moves inside this transaction.

The latest Greptile finding also reproduced: while 60 healthy due connections
drained in three bounded batches, a different company's failing inventory read
ran three times instead of once. Failed inventory scopes now retain their own
30-second retry deadline. Healthy backlog continuations cannot shorten it, and
cached connections in an unavailable scope cannot be probed from stale data.
The regression requires all healthy checks to continue promptly, failed reads
to remain at least 30 seconds apart, eventual recovery, and SQL quiet after
settlement. Successful global reconstruction clears the covered failed scopes.
This changes only the health owner; coordinator and database contracts stay intact.

The six external-database producer suites now apply pending fixture migrations
before creating their client. All six pass against separate, initially empty
PostgreSQL 17 databases on source `acbf262843`: 26 health, 469 tool-access,
18 access, 45 email, four GitHub-event, and seven Smoke Lab cases (569 total).
Server typecheck and build also pass on that source. The subsequent health
retry repair has a separate failing baseline and passing focused test; its
complete consumer and type/build verification is recorded with publication.
These source checks do not establish deployed suspension, Cloud wake coverage,
a full local repository-suite pass, or savings. Fresh current-head reviews and
all CI gates remain mandatory before merge.

Final retry-repair acceptance: all four complete health, company-batching,
GitHub health recovery, and server startup suites pass 80 cases. Together with
the five complete producer suites above, this covers 623 distinct cases; the
26 earlier health cases are included in that total rather than added again.
Server typecheck and build pass with the retry repair. Startup tests emit the
existing SIGINT/SIGTERM listener-count warnings; no assertion failed. The fresh
fixture results and these final worker results have different source scopes as
stated above. The failed amplification, stale-type mutation, and retry baselines
are retained; a passing acceptance does not erase those failures.
