# Backup expiration without idle polling

The backup expiration duty retains its existing minimum age and safety policy.
It uses the shared scoped deadline coordinator. The archived runner evidence and
checkpoint expiration duties keep their separate registrations.

The durable source is each controller-owned `failover-backups/current` directory,
its control-plane session identity, and the associated run, issue, finalization,
and environment lease rows. The next eligible instant is one millisecond after
the later of the backup mtime and every related issue's close time, plus the
configured retention duration. An open issue, live run or lease, unsettled
finalization, or cleanup activation has no time-derived expiry; its producer
must invalidate the source when it changes. A busy process or failed I/O leaves
real unresolved cleanup and uses the shared retry backoff. Dry-run reports an
eligible source once and waits for source invalidation or restart.

Startup pages existing disk scopes and indexes company ownership, including
protected backups. Company notifications inspect only that index; local backup
publication adds newly created roots. Roots without backup or cleanup tombstones
perform no backup SQL. After discovery and all obligations settle, there is no
recurring SQL or filesystem scan. Startup reconstructs future work; inspecting a
source never changes its business timestamps. Runtime task close/reopen and
retention timestamp changes, native environment and retained session writes,
local backup publication, and process release invalidate the company or digest.
Signals from database producers register before writes inside their owning
transaction, including caller-owned transactions and nested savepoints.

The controller remains the only supported writer of its local backup files.
An independent process writing those files must use the same producer ingress;
manual disk edits require reconstruction on restart. Database writer ingress
continues to use the existing transaction-aware work signals. This change adds
no permanent database listener and does not add a polling table or migration.

The existing issue share locks now remain held through the retirement rename.
This fences task reopen while the backup becomes unavailable. A failed database
transaction restores `.retiring-*`; a process interruption is recovered from
that existing file journal at startup. Journal reconciliation runs before
identity or owner lookup, so an agent purge cannot strand expired physical
cleanup or prevent restoration of a retiring backup. After database settlement, `.expired-*`
records outstanding physical removal so a partial delete retries idempotently.
Ownership, session identity, live run, lease and local execution safety checks
remain in the backup owner. No host-sleep blocker or expiry-on-use rule changes.
An in-process deadline does not register a Cloud wake alarm.

Acceptance uses isolated real PostgreSQL for service writes, transaction signals,
safety checks, resume pointer deletion, and restart reconstruction. A temporary
filesystem is the controlled storage boundary. These tests do not claim cloud
object storage behavior, deployed sleep, or fleet savings.
