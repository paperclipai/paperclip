# Approved tool-action recovery

Approved tool actions recover at startup and after committed review changes.
The aggregate maintenance tick no longer scans approved requests. The existing
request and invocation rows remain authoritative; this change adds no queue table.

## Work and quiet states

The gateway owns the approved-work predicate. A signed agent action with
`executionOnApprove: true` owes execution through the normal approval path.
A legacy signed action without that flag remains deliberately inert. A Test-tab
approval can owe execution even when no agent run exists. Recovery uses the saved
origin and current authorization/target checks; the scheduler sees only whether
another attempt is needed.

Recovery pages approved requests in ID order using a partial index. It does not
let a full batch of unavailable approvals starve later work. A failed read or
unresolved executable approval retains a 30-second retry. Once a pass leaves no
such obligation, there is no recurring approved-recovery query. An empty system,
configured idle tools, completed history, and deliberately inert approvals are
quiet after reconciliation.

## Producer and transaction ownership

The existing tool-review notification boundary now signals both pending expiry
and approved recovery. This covers human review transactions, gateway approval
and accepted-interaction inference, administrative interaction resolution, review
queue invalidation, and the gateway's approval claims and managed-argument
invalidation. The notification is awaited before SQL in the existing transaction;
caller-owned outer transactions retain commit/rollback ownership.

A pending-only change can cause one empty approved-recovery pass. It does not
create a periodic scan. No per-route recovery bookkeeping or database listener
is added. Signals use the existing database owner's single-active-writer model.
Independent SQL writers or another process need a separate notification contract.

## Single execution and outcome ownership

Agent actions retain their existing approved-to-executing claim. Test-tab
foreground approval and recovery now share an equivalent claim before provider
dispatch. The invocation then starts only if the request still holds that claim.
Provider calls and target/policy lookup remain outside SQL transactions.

The Test-tab invocation outcome and terminal request status commit together.
Claim timestamps fence late settlement. A later audit failure cannot overwrite
an already committed outcome. Recovery repairs legacy approved Test-tab requests
from a saved terminal invocation without decoding old arguments or calling the
provider. A legacy executing invocation moves to the existing interrupted-work
path; it is not dispatched again.

If the provider may have run but its result cannot be persisted, the executing
claim remains authoritative. The existing stale-execution recovery quarantines
unknown outcomes. This slice does not promise exactly-once external effects or
replay an uncertain provider call.

## Lifecycle and remaining duties

The shared deadline worker coalesces notifications, preserves changes during a
pass, and retains skipped work across idle drain/resume. Startup reconstructs
saved approvals. Shutdown stops its coordinator registration. With heartbeat
scheduling disabled, startup keeps the existing one-off recovery behavior.

Pending expiry is owned by the preceding slice. Interrupted execution and
interaction projection repair remain in the old sweep until their own migrations.
The public combined sweep retains all duties for manual/recovery callers.
No Cloud eligibility or external-wake proof changes here; worker quiet does not
establish deployed database or host suspension.

## Verification

Real PostgreSQL service/startup tests cover producer commit and rollback,
startup reconstruction, empty/configured/history quiet states, concrete retries,
first-write drain/resume, legacy inert approvals, and multi-page recovery.
Controlled Test-tab provider tests cover both foreground/recovery race winners,
completed legacy outcomes, interrupted legacy calls, target changes, and a failed
atomic outcome write followed by quarantine without another provider call.

The service/startup selection passes 122 tests. The existing gateway acceptance
suite passes 92 tests. The strengthened paging and outcome-failure cases pass
again after their final edits. Workspace typecheck and build pass. Full CI and
review remain separate PR gates; no real external provider was invoked by these
fixtures.
