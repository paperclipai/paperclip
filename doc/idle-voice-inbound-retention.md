# Inbound voice history retention

Inbound history retention uses the shared work scheduler. It does not scan on
the chat maintenance tick. Call-report reconciliation remains a separate duty.

An admission is eligible only when it is denied, expired or ended, provider
cleanup is confirmed, and neither a session nor an intake task owns it. The
existing policy retains it until both expiry and last update are seven days old:
`max(expiresAt, updatedAt) + 7 days`. No new table or persisted state is added.

The voice owner reconstructs eligible deadlines on startup, yielding after at
most 100 selected rows per scope refresh. Re-registering the same service resets
its page cursor so a partial scan cannot skip old deadlines. The existing
`notifyVoiceInbound` boundary now notifies cleanup and retention before writes.
Outer transaction settlement wakes the workers. Rolled-back changes do not
create retention work. Signed callbacks, rejection cleanup, approval/session
handoff and cleanup recovery retain their existing transaction ownership.
Configuration, authority and session-only changes do not change admission
retention eligibility, so they do not wake retention. Startup reconstructs
existing history, and admission writes carry the exact retention hint.

At the deadline, retention locks the admission and rechecks current eligibility
and both timestamps before deleting. PostgreSQL submillisecond timestamps round
up for scheduling. Cached candidates cannot authorize deleting a new binding or
history whose retention deadline moved. Batches page through history and use the
shared worker's company fairness, coalescing, bounded backoff and drain behavior.
Deletion failure retains a retry; a paused first write remains pending for resume.
Shutdown cancels or joins work, and restart reloads remaining durable deadlines.

Configured idle endpoints, ineligible history, and future retained history do not
cause recurring SQL between changes or actual deadlines. Unconfirmed cleanup
remains owned by the cleanup worker. Session/task history is not deleted here.
Explicit one-shot `pruneHistory` and diagnostic reconciliation remain available;
startup does not register those bulk operations as periodic work.

Supported writers must participate in the shared transaction notification
boundary. Independent SQL writers or additional processes require their own
notification/recovery contract. This migration does not extend Cloud alarms or
sleep eligibility: an in-process deadline cannot wake stopped compute. The
external wake owner must cover retention before that deadline can permit sleep.


The [current-parent acceptance](plans/2026-10-25-voice-inbound-retention-sleep-audit.md#current-parent-paging-and-restart-acceptance-october-28)
records bounded paging and restart acceptance. The subsequent
[notification review repair](plans/2026-10-25-voice-inbound-retention-sleep-audit.md#configuration-rescan-review-repair-october-28)
records 282 current passing cases and repeated configuration saves selecting zero
history rows, with the original failures and verification limits preserved.
