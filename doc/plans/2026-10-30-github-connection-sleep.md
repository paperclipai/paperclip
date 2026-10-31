# GitHub connection delivery and credential continuity

GitHub event delivery and credential continuity have separate obligations.
The event worker uses the shared delivery coordinator. It performs a startup
reconciliation and responds to committed configuration changes or authenticated
Cloud hints. Credential work registers the actual next grant expiry, provider
continuity check, or saved retry deadline. The aggregate heartbeat no longer
calls either service, including when the heartbeat scheduler is disabled.

## Event delivery contract

The Cloud webhook target queue remains durable truth. The tenant leases sealed
events, validates their bindings, persists company-scoped receipts, applies the
existing installation or pull-request behavior, and acknowledges completed work.
A receipt row lock prevents overlapping receivers from applying an installation
delta twice. Completed receipts remain passive history. The existing normalized
merged-pull-request callback keeps its normalized key. Snapshot and confirmation
reads/writes share the receipt transaction, including at pool size one; existing
confirmation publications and direct wakes flush only after the outer commit.
The pre-existing non-chat direct-wake crash gap remains: chat-bound continuations
have their existing durable outbox, while an unbound direct wake is best effort.

A new tenant sends signed event-lease claim `ewv=1`. A compatible Cloud broker
records delivery version 1 on the existing instance registration before returning
`eventWakeVersion=1`. Only then does the tenant stop configured-empty polling.
Cloud reconstructs unacknowledged targets after restart and retries the exact
registered tenant when its current queue lease permits another delivery. A
successful HTTP hint does not acknowledge the target. Missing, stopped or drained
tenants therefore retain their work. The hint carries no provider payload or
client-selected destination. The tenant checks a signed, stack-bound, single-use
`connector-events:wake` control assertion on the exact POST endpoint.

Old Cloud and self-hosted registrations retain scoped reconciliation with the
existing backoff. No connector configuration or no registration history settles
to no recurring owner SQL or provider traffic. Disabled consumers can acknowledge
queued events as ignored using their trusted local registration history; they
cannot apply events to an inactive connection. Removing polling does not remove
the host sleep safety blockers. Worker quiet is not proof of host suspension.

## Durable credential debt

A grant stores a unique `bindingSync` revision and removed installation IDs before
Cloud registration calls. Successful delivery clears only the locked current
revision. Failure retains the saved intent and an exponential retry deadline,
including provider Retry-After advice. A restart loads that deadline from the
grant. A retry write compares the attempted credential/installation revision under
the grant lock and cannot delay work committed by a newer revision. Restoration
creates a new binding revision and removes active installations from the pending
retirement list; binding commands also reject legacy conflicting retirements.
Binding-only retries use the existing credential refresh lease and current
secret resolver without repeating account/repository discovery. The initial OAuth
callback uses the same saved debt and settlement path after connection activation.

Cloud binding calls retain the grant, its connection, and a company share lock.
That admission fence prevents a concurrent disable, revoke, or archive from
finishing before an already-admitted registration call. The API has no remote
revision fence that could safely replace those locks with two short transactions.
Each HTTP request and response body has a physical 15-second abort deadline.
Four calls run in an awaited batch; a failed batch leaves the saved debt and
releases the transaction after all four outcomes settle. Other companies can
continue through separate pool connections. Slow successful multi-batch passes
can delay writes to the same grant/connection and company status changes; the
schema permits up to 100 active and 100 removed installation IDs. This is not an
instance-wide lock or an idle hold.

Credential expiry remains enforced by the existing use path. Scheduled continuity
checks run one hour before recorded access expiry or after the existing 30-day
continuity window. A successful renewal that leaves the credential short-lived
or unchanged retains a one-hour retry obligation instead of causing rapid calls.
Changed credential metadata invalidates the old retry revision, so an earlier new
expiry can preempt it. Disabled connections and archived companies do not perform
credential work. Reactivation uses the normal committed configuration signal.

GitHub owners receive only relevant credential/configuration signals, not generic
health or receiver notifications. Continuity reconstruction is company-scoped
after the startup scan. Event draining retains instance-wide binding matching
because Cloud leases an instance queue. Event hints coalesce with a five-second
minimum pass spacing; an unrelated connection PATCH cannot trigger that drain.
OAuth rotation merges only its owned OAuth fields, lease acquisition compares
current metadata, and cleanup atomically removes only the matching lease path,
preserving concurrent GitHub installation changes and binding-removal debt.

Supported local producers are the owning connection, OAuth, grant and company
services in one tenant process. Their notifications belong to the outer database
transaction. A savepoint does not commit a wake, and rollback cancels the write.
Arbitrary SQL writers must use these notification contracts or restart the owner;
process-local signals do not promise independent-writer or replica notification.
External event delivery remains durable in Cloud across processes and restarts.

## Paired rollout and rollback

1. Apply the companion Cloud registration-column migration and deploy its delivery
   worker with the control signer present. Keep new enrollment disabled initially.
2. Deploy this tenant version. It keeps fallback polling against older Cloud.
3. Enable Cloud enrollment. Version 1 activation is durable and idempotent. Turning
   the new-enrollment flag off must still service all existing version 1 records.
4. Before removing the Cloud delivery worker, restart affected tenants with
   `PAPERCLIP_GITHUB_EVENT_POLLING=1`. They arm fallback before sending signed
   `ewv=0`. Confirm the Cloud registration is cleared. A failed handoff leaves
   fallback active and Cloud retry intact. Alternatively, restore the old polling
   tenant image first while retaining the compatible Cloud worker.
5. Do not deploy a Cloud downgrade that removes responsibility for still-enrolled
   tenants. There is no capability expiry, renewal poll, or periodic tenant hint.

## Evidence

Focused tests use isolated PostgreSQL plus controlled HTTP provider simulations.
They cover first service write after quiet, saved results, terminal receipts,
concurrent replay, signed callbacks, outer commit/rollback, drain/resume, startup
wiring in both scheduler branches, credential backoff and changed deadlines.
Cloud acceptance uses its actual broker/store/notifier boundaries and a controlled
HTTP tenant. These tests do not establish a deployed fleet rollout or cost savings.
