# Idle login cleanup

Adapter device-login and Claude setup-token cleanup no longer scan on each
heartbeat scheduler tick (30 seconds by default). Two independent workers use
existing commit-aware delivery signals and the in-process work scheduler. No
schema or queue table is added.

## Ownership and triggers

| Duty | Existing durable truth | Trigger / deadline | Quiet condition |
| --- | --- | --- | --- |
| Displayed-code session expiry | `adapter_auth_sessions` | Insert or state change; session expiry, extended by an active promotion claim | No active expiring sessions |
| Displayed-code failed deletion | Session `cleanup_pending` | State change; 30-second retry while pending | Provider confirms deletion and status settles |
| Displayed-code orphan cleanup | Tagged `environment_leases` | Lease tag write, session transition, startup; retry while an orphan remains | No unreferenced active/failed-cleanup tagged leases |
| Setup-token expiry / consumed claims / terminal cleanup | Existing setup-token rows in `adapter_auth_sessions` | Record, state, claim, cancellation or deletion commit; expiry or retry | Cleanup rows removed after release |

`login-cleanup-state.ts` owns the database predicates and reconstructed deadlines.
`login-cleanup-work.ts` registers the independent workers. Domain stores register
intent before each write via `writeLoginCleanup`. The AI connection save path
also signals its session mutation in its existing transaction through
`notifyLoginSessionChanged`. That helper invalidates both sandbox cleanup workers
without choosing a provider. Each worker inspects its own durable predicates; the
unaffected worker becomes quiet after reconciliation. This bounded extra scan
occurs only after a session write, not on a recurring idle cadence. Login flows
still own completion through the callback introduced in PR #17129. Nested writes use
the shared outer-transaction settlement protocol, including rollback and uncertain
commit reconciliation. Notification means inspect durable state, not perform one
unit of work.

Each worker coalesces bursts and starts at most once per configured heartbeat
interval (30 seconds by default). This keeps the old scan budget and cleanup
resolution. Retry intervals use that same configuration. A future deadline beyond that
spacing is scheduled directly. A due or failed obligation retries after 30 seconds;
an empty worker has no recurring scan or timer. A write during a sweep retains a
new generation, including writes made by cleanup itself. A final follow-up scan
can therefore occur before the worker becomes quiet.

Local-subscription sessions share the table but are excluded from these sandbox
cleanup predicates. Their separate local-login worker owns filesystem cleanup.
Completed displayed-code session history is passive. A terminal setup-token row
is still work until its cleanup record is removed.

## Acquisition and orphan recovery

The displayed-code service persists a session and expiry before acquiring a
sandbox. Its production runtime signals the lease-tag write. An unreferenced
lease with that tag must not be deleted while its owning session is active and
unexpired, including a live promotion claim. The session deadline covers an
attachment that never completes. A failed session transition makes the orphan
eligible immediately, subject to worker spacing.

The orphan query examines tagged lease rows directly, so a terminal or missing
session cannot hide a failed cleanup by removing its environment from the scan.
A failed orphan delete remains visible and keeps its retry armed. Existing bound
session cleanup, promotion locking, conditional status updates and provider
confirmation semantics remain with their existing owners.

This is not a new provider-orphan discovery mechanism. A provider resource that
never became a persisted tagged lease still belongs to the existing general
lease cleanup / failed-acquisition spool recovery. Setup-token acquisition still
requires provider-backed expiry before creating its cleanup record. The general
sandbox cleanup worker and its startup recovery remain unchanged. Related
pre-existing setup-token release-outcome and null-lease fixes are tracked in
public PRs #15774 and #14236 (issue #16648); this change does not replace them.

## Lifecycle and sleep boundary

Workers register during startup housekeeping. They reconstruct current work even
when no producer notification survived a restart. Failed scans keep a retry.
Startup, a notification, or a failed attempt skipped during drain keeps its
requested generation until reconciliation succeeds after resume. Passive waiting
uses memory only. Warm standby and shutdown do not dispatch cleanup. Coordinator
shutdown removes subscriptions, stops timers and waits for in-flight work.

This supports one active server and writers using the shared database handle and
instrumented stores. Independent SQL writers and other replicas do not generate
these process-local signals and require their own integration.

No Cloud wake coverage or host-sleep exemptions are added. Outstanding login
sessions and unresolved resources retain the existing durable idle-safety blockers.
A local future deadline is not an external alarm. These tests establish worker
quiet and reactivation, not measured provider suspension or fleet savings.

## Verification

`server/src/__tests__/login-cleanup-work.test.ts` exercises empty/configured/history
states, real store reactivation, expiry, promotion deadlines, cancellation,
failed-delete retry and restart, live lease attachment, orphan recovery, nested
commit/rollback, setup-token consumption, burst coalescing, concurrent writes,
drain/resume and shutdown. Real PostgreSQL tests count calls through the worker's
database handle and provider release seam while fake time crosses former polling
periods. Existing device-login, setup-token and AI connection regression suites
cover the surrounding login contracts.

The fake-clock database fixture warms its connections and disables pool idle/lifetime
expiry so time jumps test the worker rather than racing socket connection timers.
Database suspension and reconnect behavior require separate qualification.
