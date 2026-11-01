# Idle Grok routine dispatch

The Grok dispatcher previously started a one-second timer whenever public MCP
was configured. Each tick read experimental settings, even when Grok was
otherwise disabled. Enabled ticks scanned prepared dispatches regardless of
whether any work existed. The disabled baseline regression observed three
settings queries in 3.2 seconds.

The dispatcher now registers with the existing delivery coordinator and shared
scheduler. It performs one startup reconciliation. The worker becomes quiet
when Grok is disabled or when no prepared dispatch remains. Quiet means no
recurring worker SQL or provider calls, including with retained terminal history.
This does not establish whole-instance or database suspension.

## Ownership and producers

`grokRoutineService.reserve` is the only supported creator of prepared dispatches.
It signals intent before its insert in the existing transaction. Route verification,
manual retry of a confirmed rejection, and native-broker assignment admission all
use this service. The native broker passes its transaction, so the wake follows
the outer commit. Savepoint release is not publication; rollback does not send.

`instanceSettingsService.updateExperimental` signals the same queue before its
existing transactional update. This covers enablePublicMcp, enableNativeRunner,
and enableGrokBot changes, including caller-owned outer transactions. It permits
prepared work retained while disabled to resume when enabled. Managed settings
and environment overlays are process configuration and are reconstructed on restart.
Other settings writers update general/default-environment fields, not these flags.

All other dispatch writers move rows away from prepared: send claims, delivery
settlement, acknowledgement, explicit recovery, assignment completion, and
revocation. None reopens a row as prepared. They cannot introduce hidden new work.
A previously scheduled backlog pass may observe cancellation and disarm.

Signals cover the current process's shared database owner and child pools.
Independent SQL writers or another process need explicit ingress integration;
this change does not claim cross-process notifications. Startup reconstructs
committed prepared rows from the existing dispatch table. No queue table is added.

## Delivery and recovery

The Grok service continues to own current authority checks, binding locks,
prepared-to-sending compare-and-set, secret access, provider delivery, and outcome
settlement. The worker does not interpret provider payloads or relocate policy
into app wiring. A foreground send and background recovery share the durable
claim; only the winner contacts the provider.

Each pass processes at most ten prepared rows. The next lookup uses the same
predicate and schedules the existing one-second cadence only while prepared work
remains, or after a reconciliation failure. New commits wake the shared worker;
its deadline adapter preserves requested generations through concurrent changes
and drain. The partial created_at/id index keeps both selection and pending-work
lookup independent of retained completed history. The migration builds it
concurrently, is replay-safe, and uses the normal snapshot-retention workflow.

The existing send-error policy is preserved: if sending throws and the row is
still prepared, the dispatcher cancels it. A row already claimed as sending is
never reset or replayed. Accepted, sending, unknown, acknowledged, rejected, and
cancelled rows do not become automatic retry work. Explicit operator retry still
creates a new intent only for confirmed rejection. This migration does not claim
exactly-once delivery or resolve uncertain provider outcomes automatically.

## Lifecycle and sleep boundary

The app registers only when public MCP is configured, after the shared coordinator
exists. Registration does not delay readiness for a provider send. The coordinator
tracks startup work and joins admitted sends on shutdown. Abort prevents the next
row from starting; existing HTTP timeouts bound a current transport operation.
Later prepared rows remain durable for restart.

Drain and warm standby retain pending requests without passive worker queries.
Resume uses the same coordinator retry path; a first write or failed sweep cannot
be forgotten merely because dispatch was paused. A disabled feature may retain
prepared rows without scheduling a scan; a committed settings change reactivates
it. Disabled feature state is not permission to discard durable work or relax
Cloud sleep guards. Existing binding/assignment/hold blockers remain unchanged.

## Verification

- The baseline failed the disabled-feature quiet assertion with three SQL reads.
- 21 real-PostgreSQL lifecycle cases cover disabled/configured idle, first real
  reservation, prepared startup recovery, all six non-prepared states, re-enable,
  outer commit/rollback, drain/startup, failed scan through drain, concurrent
  enqueue, two-page draining, foreground claim overlap, expired unsent work,
  settings transaction rollback/commit, and shutdown joining a send.
- The existing 45 Grok qualification cases and 39 startup cases pass together
  with the new suite: 105 cases total.
- The four affected settings suites pass 154 cases (259 selected cases total).
- Workspace typecheck, production build, migration checks and replay pass. A
  generic-plan probe with 40,000 completed dispatches and one prepared row uses
  the partial index for both queries (six shared buffers including the routine
  join; 0.032ms batch and 0.025ms next-work execution in this local probe).
- Remote PR review and CI must pass before the slice is ready.

The tests use the existing real OAuth/agent/routine fixture and a controlled
provider response. A validated disposable external PostgreSQL option permits
local execution where embedded PostgreSQL is unavailable; CI retains embedded
PostgreSQL by default. Provider-host suspension is outside this local proof.


## Current parent reconciliation

The normal merge of target parent `85ce6545bf` preserves its complete tree outside
this duty's explicit files. Grok dispatch, reservation, settings and app wiring
are unchanged from the preceding candidate. The index is regenerated as
`0391_third_roulette.sql`, with concurrent/idempotent execution. All 389 parent
journal entries are unchanged; five generated snapshots remain (0387–0391).
Schema drift, migration safety/numbering and fresh apply/replay on two isolated
PostgreSQL databases pass.

All 273 cases in nine complete suites pass at `6d81746fe2`: dispatch lifecycle,
Grok qualification, server startup, scoped deadlines and all five instance-settings
suites. Server typecheck and production build pass with the current Runner vendor.
The earlier 259-case and populated-plan measurements above remain historical
evidence; fresh exact-head reviews and CI are required.

An earlier browser CI run failed during agent-chat fixture restoration with a
lock timeout/HTTP 500; the subsequent case observed the experiment left enabled.
Those failures were not dispatcher assertions and are retained in the evidence.
The later pre-reconciliation `a74305e2b4` checks were terminal and green. Neither
that older result nor local acceptance substitutes for this candidate's CI.
