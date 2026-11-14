# Inbound voice admission cleanup sleep audit

Original baseline: voice reply PR #17578, head 439d0a86eb75c129c30742a8cc24bf18e2a6ebf3.
Current integrated parent: d2c0a7de8c3e9cac8382b1268f3f5d883a2067b3.
Branch: codex/sleep-23-voice-inbound-cleanup.
Status: cleanup implementation and local verification complete; publication and remote acceptance pending.

## One reason in this slice

Remove recurring discovery of expired inbound admissions and unfinished provider
termination. Keep inbound history retention and call reports as separate PRs.
The current `voiceInboundService.reconcile` combines a seven-day delete with a
25-row expiry/provider scan. `voiceSessionService.reconcileMaintenance` invokes
it from the remaining one-second chat lane.

Existing `chat_voice_inbound_calls` rows own admission state, expiresAt, updatedAt,
providerSessionId, generation, credential fingerprint, requested issue, caller,
and optional bound voice session/intake task. Existing voice sessions own the
bound call's execution and current authorization. Do not add a table per timer.
Decide and document the handoff between those existing owners before coding.

## Current behavior and supported producers

- Signed `call.pre_call` inserts an awaiting-approval admission with a two-minute
  expiry, or a guest-intake admission with a ten-minute expiry. The endpoint lock
  serializes the quota check and insertion. Repeated provider identities are
  deduplicated; changed replay content is rejected.
- `pendingTool` can mark an expired admission as expired. Guest submit_request
  creates a low-trust task and active voice session, then saves the session/task
  binding in the same transaction. These writes must wake the appropriate owner.
- `decide` locks the admission and validates current caller, endpoint, credential,
  approval code, expiry, and task authority. It writes approving or denied/ended.
  Provider inspection and session start occur afterward. Final approved binding
  is currently a standalone update guarded only by state=approving.
- Signed lifecycle/report callbacks lock admission before session and mark the
  admission ended. Preserve that order and the callback receipt's replay fence.
- The expiry sweep scans guest_intake, awaiting_approval, approving, denied, and
  expired rows only once their expiresAt is past. It inspects the exact saved
  provider call, marks ended if inspection confirms termination, otherwise marks
  expired and requests termination. Errors only update updatedAt.
- No production admission writers were found outside voice-inbound-service.ts.
  Session handoff/approval recovery must also inspect voice-session-store.reserve.

## Correctness questions that the migration must resolve

1. **Discovery is not an execution claim.** A row read by cleanup can change before
   provider I/O. Recheck/claim current due state under the owning row lock. Never
   overwrite a newer approved or terminal state from a stale candidate snapshot.
2. **Approval handoff has a crash window.** Inbound start commits an authorized
   session with the existing provider ID and returns without creating a new call.
   The admission's final approved update follows in a different transaction.
   Expiry or a crash can occur between these writes. Determine whether existing
   binding evidence should complete handoff or retain cleanup; do not end a valid
   handed-off call based on an older approving snapshot. Test the exact race.
3. **Termination requested is not termination confirmed.** Speko endSession returns
   confirmed=false for status=ending and true only for already_ended. Keep cleanup
   debt until an inspect/callback/end receipt establishes termination. Never create
   or redial a provider call in recovery.
4. **Guest denial currently writes ended before provider confirmation.** Without a
   bound session, a failed end request can lose its cleanup obligation. With a
   session, live-session recovery also owns ending. Preserve one explicit owner
   for unfinished termination; do not treat a terminal UI label as physical proof.
5. **Bound guest calls have two current scanners.** Admission expiry and live-session
   recovery can inspect/end the same exact call. Define the handoff and admission
   settlement contract so a scheduler migration does not create two uncoordinated
   provider workers for one resource.
6. **Retention currently precedes cleanup.** The seven-day delete can remove denied
   or expired rows with no session/task binding before provider termination is
   proved. Keep history retention separate, but do not allow it to erase newly
   explicit unfinished cleanup debt. Record any required narrow predicate change
   with this slice and keep the retention scheduling migration in its own PR.
7. **Configuration and credentials.** Cleanup must remain possible after feature
   disable and endpoint/credential changes. Do not use a replacement credential
   to act on an unrelated provider call. Read the existing provider/account
   identity and deletion contracts before selecting recovery scope.

## Intended scheduler contract

The inbound owner exposes normalized identities and actual deadlines to the
existing delivery coordinator. The initial deadline comes from saved admission
expiry; explicit rejection requests immediate cleanup through the same owner.
Unconfirmed termination or errors retain a bounded retry. Completed history and
no admissions leave no cleanup deadline. Startup reconstructs saved obligations.
Notifications precede writes in existing transaction ownership and cover all
producer paths above. No provider request is made inside a SQL transaction.

Preserve scope coalescing, per-obligation failure isolation, fair bounded batches,
startup paging, drain/resume, concurrent changes during a sweep, and shutdown
joining in-flight work. Keep public/manual reconciliation compatible while
separating the retention operation from the scheduled cleanup operation.

## Required proof

- No configuration, configured idle, and confirmed terminal history become quiet.
- Real signed pre-call after quiet registers its original expiry.
- First guest intake, approval/denial, pending-tool expiry, and lifecycle callbacks
  signal their existing transactions; outer rollback and commit behave correctly.
- Approval completes during cleanup discovery without stale termination or state
  overwrite. A crash between session binding and final approval remains recoverable.
- End receipts with confirmed=false, provider failure, missing callbacks, and restart
  retain the exact-call obligation without redial or silent deletion.
- Bound guest termination has one explicit owner and settles admission history.
- Retention cannot erase unfinished provider cleanup.
- Backlog, failure isolation, drain/resume, and shutdown behave as claimed.
- Existing full voice, reply, and call-report cases continue to pass. Use separate
  PostgreSQL databases for suites that retain fixtures and global-idle suites.

## Parent and full-stack obligations

#17578 is published and attached. Local evidence covers 786 selected tests,
workspace typecheck and build. CI run 40179014816 and PR review 40179014437 were
live at publication; no check failure was present at the latest inspection.
Latest-head checks, Greptile score and review findings still require acceptance.
No stack PR is authorized for merge by the active goal. The remaining original
ledger, older #17490 failure, and final master reconciliation remain required.


## Atomic handoff checkpoint

The parent reply review repairs are published at `90caaf3fa929141a13cc17f54d6be846d6e93217`
and merged into this branch. Both voice workers now share the scoped deadline
mechanism; the next inbound worker should reuse it rather than copy a third loop.
Parent CI run 40180022971 is live; no failure was present at the latest inspection.
Its old 439d head passed CI/Greptile, but fresh-head acceptance remains required.

A real-service regression paused after inbound session reservation committed but
before its result reached `decide`, then advanced beyond the admission expiry.
The original sweep called provider termination on that authorized session. This
failed in `/tmp/sleep23-handoff-before.log`. The reservation now writes admission
state=approved and sessionId in the same transaction as insertion or guest
promotion. `decide` reads that binding after start, rather than creating it in a
second transaction. No provider call is moved inside the transaction.

Both ordinary admission and guest-to-private promotion are covered. All 110 voice
integration cases pass on a fresh PostgreSQL database, and server typechecking
passes. An initial full run passed 109 and failed the guest test's assertion of
no termination calls globally: advancing ten minutes also expired unrelated
retained fixture admissions. The assertion now checks the exact provider call
whose handoff is under test, preserving legitimate unrelated cleanup. The full
rerun passes. No broad workspace/remote verification is claimed for this child.

This is a prerequisite, not the complete cleanup migration. Still required:
- Recheck and claim a discovered admission under its row lock before provider I/O;
  atomic new handoff alone does not protect a stale discovery snapshot.
- Reconstruct legacy interrupted handoffs written before this atomic change.
- Define one termination owner for bound guest sessions, and settlement signals.
- Preserve unconfirmed/failed termination debt and credential/account isolation.
- Prevent history retention from deleting unfinished cleanup.
- Wire all producer notifications, actual deadlines, scoped worker registration,
  lifecycle tests and remove only the cleanup portion of periodic reconciliation.
- Keep history retention and call reports as separate forthcoming PRs.


## Cleanup implementation and local acceptance

The worker is now registered in app startup. `reconcileMaintenance` no longer
runs inbound cleanup; it retains history pruning and reports for separate PRs.
See [the implementation contract](../idle-voice-inbound-cleanup.md) for the complete
producer table, ownership, credential rotation and remaining host-sleep limits.

The previous checkpoint's remaining implementation items are now handled:
locked current-state claims; matching legacy handoff repair; bound-session cleanup
ownership; durable termination confirmation/retry; account isolation; retention
protection; notifications and shared scheduler registration. A company-delete
participant check also prevents cascades from erasing unfinished cleanup and locks
endpoints to serialize against signed admission ingress.

The existing admission row needs separate authorization and cleanup state. Three
nullable fields record confirmation, retry and the signed provider account.
Migration 0392_lying_trish_tilby.sql was generated with `pnpm db:generate`, made
idempotent, and given a concurrent partial index. It backfills only provable old
termination. The initial two-field unpublished generation was replaced by this
single migration after account-rotation analysis. Five newest snapshots remain;
the generated deletion of 0383 is intentional.

Local evidence:
- `voice-inbound-cleanup.test.ts`: 13 tests pass using a separate PostgreSQL DB.
  Includes migration backfill/replay, company deletion and shutdown joining.
- Full voice integration and app wiring: 129 tests pass on a fresh DB (113 voice,
  16 app wiring). Signed ingress wakes an idle worker; a feature-disabled instance
  retains an unconfirmed end; a replacement account cannot issue cleanup; a key
  for the saved account can. Rejection failure survives history pruning.
- Company deletion and server startup consumers: 52 tests pass on their isolated DB.
- Parent live-session recovery: 11 tests pass on its separate DB.
- Total selected coverage: 205 passing cases across these nonoverlapping suites.
- `pnpm -r typecheck` and `pnpm build` pass on the current implementation.
- Migration safety/numbering checks passed for the initial generated migration;
  rerun on the final regenerated name before publication. Initial application and
  replay succeeded on real PostgreSQL. Final generation also applied cleanly;
  its backfill is exercised twice by the lifecycle test.

Earlier handoff regression and fixture assertion failures remain recorded above.
The repository-wide local test command still has the previously recorded embedded
PostgreSQL host limitation; this is not a claim that that command completed. Fresh
remote CI and review are required before accepting the PR.

Parent #17578 at 90caaf3fa9 has all checks terminal with no failures and Greptile
5/5 on that exact head. Both requested findings are fixed/resolved. The fresh
Paperclip reviewer stopped before completing its turn; do not report a new 5/5
assessment from that reviewer. The full original migration ledger, #17490 failure,
and final stack/master reconciliation remain outstanding.

## Migration runner repair after first CI

The initial head 4b4bf2d8af failed database setup. Greptile identified that the
concurrent 0388 index was missing from the migration runner's top-level set.
CI production bundle boot and Runner static integration logs independently show
`CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. The earlier
SQL application/replay evidence bypassed this application runner and did not
establish that fresh setup or upgrades could work.

Added a real-PostgreSQL migration regression that creates a disposable database,
boots all migrations through `applyPendingMigrations`, then simulates an invalid
concurrent index and replays through two concurrent application migrators. It
failed with the exact transaction error before the fix. Registering 0388 in the
existing top-level set makes fresh boot, invalid-index repair, single journal
record, and repeat replay pass. No migration SQL/history was rewritten.
Database typecheck and migration numbering/safety checks also pass. Local logs:
`/tmp/sleep23-migrator-before.log`, `/tmp/sleep23-migrator-after.log`, and
`/tmp/sleep23-migrator-types.log`. Fresh remote checks remain required; the
original CI failure is not classified as a flake.

## Denial request latency review repair

Review finding 4370459974 correctly identified that denial awaited account
verification, provider inspection and endSession, despite already committing the
rejection and its cleanup notification. The request now returns the saved denial;
the registered worker owns physical termination and persists its retry. No detached
promise or second dispatch path is added. Per-attempt account verification stays
with the provider boundary, protecting rotated credentials from a different
account. This patch does not cache provider authority indefinitely.

A new real-producer regression holds verifyAgent unresolved, proves the committed
denial returns, checks that cleanup is still unconfirmed with a saved retry, then
releases the provider and verifies confirmed termination. It failed before the
fix (`/tmp/sleep23-denial-before.log`) and passed after
(`/tmp/sleep23-denial-after.log`). Existing explicit one-shot tests now invoke
that one-shot path rather than relying on the HTTP decision to do cleanup.
All 130 full voice and app wiring cases pass on a fresh migrated PostgreSQL DB;
production server typecheck passes. Logs: `/tmp/sleep23-denial-acceptance.log`
and `/tmp/sleep23-denial-types.log`.

Finding 4370459800 about company deletion remains separately unresolved. Missing
credentials and account mismatch retain cleanup debt. There is a tested recovery
path through restoring the original account, but a permanently unavailable
provider needs a deliberate ownership/product policy. A retry cap, elapsed time,
or ambiguous 404 is not evidence that a billable call ended. Do not manufacture
cleanup confirmation or silently discard the obligation to unblock deletion.

## Retrying an interrupted approval (2026-10-27)

Older versions could commit a private session or guest promotion before writing
the admission binding. Retrying approval then found the existing session and
returned before the new atomic binding helper ran. The inbound API rejected the
still-approving admission with “This call ended during approval.”

Reservation now validates the inbound admission before the existing-session
return. It uses the existing session authorizer to check current liveness,
expiry, generation, credentials, caller and task access, then checks the exact
admission/session identity before binding in the same transaction. Lock order
remains endpoint, connection, admission, session. A matching provider session ID
alone cannot establish approval. Already approved idempotent calls remain valid
and do not rewrite the binding. Browser and outbound reservation behavior stays
with the existing path. This adds no table, timer or recovery wrapper.

Both direct and promoted-guest retry regressions failed through the real inbound
API before the correction. They now return the same session without starting or
ending another provider call. Ended, expired and token-changed sessions are
rejected without binding. Existing atomic handoff and approval-authority cases
also pass. An initial negative expiry fixture violated the database timestamp
constraint; it was corrected to represent a valid session that has expired.
All 132 cases across the complete voice-session and inbound-cleanup suites pass
on separate fresh databases, and server typechecking passes. Downstream
integration and latest-head CI remain required. The separate company-deletion
cleanup findings are not resolved by this correction.

## Fairness-test clock follow-up (2026-10-27)

CI's backlog test observed two provider failures where it expected one. A controlled
30 ms provider delay reproduced the same failure: the assertion callback advanced
fake time by one second on every retry, in addition to Vitest's ordinary clock
advancement, reaching the failed provider's retry while the original backlog was
still settling through PostgreSQL. Removing that extra clock jump makes the same
controlled case pass. The five-second assertion budget and all product code remain
unchanged. With the temporary provider delay removed, all 13 lifecycle tests pass.
This repairs test clock ownership; it does not weaken provider retries or delivery
fairness. Current-head CI remains required.


## Current-parent acceptance and bounded discovery, October 28

This revision normally merges reply parent `d2c0a7de8c3e9cac8382b1268f3f5d883a2067b3`.
It keeps the parent's paged shared worker, failure isolation, denial restoration,
and publication-scoped reply signals. It adds no new shared scheduler contract.
Domain SQL and termination decisions remain in the inbound voice owner.

The previous cleanup `load` read every page before yielding. An actual 105-row
pending-admission fixture failed its first-pass budget: 105 selected rows instead
of 100. The registered worker now reads one page per scope refresh and returns
`{ rows, complete }` through the parent's existing contract. The explicit one-shot
`load` still returns complete inventory for its foreground callers. Each query is
limited to 100 rows. Refresh cursors advance only after a successful, non-aborted
read. Registration resets them when the same service owner restarts.

The new lifecycle case stops after the first page of 105 future admissions,
re-registers the same service, reconstructs the original expiry, and confirms
all 105 terminations. It checks no SQL or provider calls before the deadline and
no recurring work after settlement. Removing the registration cursor reset fails
at the real restarted read (5 rows instead of 100). These measurements cover
selected rows, not physical PostgreSQL tuple visits or deployed resource cost.

The fresh external fixture first failed because it assumed the admission schema
already existed. It now runs the application migrator before setup, with the
standard embedded-database setup budget. This repairs setup ownership; it does
not skip any cleanup or authority assertions.

### Migration lineage and bounded historical backfill

The parent includes native checkpoint migration 0394. The old, unmerged inbound
0392 migration cannot overwrite that history. The complete parent migration tree
and client were restored, then the existing schema edit was regenerated with
`pnpm db:generate`. The new migration is `0395_married_the_hand.sql`. Its generated
snapshot links the parent snapshot. All 393 historical SQL files and all prior
journal entries are byte-for-byte preserved. The five retained snapshots are
0391 through 0395; the generator's required deletion of 0390 is included.

The nullable columns and partial index remain replayable. The concurrent index
and batch backfill use the application's existing top-level migration protocol.
The original unbounded historical UPDATE is now an indexed keyset scan of at
most 1,000 unconfirmed admission IDs per transaction. It commits each batch.
The first page includes the nil UUID. Each batch retains the original ended-state
and same-company signed termination-evidence predicate. It does not confirm a
call from its label alone. No new queue table or temporary production index is
introduced. The existing activity entity index supports the evidence lookup.

The real migrator regression creates and drops its own database. It covers fresh
migration, invalid concurrent-index repair, two simultaneous replays, and a single
migration receipt. It confirms 1,007 eligible historical rows across multiple
actual transaction IDs, with at most 1,000 updates in one transaction. Denied,
pending, expired, wrong-company and wrong-action evidence stay unconfirmed. A
prior confirmation remains unchanged. Reapplying the receipt adds no updates.
The transaction probe exists only in that disposable test database. Restoring
the old unbounded UPDATE makes the test fail: one transaction instead of at least
two. Snapshot/schema drift acceptance also passes.

### Final local evidence

266 distinct cases pass on this combined source:

- 122 complete voice-session integration cases, using an initially empty test DB.
- 142 cases across nine complete inbound cleanup, voice recovery, company removal,
  shared deadline/coordinator/batching, startup and hostname suites. Cleanup and
  parent recovery use separate initially empty DBs. Inbound cleanup uses its
  dedicated DB after the fresh-setup repair; all 14 lifecycle cases pass.
- Two complete database migration and schema-snapshot cases.

Database and server typechecking and builds pass. Migration numbering/safety
checks pass. The complete voice suite retains both interrupted-approval retry
regressions. Removing only the existing-session binding makes those real API
requests reject instead of resolve; the source was restored after the probe.
The bounded-backfill and restart probes were also restored before final acceptance.

Commands use `pnpm --filter @paperclipai/server exec vitest run` for the ten named
server suites, `pnpm --filter @paperclipai/db exec vitest run` for the two database
cases, and each affected package's `typecheck` and `build` scripts. Evidence logs:
`/tmp/sleep23-final-voice-consumers.log`,
`/tmp/sleep23-final-lifecycle-consumers.log`,
`/tmp/sleep23-current-migration-acceptance.log`, and
`/tmp/sleep23-current-migration-lineage-proof.json`. The three guarded negative
probes have `/tmp/sleep23-*-mutant-red.log` logs. Earlier failed fixture setup,
unbounded inventory, and migration failures remain recorded above and in
`/tmp/sleep23-empty-fixture-red.log` and `/tmp/sleep23-page-budget-red.log`.

The older 130/132/205-case and full-workspace claims apply only to their stated
revisions. No new full local repository suite, live provider, Cloud alarm,
instance/database suspension, or savings claim is made. Latest-head review,
all CI, and parent landing remain required. Company deletion still refuses to
erase unconfirmed cleanup; an audited tombstone or override requires a separate
product and ownership decision.


The module-boundary check passes. The full local Node policy scan reports two
ignored, generated Copilot distribution manifests without an engine field after
the successful package builds. Neither file is tracked or changed by this PR.
The unchanged checker passes on a temporary copy of all its tracked source inputs
(all manifests, Dockerfiles, workflows and required policy fragments). The initial
full-tree failure remains `/tmp/sleep23-final-policy.log`; the source-input check
and its complete input list are `/tmp/sleep23-final-tracked-policy.log` and
`/tmp/sleep23-tracked-policy-proof.json`. No checker, workflow, generated vendor
manifest, or ignore rule was changed to obtain this result. Remote CI remains a
separate gate.

### Legacy terminal admissions missing their session binding — October 28

Ponytail found that an old interrupted approval could leave an admission `ended` or `expired` with a NULL session binding even though a matching provider session exists. The approval-only repair rejected that state forever, leaving cleanup unconfirmed and the company-deletion guard armed. Five new regressions reproduced the ownership conflict on the reviewed source before the repair.

Cleanup now handles confirmed terminal sessions before approval repair. It copies the existing termination timestamp without granting approval or issuing another provider request. Rejected admissions with a matching active inbound session retain their rejection, persist the missing binding and hand the leg to live recovery. Persisting the binding also lets the subsequent session-scoped confirmation wake find the admission. A conflicting existing binding, mode, idempotency key, generation, credential fingerprint or tool-token digest cannot authorize that handoff. Five negative regressions retain cleanup debt and leave the unrelated session active.

The complete cleanup lifecycle suite passes 24 cases, including quiet after settlement, current ownership, rejected-state preservation, matching terminal confirmation and conflicting identities. The complete voice-store integration suite passes 122 cases on a separate initially empty PostgreSQL 17 database. These are 146 distinct current cases; the isolated transcript probe is not counted again. Production server typecheck and build pass. No local full-repository, real provider, Cloud wake or host-suspension claim is made.

Failure history: the first regression invocation set the generic database variable rather than this suite's explicit variable and skipped all cases; it is not a pass. The corrected invocation executed and failed all five intended ownership regressions. The first repaired full cleanup run passed 22 and failed two new test calls to low-level chat deletion because retained voice sessions still have endpoint foreign keys. The tests now exercise the owning cleanup deletion guard (409 before cleanup, settled after confirmation); production deletion ordering is unchanged. Starting another disposable PostgreSQL server failed because the host's semaphore capacity was exhausted. The already-owned PostgreSQL server was verified available and reused with new isolated test databases; no shared IPC resources were removed.

The first complete voice-store run passed 121 cases and timed out at the unchanged 15-second limit in `retains both spoken sides once on the public call task and preserves quarantine`. Its isolated fresh-database probe passed. One subsequent complete run, with builds finished, passed all 122 cases without source or timeout changes. Recorded transform time was 59.09 seconds for the failed full invocation and 34.65 seconds for the passing full invocation; this does not establish the timeout's underlying cause. The earlier timeout remains part of the verification record.

### Landed-parent integration and regenerated migration — October 28

Reply delivery #17578 landed at `e93732c3d49f513845543a6c5d61054950969923`. This normal merge uses actual master `e7ea2e2961863171956e70fb05d3d1f3790f7909`, including the unrelated eval ingestion change. The cleanup owner, voice-store consumer suite and inbound admission schema are byte-identical to tested repair `7e4588fa8c`; the cleanup fixture changes only its migration filename. All unrelated master changes remain present.

Master acquired `0395_tranquil_firestar.sql` while this stack was open. Its SQL, every other landed SQL file and the parent journal prefix are preserved. Running `pnpm db:generate` produced `0396_tan_paladin.sql` and its new snapshot. The previously reviewed idempotent cleanup SQL, concurrent index and bounded historical backfill are retained byte for byte under that generated filename; application registration and both migration fixtures now reference 0396. Exactly snapshots 0392 through 0396 remain, with 0391 pruned by the existing command.

On the combined source, database build and numbering/safety checks pass. The complete 24-case cleanup lifecycle suite passes on a new empty database. The separate database migration integration case passes, including fresh application boot, interrupted concurrent-index repair, serialized replay and the real transaction-bounded backfill. Production server typecheck and build pass again after integration. The prior 122-case voice-store pass is carried only for its unchanged consumer and cleanup source; it was not rerun merely for the new migration filename. These checks do not establish deployed sleep or provider behavior. Fresh published-head CI and reviews remain separate merge gates.

### CI connected-tool rate-limit clock repair — October 28

Published head `48d8356e73` received exact-head Greptile 5/5. Its replacement CI run 40692550133 failed server shard 9/12 (job 122830940435): 1,610 cases passed, two skipped, and the connected MCP policy/approval/rate-limit acceptance case failed with `Expected connected MCP call to be rate limited`. This is a separate real failed check, not the cancelled duplicate workflow run 40692549975 created during retargeting.

The policy owner uses fixed 60-second buckets. The existing acceptance test performed its first and second calls against the real clock, so a legitimate window change could make the second call allowed. A controlled minute rollover between those calls reproduced the exact failing assertion on unchanged production code; the diagnostic source was restored. The CI log does not directly record the two bucket timestamps, so this reproduction establishes the test's unsafe timing assumption without claiming an independently captured clock trace for the CI attempt.

The existing acceptance case now freezes only `Date` around the rate-limit assertions, preserves the second-call 429 and persisted invocation assertions, then advances one window and requires a new call to succeed. A `finally` restores the real clock; network and timeout timers remain real. The complete 92-case gateway acceptance suite passes on a dedicated database. A subsequent whitespace-only correction removed an introduced blank-line indentation and changes no tokens. No production limiter, policy, credential, timeout, workflow or assertion was weakened. This additional existing test fixture is the only new source path outside the cleanup slice and fixes the observed CI gate. Fresh CI and exact-head review are required again after publication.
