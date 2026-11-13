# Voice session recovery without idle discovery

The live-session worker replaces the session-discovery portion of the recurring
voice maintenance call. It uses the existing delivery coordinator, transaction
signals and shared scheduler. It adds no tables or migrations. Reply delivery,
inbound admission cleanup, inbound history retention and call reports are separate
obligations; their existing maintenance remains until their own migrations land.

## Work and deadlines

Existing `chat_voice_sessions` rows are authoritative. Startup reconstructs live
sessions in UUID pages of 100, joined to their same-company endpoint and connection.
Each background refresh reads at most one inventory page. An unfinished pass has
a one-second continuation; it does not create a permanent empty scan. Only timing
and eligibility fields are selected for discovery. The explicit foreground
reconciliation method keeps its complete inventory behavior.
Terminal history does not create a live-session recovery obligation. With no live
sessions, the worker also avoids reading experimental settings after reconstruction.

| State | Next obligation |
| --- | --- |
| No provider identity yet | Existing `expiresAt` plus two minutes of teardown grace; no provider creation replay |
| Known provider, ending or invalidated configuration | Immediate cleanup; a recorded cleanup failure waits 30 seconds |
| Connecting or active call | Earlier of session expiry and `updatedAt + 30 seconds` for current authorization and missed-hangup inspection |
| Other live state with provider identity | Saved session expiry |
| Ended, failed or expired | No live-session work; reports have a separate owner |

Provider maximum duration remains the final bound for uncertain creation. A
late provider response can bind identity while expiry is being considered. The
expiration write requires that provider identity is still absent, so a newly
known call retains exact-call cleanup rather than being marked terminal prematurely.

Each due call is reloaded before execution. The voice store checks current
company, endpoint, credentials, caller, task, guest sandbox and binding authority.
A 403/404 means authority no longer permits the call. A transient lookup error
retains a retry; it does not authorize ending an otherwise valid call. The existing
voice service owns provider inspection and termination, including single-flight
termination and ambiguous-response confirmation. Recovery never creates a call.

## Producers and transaction ownership

| Owner | Changes that wake live-session recovery |
| --- | --- |
| `voice-session-store.ts` | Reservation, guest promotion, connecting-to-active transition and reply cursor writes that change the inspection timestamp |
| `voice-session-service.ts` | Creation claim, binding, known/unknown creation failure, user end, cleanup outcome and foreground inspection |
| `voice-inbound-service.ts` | Guest session creation, guest denial and signed terminal lifecycle callbacks |
| `voice-reply-push.ts` | Confirmed remote end and unknown delivery outcome that changes session state/timestamp |
| Chat configuration helper | Endpoint configuration, pause, reconnect, generation/credential changes, connection hints and company removal |
| Generic tool/access services | Voice connection API mutation, removal and credential revocation during access removal |
| Instance settings | Explicit chat-connector feature enable/disable |

Existing transactions register the awaited signal before the session/configuration
write. Standalone session updates use the small `withVoiceSessionChange` helper.
Provider requests remain outside database transactions. Nested writes retain outer
commit ownership, rollback does not dispatch work, and uncertain commit settlement
stays with the shared database protocol.

Membership changes, task reassignment, phone preferences and other authorization
inputs that do not mutate the session or connection remain checked on the existing
30-second active-call inspection deadline, as well as on use. This slice does not
promise instant cleanup for every authority mutation or add cross-cutting voice
hooks throughout those owners. Session activity that changes `updatedAt` retains
the existing inspection-time semantics. The session expiry is always an upper
bound for authorized active work.

The generic chat connection hint does not always carry a transport. It can cause
a bounded empty voice lookup after a chat configuration write. It does not create
idle polling or a recurring deadline. The shared helper contains only routing;
voice eligibility, authority and provider policy stay with the voice owner.

## Bounded configuration refreshes

The voice owner remembers the endpoint/connection fields that affect its existing
deadline policy: endpoint status, runtime generation, connection enabled state,
connection identity, and the chat feature flag. A broad configuration hint first
reads a bounded page of these parent records. If those facts are unchanged, the
cached call deadlines stay in place and no call inventory is read. Metadata-only
writes do not move business deadlines. An unknown or changed parent requires
bounded reconstruction; a real disablement still settles every affected call.

Only the voice owner interprets these facts. The generic health producer now
sends a health-observation notification through the existing chat routing owner.
It preserves receiver and command signals without generating a voice-configuration
wake. An observation changes neither voice eligibility nor the saved call deadline.
Supported session producers continue to signal their exact session ID.

The worker processes at most 25 dirty scopes and 25 provider checks per pass.
Scope pagination continues without restarting on every newer hint. Failures retain
their backoff and block stale entries in the failed scope. Successful pages can
make progress while the remaining inventory is discovered. The existing
coordinator can use the actual error deadline, including an already-due healthy
backlog, rather than postponing it to an unrelated fallback retry.

## Failure and lifecycle behavior

Refreshes coalesce by scope. Paged reconstruction keeps narrower producer hints,
including a newly committed session behind the UUID cursor. A scope generation
retains configuration changes that arrive between pages. Seen IDs protect
concurrent refresh results; absent cached entries are removed only when the
scope's inventory is complete. A new worker resets partial inventory state before
reconstructing its saved obligations. Changes arriving during refresh remain dirty. Failed refreshes block use of
stale cached entries in that scope. Per-scope and per-call failure backoff starts
at 30 seconds and caps at five minutes. New hints do not erase failure backoff.
Batches rotate across companies, process at most 25 calls, and continue an already
due backlog after one second. A failed provider does not stall independent calls.

Drain and standby retain dirty work without passive SQL. Resume processes that
work, and restart reconstructs deadlines from the rows. Shutdown joins admitted
provider work and removes the coordinator's subscriptions and timers. Retained
terminal history becomes quiet after any already committed hints settle.

Process-local signals support the existing single active database writer and its
shared clients. Independent SQL writers or another replica need an explicit wake
contract. This change neither expands Cloud alarm coverage nor relaxes sleep
eligibility. Active calls and their real deadlines remain obligations; local worker
quiet is not proof of host suspension or fleet savings.

## Verification

The voice integration suite exercises actual service producers, guest intake,
signed callbacks, current authority, unknown creation and adjacent reply/report
behavior. The recovery-owner suite uses real PostgreSQL and controlled provider
operations for outer commit/rollback, drain, restart, scope failure, mutation during
refresh, paging, company fairness, shutdown and the late-provider-binding race.
The latter race failed before the write-time guard and passes afterward.

The dated audit records exact commands, results, initial fixture failures and
remaining acceptance work: [voice migration audit](plans/2026-10-25-voice-maintenance-sleep-audit.md).


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
