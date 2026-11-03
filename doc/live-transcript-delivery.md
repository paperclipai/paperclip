# Interested transcript delivery

The company WebSocket is a presentation channel. Its subscriptions cannot change
runner execution, PRP acknowledgements, recovery checkpoints, accounting, or
canonical run logs. Authorization and redaction still run at delivery, including
after access is revoked. A subscription is never an authorization grant. Full event
rows and log chunks require the current `company_scope:read` permission used by
HTTP transcript reads, as well as access to the run's task. A restricted agent
can still receive authorized lifecycle and lightweight activity notifications.
The check runs for each full delivery on both negotiated and older connections;
changing a trust policy takes effect without reconnecting.

## Additive negotiation

Older clients receive the existing full event stream. New clients first send
`live.hello` with `version: 1` and `capabilities: ["run-interests"]`. A compatible
server replies with `live.capabilities` carrying the same version and capability.
An older server can ignore the hello; the client retains HTTP polling.

The browser then sends `live.interests`, a monotonically increasing `revision`,
and a replacement `runIds` array. The server applies that complete set before
replying with `live.subscribed` and the applied revision. The browser ignores
stale acknowledgements. Every connection starts a new revision sequence.
An unchanged run stays healthy while unrelated interests change. New interests
wait for an acknowledgement that includes them; only connection changes or an
explicit resynchronization advance the shared recovery generation. This avoids
aborting existing readers when another view starts or stops watching a run.
Views exceeding the 1,000-interest protocol limit retain HTTP fallback for
interests that cannot be advertised.

All mounted consumers share the existing company connection. Interests are
reference counted: removing one of two views of the same run does not unsubscribe
the other. Disabled views and hidden tabs withdraw their interests. Company and
account changes dispose the old connection. Progress, lifecycle, attention, and
activity notifications continue independently of transcript interests.

For an uninterested run, full `heartbeat.run.event` and `heartbeat.run.log`
payloads become an authorized `heartbeat.run.activity` notification containing
only run ID, agent ID, and last-output time. These notifications are coalesced to
at most one per run per second, driven by output rather than an idle timer.

## Catch-up and ordering

Consumers install their event listener before advertising interest. After the
latest subscription is acknowledged they read canonical history, merging it with
events that arrive during the read. Native events deduplicate by run sequence;
legacy logs also track log identity and persisted byte offsets. Streamed rows
never advance the persisted-history cursor. A second sequence gap observed during
an in-flight read remains pending until history covers it.

Compact conversation history intentionally excludes tool and reasoning rows.
After a complete filtered scan, its coverage includes the committed sequence known
before that read began, even when no matching conversation row has that sequence.
This settles excluded activity without recurring reads or downloading the full
event stream. A later notification cannot be covered by an older in-flight scan;
its catch-up must still recover any intervening conversation rows.

Native publication signals carry a committed sequence without a PRP body. They
trigger a canonical read through that sequence, including consecutive signals,
and never enter the transcript merge. A delayed signal cannot replace complete
text. Signals that arrive during an older read remain pending until history
covers them. This adds event-driven reads for payload-free notifications, not a
recurring poll or a recovery-checkpoint write.

Live catch-up refreshes only the affected run. Each run has at most one history
read in flight and one retry timer. Terminal notifications during a read coalesce
into one subsequent read. A busy run cannot cancel a sibling's paginated history.
This applies to both native commit signals and truncated legacy log chunks.
If subscription acknowledgement aborts Agent Detail's first history request,
negotiated recovery still drains the saved live tail without waiting for another
source event. Its first page initializes the manual history cursor; subsequent
catch-up pages use the independent recovery cursor. A completed run that was
never live retains manual pagination.

Agent Detail also refreshes its event history and shell log independently. A
signal for one cannot abort the other's page or advance its persisted cursor;
terminal notifications queue a follow-up for each active reader.

Catch-up runs on subscription, reconnect, show, explicit resynchronization, gaps,
and terminal status. Task transcript catch-up drains pending pages. Failed reads retry even
when the socket remains connected. After successful negotiated catch-up there
are no recurring transcript reads. Historical agent-detail logs retain their
existing explicit pagination. Agent Detail event history also reads at most one
1,000-row page automatically; a full page exposes **Load more events** and pauses
automatic history reads until the user requests the next page. Full live events
continue to arrive. Live retention keeps the opening 200 events (including the
invocation card) plus the latest 2,000, including through terminal transition.
Completed runs retain explicitly requested history. Initial and paginated read
failures remain visible, preserve loaded rows, and offer **Retry events**. Older clients and servers
retain fallback polling when no explicit event page is waiting.

## Backpressure

Each connection retains at most 1,000 queued items and 1 MiB across queued payloads
and socket buffering. Authorization that is still in flight counts toward the
queue. Interests are checked again after asynchronous authorization. Incoming
interest messages have a 64 KiB transport limit and at most 1,000 run IDs.

Overflow discards pending delivery work, invalidates in-flight results, and sends
`live.resync` with the affected revision. The browser replaces its interests and
catches up after the new acknowledgement. It also refreshes active application
queries because overflow can drop lifecycle messages. Persistent congestion
closes the socket with code 1013 after five seconds; this timer exists only while
congestion is pending. An older client is closed on overflow so its normal
reconnect path can catch up.

A new interest acknowledgement does not cancel the congestion deadline while an
old authorization or decoration read remains in flight. If that read settles,
the connection may recover; if it remains stalled, the original deadline closes
the socket even without another source event.

The server does not persist a browser-specific event backlog. Canonical history
is the recovery source. Execution continues whether there are zero viewers or
many viewers.

## Verification

The delivery tests cover legacy compatibility, authorization/redaction, revoked
access, interest changes during authorization, item and byte bounds, and the
congestion deadline. Browser-hook tests cover reference counting, acknowledgement
races, history/live ordering, failed reads, hide/show, company changes, terminal
catch-up, and zero recurring reads after negotiation.

Run the native browser journey with
`pnpm exec playwright test --config tests/e2e/playwright-transcript-delivery.config.ts`.
It uses the production runner and the existing deterministic Codex app-server
fixture. It creates a task through the current composer, opens two views, verifies
zero recurring transcript reads during settled streaming, changes companies,
disconnects the presentation socket, and checks terminal output after reload.
The fixture pins provider selection through the existing acceptance-only loader;
it does not contact a real model or add a production admission option.

The legacy journey is
`pnpm exec playwright test --config tests/e2e/playwright.config.ts agent-chat-sessions.spec.ts --grep 'chat first open'`.
Both use a disposable server and can use an explicitly supplied disposable
`DATABASE_URL` when local embedded Postgres is unavailable. Browser fixtures
establish delivery behavior, not native-provider or hosted-upgrade qualification.

`server/src/realtime/live-event-delivery.cost.test.ts` compares identical output
with zero interests, one viewer, three browser connections, and simulated socket
congestion. Set `PAPERCLIP_LIVE_DELIVERY_COST_REPORT` to retain its JSON report.
This measures the in-process presentation boundary, not production network or
database cost. CPU, heap deltas, and latency are diagnostic measurements, not
performance assertions. Current acceptance evidence lives in
`doc/plans/2026-10-22-hot-upgrade-qualification.md`.

Agent Detail's event log also treats notifications without a message or payload as
commit signals. It retains saved event details when a delayed signal arrives and
requests canonical history for a signal not yet covered by its persisted cursor,
including consecutive sequences. Complete live rows still merge directly without
recurring history reads. Both development and production page variants use this
behavior; their regressions fail on the preceding merge and pass after the fix.

## Recovery reads and plugin delivery

Resynchronization can also discard lifecycle events used by application lists.
Those views refresh after the replacement interest acknowledgement, when the
server has resumed delivery. An older in-flight query cannot satisfy that
boundary. One follow-up waits for it without cancelling the useful older read.
The follow-up checks the current company, connection, visibility and query cache
identity. Ordinary interest acknowledgements add no application refresh.

The five-second delivery deadline also covers an authorization, redaction or
decoration read that stalls before a queue reaches its bounds. Ping traffic and
interest revisions cannot reset that deadline. Closing disposes queued work and
rejects late results; the one already-started dependency read may still finish.
A legacy browser retains its existing skip-and-poll handling of a rejected read.
Transcript and activity events skip toast decoration and its business lookup.

Plugin run notifications share the bounded queue and canonical structural,
current-user and registered-secret redaction after their existing scope checks.
This work belongs to the active recipient, never the producer. Plugins do not
poll canonical history. Any failed delivery, backlog closure or subscription
timeout sends one content-free stream error and removes the subscription.
Disposal suppresses late notifications and new lookups. The error ends plugin
delivery without changing the underlying execution or recorded run status.

Explanatory code comments introduced by this slice are kept in this document,
as required by the contribution guide. Vitest environment and scoped lint
directives remain because they configure test execution and analysis.
