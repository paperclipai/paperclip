# Voice maintenance sleep migration audit

Baseline: receiver parent #17572, head 643f4766227e15006b684d2cc7bea7ddd5cc2147.
Branch: codex/sleep-21-voice-session-recovery.
Status: implementation and local integration/lifecycle verification in progress; unpublished.

## Separate the reasons before changing the timer

The app invokes `voice.reconcile()` from the remaining one-second chat lane.
The public service is created through `chat-channels/speko/runtime.ts`; the
implementation is `voice/voice-session-service.ts`. Its reconcile method hides
five distinct obligations. Each needs its own PR, preserving the others until
its producer and deadline contracts are implemented.

| Slice | Existing behavior | Proposed owner and trigger |
| --- | --- | --- |
| Live session recovery (this branch) | Reads experimental settings, scans live sessions for expiry, ending, disabled endpoints/connections, generation mismatch and 30-second active-state checks | Voice session owner; committed lifecycle/authorization changes plus real expiry, cleanup and active-call inspection deadlines |
| Reply push | `pushVoiceReplies` scans for provider delivery work | Existing reply/session records, committed source changes, pending provider delivery and claim/retry deadlines |
| Inbound admission expiry and provider cleanup | Scans guest/approval/denied/expired calls past expiresAt, inspects/ends exact provider sessions | Inbound owner; admission/lifecycle/decision changes, saved expiry and unresolved end retries |
| Inbound history retention | Deletes denied/expired/ended rows without sessionId or intakeIssueId once both expiresAt and updatedAt are seven days old | Retention owner; deadline max(expiresAt, updatedAt) + seven days, mutation invalidation and startup reconstruction |
| Call reports | Fetches reports for terminal sessions with provider IDs within 24 hours of endedAt; follows nextCheckAt backoff | Report owner; terminal/lifecycle/report events and saved report recheck deadlines, preserving late recording/transcript behavior |

Removing one invocation of the outer reconcile method would drop several owners.
First expose the live-session operation independently, register it with the
existing coordinator, and leave the other four calls in their existing lane.
The outer wrapper can disappear only after the remaining owners migrate.

## Live-session source of truth and invariants

Existing chat_voice_sessions, chat_endpoints, tool_connections, access/bindings,
and instance settings define eligibility and current authority. No new table is
needed. Current live states are reserved, creating, creation_unknown, connecting,
active and ending. Terminal states are ended, failed and expired.

The current pass uses 25 oldest updatedAt rows. A session qualifies when expired,
ending, disabled, generation-mismatched, or when a connecting/active session has
not been inspected for 30 seconds. Active-session checks validate current task,
caller and guest authority, then inspect the exact saved providerSessionId to
recover a hangup without a final browser callback. A live call is concrete work;
its bounded provider-state inspection is not empty-instance discovery.

Unknown creation remains reserved until expiresAt plus two minutes of teardown
grace. The provider maximum duration is the final bound. Never replay creation
because its response was lost. Ending retains exact provider cleanup debt until
termination is confirmed. An error records cleanup_pending and updatedAt.
Preserve these business boundaries and distinguish a database error from a real
revocation before changing recovery behavior.

An inactive instance with no live sessions must stop this owner's settings and
session queries after reconstruction. Retained terminal sessions alone must not
create a live-session deadline. Report work for those rows belongs to its own
slice and stays active under its existing contract for now.

## Required producer audit

- voice-session-store.reserve, including inbound and guest binding paths;
- service start claim, successful provider binding, unknown creation, failed
  creation, concurrent end, and failure to persist provider identity;
- closeProvider and user end; inspect and tool callbacks that change session state;
- inbound lifecycle, guest intake, approval/denial and end paths that write sessions;
- signed lifecycle callbacks and report callbacks (separate saved report debt);
- endpoint/connection pause, removal, generation or credential changes;
- feature disable, membership/access revocation, task reassignment, binding and
  environment changes used by authorizeSession;
- restart/resume and the supported single active writer contract.

Use existing transaction ownership. Add intent before the write; transaction
outcome uncertainty remains the shared database layer's responsibility. Prefer
session/endpoint/company scopes rather than refreshing all sessions per mutation.
Authorization stays with the voice store; provider requests stay with the Speko
provider. Shared scheduling consumes normalized work identities and deadlines.

## Required proof

Reproduce recurring SQL in no-session and retained-terminal-history states before
removal. Test first real session creation after quiet; nested transaction commit
and rollback; uncertain creation without duplicate provider calls; expiry/grace;
ending cleanup failure and retry; active hangup recovery; revoked membership,
changed task binding and feature disable; guest isolation; multiple-company
fairness and backlog; failed scoped reads; mutation during sweep; drain/resume;
shutdown joining admitted provider work. Keep all four adjacent obligations and
their existing tests running. Inspect `voice-session-store.integration.test.ts`
and current producer fixtures before inventing new test contracts.

The receiver parent has 218 selected passing tests, workspace typecheck/build,
and is published/attached. CI run 40173962833 is live on its exact head; Greptile,
security and Paperclip review are pending. This is not stack completion or merge
permission. The full original ledger, #17490 failure and final master
reconciliation remain required.


## Initial implementation checkpoint

Live-session recovery now has a voice-owned paged deadline reader and a scoped
coordinator worker. The periodic wrapper retains reply, inbound, and report
maintenance. Session writes signal their existing transactions; standalone service
updates use one small transaction helper. Configuration, feature-disable and
voice tool/access removal paths signal relevant scopes. Active sessions retain
30-second inspection, unknown creation retains the saved expiry plus two-minute
grace, and no call-creation action exists in recovery. Authority lookup failures
retry instead of treating an unavailable database as confirmed revocation.

Four initial actual-service cases pass: first start after quiet and retirement
on missed hangup, membership revocation, and feature disable; unknown creation
expires at its saved grace deadline without another provider call. Server types
pass after fixing the database projection of the internal runtime generation.
The startup wiring regression failed before removal. This is a checkpoint only:
full producer, lifecycle, race, backlog, and consumer evidence is still required.

Receiver #17572 has Greptile 5/5 and no failed checks, but Paperclip Review 4/5
requests suppressing rediscovery after discovery-initiated stops. Its optional
full-refresh coalescing observation will also be addressed in the owning parent
before this branch is published. Preserve all unfinished voice changes in this
commit while repairing that parent.


## Expanded lifecycle checkpoint

Receiver review repairs are published in #17572 at `1604a9fcba` and merged into
this child. The receiver CI run 40175242445 remains live, with no failing checks
at inspection. The voice worker now also coalesces pending scopes under a full
refresh and retains its backoff when narrower signals arrive.

The complete existing voice session integration suite passes all 93 tests on a
fresh disposable PostgreSQL database. This includes the four initial real-service
producer cases and the adjacent reply, inbound, callback and report consumers.
Eight new recovery-owner integration tests pass: configured terminal history,
outer rollback/commit, first write during drain, transient authority failure
without ending a valid call, restart with the same saved deadline, mutation during
full refresh, a 105-session paged backlog with one failed provider, and shutdown
joining admitted inspection. Their provider operations are controlled; real
service authorization/producer coverage remains in the 93-case suite.

The 16 startup wiring tests also pass. Initial new-suite failures were fixture
errors (missing channel purpose) and a silence assertion starting before the
committed cleanup_pending refresh had settled. Both were corrected; the final
retry check proves no SQL during the actual backoff. No production failure was
concealed or treated as a successful run.

Outstanding before publication: complete producer/authorization-change audit,
current-state races, cross-company fairness and failed-scope coverage, affected
shared producer consumers, full workspace verification and remote gates. The
other four voice duties and every remaining original stack item remain required.


## Producer and race audit completion

See [the live-session contract](../idle-voice-session-recovery.md) for the complete
producer mapping, existing transaction ownership and retained active authorization
inspection contract. All production session writers are covered. Phone preferences,
membership and task authority remain checked on the existing active-call deadline
and on use; no new recurring empty inventory scan replaces their absence of signals.

A late provider binding between grace-period discovery and expiration was reproduced:
the previous update marked a connecting call expired despite its new provider ID.
The expiration update now requires provider identity to remain absent. The regression
proves the known call stays live for exact-provider cleanup. All 11 recovery lifecycle
cases pass, including company fairness and failed-scope fencing.

Expanded real-service coverage passes for endpoint pause, generic voice connection
disable, task reassignment and signed guest lifecycle settlement. Shared consumer
verification passes 469 tool-access, 18 access-removal, and 207 settings/provider
cases. Workspace typechecking passes. A fresh final voice/receiver/startup selection
and the full local test command are running; build/publication/remote gates remain.
No full local matrix result is claimed from targeted tests. Initial fixture errors
and the reproduced provider-binding race remain recorded above and in test logs.

## Voice session inventory amplification repair, October 27

The voice branch normally integrates receiver parent #17572 at `841d451164`
through `f8d7dd2d14`. The initial single-duty scope is 21 files, with no database
changes. The health-observation routing repair adds one related production path,
`tool-access/catalog/health.ts`, because an observation must not claim that voice
configuration changed. The existing routing helper owns receiver and command
fanout; the voice service owns eligibility and deadline comparison.

A real-API regression with 205 future live calls reproduced 1,230 selected call
rows across five metadata updates and one health observation. The row count
measures executed database selects, rather than timer calls or helper invocations.
After repair these operations read zero call rows, preserve the exact saved next
deadline, and issue no voice wake for the health-only operation. A separate real
SDK health case confirms receiver and command topics still settle after commit.

The background path now uses one inventory page of at most 100 lean call headers
per refresh. Parent state is probed separately, in bounded pages, and unchanged
state keeps existing deadlines. Unknown or genuinely changed parent state has a
bounded reconstruction. Foreground reconciliation keeps its complete scan API.
The worker retains a generation and seen IDs across pages, processes at most 25
scopes per pass, rechecks call state before provider effects, and preserves failed
scope/call backoff. It resets partial state when the same service starts a new
worker. No per-worker table, migration, extra scheduler, or route recovery wrapper
is introduced.

Real database regressions cover all 205 deadlines after paging and partial-scan
restart, a new session behind the cursor, a feature change between pages, and
connection disablement settling all 205 calls. Guarded production mutations
reproduce the page-size violation, lost global generation (cleanup delayed past
its prompt-recovery assertion), and health-only wake. Each original file is
restored after the mutation. These checks supplement the existing outer-commit,
rollback, drain, current-authority, late-provider-binding and shutdown cases.

Both newly supported external fixture paths skipped migrations. Empty-database
runs failed with missing instance_settings before the worker or provider action.
The worker and complete voice-store fixtures now apply pending migrations before
creating the client and use the shared PostgreSQL bootstrap budget. The initial
amplification fixture also omitted its required Speko provider config, then used
the wrong public health method name; those failures preceded the actual 1,230-row
baseline. Initial quiet checks counted the observer's previous calls; measurement
is now stopped before an independent quiet-window spy is created. The quiet
assertion itself is unchanged. The first typecheck exposed timing-only rows being
used for full provider operations; the timing-header type stays separate from full
rows at that operation boundary. All failures remain recorded as such.

Current targeted acceptance passes 725 distinct cases: 18 voice lifecycle, 94
shared coordinator/batching/startup/hostname, 97 complete voice-store, 469
tool-access, and 47 health/receiver cases. Production typecheck and server build
pass. The 18 lifecycle cases replace the earlier 16-case result; these counts do
not add repeated runs. Full suites ran unless a narrower selection is explicitly
named above. No full local repository matrix, actual host suspension, Cloud wake,
multi-writer support, or savings is inferred from this worker migration. The original remaining-duty inventory stays
in scope. Current exact-head reviews, security, CI, and parent landing are still
required before merging #17576.


## Landed-foundation acceptance, October 27

The voice repair now integrates receiver parent `6e88ca0201`, including Discord
`547fdf2139` and master `f8563d2507`. Exact-patch comparison preserves the repaired
22-file scope and master's shared task-drain and native-checkpoint queue names.
No database file is part of this slice.

All 725 distinct targeted cases pass again: 112 complete voice/shared/startup
cases, 97 complete voice-store cases, 469 complete tool-access cases, and 47
complete health/receiver cases. Server production typecheck and build pass.
Voice worker/store and health/receiver fixtures use separate initially empty
self-migrating databases. Tool access uses a separate migrated clone. One initial
tool-access invocation supplied the generic fixture variable instead of the
suite-specific variable: 23 cases passed and 446 skipped. It was not a complete
suite result or an assertion failure. The corrected invocation executes and
passes all 469. Tests are not counted twice. Expected controlled failures and
listener warnings remain in logs. Only documentation changes follow these checks.
Fresh current-head reviews, CI and parent landing remain required. No full local
matrix, provider acceptance, external wake or deployed sleep result is claimed.


## Trusted-policy checkout compatibility, October 27

CI run `40632057899` on `712f3862b5` failed policy because the trusted workflow
had acquired `scripts/check-query-error-rendering.mjs` from newer master, while
the checked-out PR head lacked that script. The build job separately received
a runner shutdown signal during runtime bundling, then reported cancellation.
The underlying shutdown cause is not established. The E2E aggregate reports
`E2E_SHARDS_RESULT=success` but fails on `POLICY_RESULT=failure`; verification
also fails on policy and build. Those four failed gates are not passing results.

A normal merge of receiver `ab39569250` brings the landed UI and policy tooling
into the checkout. Every server/package production and test file remains
byte-identical to the 725-case tested `712f3862b5` source. The policy checker now
executes successfully, and its complete Node test file passes locally. No sleep
implementation, test assertion or workflow gate is weakened. Fresh CI must prove
the full build and aggregate gates; the interrupted build is not relabeled as a
pass. Fresh Ponytail and Greptile acceptance still precede any merge.


## Wildcard failure and deterministic generation acceptance, October 28

Current-head CI `40633667141` fails server shard 1 at the feature-change test's
34,050 ms result against its 25,000 ms bound; verification fails as an aggregate.
This is an actual required assertion failure, distinct from the older interrupted
build and missing policy script. The old test mixed automatically advancing fake
time with real database latency. It now disables automatic clock advancement,
drives 20 explicit scheduler turns, waits for each pass without advancing the
clock, and requires every invalidated call to close before the unrelated periodic
authority deadline. Removing generation replay still fails with missing closures.
The test no longer benchmarks host/database speed or raises its business bound.

A real committed-session regression also reproduces wildcard starvation: while
one broad reconstruction backs off, a newly ending exact call is not closed.
The worker now retains the broad retry but considers ready exact hints and cached
due calls independently. Each due call still reloads state and authorization in
its owning check before effects. Failed exact scopes retain their own fence;
the existing stale-cache failure regression still passes. Removing wildcard
isolation fails the new exact-call assertion. Broad reconstruction becomes quiet
after its successful retry, with no continuing SQL afterward.

The full-row execution lookup and lean inventory lookup now share the live-state,
scope and cursor predicate. Their projections remain intentionally different.
An initial edit script rejected the header cursor name before applying the timing
and predicate changes; the intermediate 19-case result covers only the earlier
worker repair. It is not the final repair evidence. The corrected source passes
all 19 lifecycle cases and 191 complete voice-store/shared/startup cases: 210
distinct targeted cases. Production server typecheck and build pass. Both guarded
regressions fail at their intended effect assertion and restore source afterward.
The fresh voice-store database self-migrates. Existing controlled failure logs
and signal-listener warnings remain recorded. The older 725-case acceptance
belongs to its stated revision and is not added to this count. Fresh current-head
reviews and all CI remain required before merging after receiver discovery.
