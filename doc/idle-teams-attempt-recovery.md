# Teams abandoned attempts and idle work

Teams transport-attempt recovery now runs from committed transfer changes and
saved claim deadlines. The shared coordinator and scheduler own its lifecycle.
Together with consent expiry, this replaces the periodic Teams maintenance
callback. It adds no table, schema or independent timer.

## Durable obligation

A transfer in `consent_sending`, `uploading`, `file_info_sending`, or `conflict`
with `attemptExpiresAt` has an outstanding claim. The existing protocol writes
an attempt ID and a 90-second deadline before provider I/O. A normal receipt
clears both. A conflicting callback retains the original in-flight claim until
its deadline; the conflict is not proof that the original operation stopped.

The protocol's central versioned update registers an awaited notification before
the write, within the existing transaction. This includes normal claims,
settlement, callbacks and caller-owned operator resolution. The DB work-signal
boundary owns outer commit, rollback and uncertain transaction settlement.
Inserts create unused consent, so they do not create an attempt obligation.

Startup reconstructs eligible attempts in 100-row UUID pages. A committed hint
reloads its transfer ID. PostgreSQL timestamps round upward to a millisecond.
An inspection does not move the saved deadline. A changed claim is reloaded
before recovery; settled or deleted rows remove the cached obligation.

## Recovery preserves uncertainty

At the deadline, the existing Teams owner locks publication then transfer,
checks integrity, and rechecks the current phase and deadline. It clears the
expired attempt and changes a sending phase to its corresponding unknown outcome.
Conflict stays conflict with its original reason and private evidence. Publication
projection and transfer mutation remain atomic. Lock waits remain bounded.

Recovery does not call a provider, resend a card or file, manufacture a receipt,
or assert that an unknown effect never occurred. A delayed foreground receipt
still has to match its current attempt ID and phase. Existing operator resolution
and on-use authorization rules remain unchanged.

Unknown outcomes with no live attempt are passive review evidence. Unused consent
is owned by the separate consent-expiry worker. Neither keeps attempt recovery
querying. Failed loads, locks or projections retain bounded retry work; fair
batches allow healthy rows and other companies to progress. Worker errors redact
SQL parameters and private transfer envelopes.

## Lifecycle and ownership

The Teams module selects phases and deadlines. The existing protocol performs
recovery. Shared startup only registers the worker and admission gates. The
shared scoped worker coalesces writes, preserves dirty scopes through drain,
reconstructs after restart, and joins in-flight work during shutdown. An unresolved
write may still need transaction-status reconciliation while dispatch is paused;
this is not an empty maintenance scan.

The explicit combined `expireAndRecover` and attempts-only diagnostic methods
remain available. Production `processPublicationMaintenance` no longer invokes
Teams recovery. Other chat maintenance reasons are separate pending migrations.

Supported writes use this process's owning DB client. Another active server or
independent SQL writer requires a separate notification contract. Cloud external
alarm coverage and conservative sleep eligibility are unchanged. A registered
local deadline cannot wake a stopped host. This migration proves worker quiet,
not measured provider suspension or fleet savings.

## Verification

Real PostgreSQL tests exercise all sending stages, conflict during a live send,
normal settlement, interrupted receipt persistence, saved deadlines across restart,
quiet history, drain/resume, rollback, precision, atomic projection failure,
102-entry paging/fairness and shutdown. The real Board producer integration
registers the worker before sending, observes the saved claim while the provider
receipt is held, and verifies that the committed receipt disarms recovery. Existing
Teams authority, consent and publication cases remain covered. See the
[audit and failure ledger](plans/2026-10-25-teams-attempt-recovery-sleep-audit.md).


Current parent acceptance is recorded in the audit's
[current-parent section](plans/2026-10-25-teams-attempt-recovery-sleep-audit.md#current-consent-parent-preparation-and-acceptance-october-28):
239 selected cases pass, with the old inherited rate-window CI failure and its
already-landed fixture fix preserved. Actual landed-parent reconciliation and
fresh remote checks remain merge requirements; historical counts are not current
full-workspace verification.
