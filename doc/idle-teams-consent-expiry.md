# Teams consent expiry and idle work

Unused Teams file consent now uses the shared delivery coordinator and scheduler.
Existing `chat_teams_file_transfers` rows own its state. There is no new table,
independent timer, provider request or external-wake capability.

## Obligation and trigger

Only `consent_pending`, `awaiting_consent` and `upload_pending` rows are eligible.
Each uses its saved `expiresAt`. Registered startup reconstruction yields after
one 100-row UUID page per scope refresh and resumes through the shared scheduler.
Registration resets the owner’s cursors so a partial scan restarts safely. The
explicit one-shot inventory method still returns the complete inventory. Committed writes reload the affected transfer ID. The service registers
intent before insertion and its central versioned update, within the existing
transaction. Nested savepoints wait for outer settlement. The shared work-signals
protocol retains ambiguous outcomes; callers do not manage recovery wrappers.

Configured endpoints, completed history, unknown outcomes and active transport
attempts do not keep this worker scanning. Pending consent retains its actual
future deadline. PostgreSQL submillisecond timestamps round up to the next
millisecond; checking a deadline does not extend it.

## Expiry and recovery

At the deadline, the worker reloads the current row and delegates to the existing
Teams protocol owner. That owner locks publication then transfer, verifies the
current authority digest, rechecks phase and expiry, and updates the transfer
and publication projection in the same transaction. It does not send a consent
card, upload data or send a file-info card. Lock waits remain bounded. A changed
phase is re-evaluated; a deleted or settled row removes the cached obligation.

A failed load, lock or projection retains retry work. Corrupt rows do not starve
other transfers or companies. Errors emitted by this worker are generic and do
not contain SQL parameters, private transfer envelopes or provider capabilities.
The shared worker owns coalescing, batching, dirty hints, drain/resume and shutdown.
Shutdown joins an in-flight expiry; restart reconstructs the saved deadline.

The explicit `expireAndRecover` diagnostic method retains combined behavior.
Production periodic maintenance now selects and executes abandoned attempts only.
Attempt recovery is a separate remaining migration. Unknown provider outcomes
remain quarantined; this change does not authorize a resend.

## Ownership and limitations

Provider phase selection and expiry live in the Teams module and existing Teams
transfer service. Shared app wiring only registers the owner and lifecycle gate.
The queue topic is a notification namespace, not a new durable queue. Other
providers and the shared scheduler receive no Teams protocol policy.

Supported producers use the process's owning DB client. Independent SQL writers
or another process require their own wake contract. On-use authorization remains
with the protocol. Cloud eligibility and external alarm coverage are unchanged:
a future in-process deadline cannot wake stopped compute. This proves the changed
worker can become quiet, not fleet savings or complete instance suspension.

## Verification

Real PostgreSQL protocol cases cover all three phases, producer activation,
rollback and held outer commit, restart, pre-deadline quiet, timestamp precision,
projection rollback, fairness, drain/resume and shutdown. Production integration
registers the worker before Board publication and proves expiry cancels the
publication without another provider call. Existing authority, publication and
consent suites remain covered. See the [audit and failure ledger](plans/2026-10-25-teams-consent-expiry-sleep-audit.md).


Current local acceptance covers 223 distinct cases: 209 across five complete
protocol/publication/consent/runtime/wiring suites, plus 14 selected real Board
producer and Teams-authority integration cases. The other 1,580 integration
cases were skipped. A real 105-row regression proves bounded startup, same-owner
restart, complete saved-deadline expiry, and quiet SQL. A guarded missing-reset
mutation fails that regression. See the audit for exact revisions, earlier
fixture failures, current-parent integration status and deployment limits.
