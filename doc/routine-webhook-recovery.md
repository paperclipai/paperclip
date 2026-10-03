# Routine webhook delivery and recovery

Routine webhook triggers expose their latest authentication result on the trigger and in the
routine activity feed. A rejected signature records `routine.webhook_rejected` without creating a
run or issue. An accepted delivery records `routine.webhook_received`; its routine run then shows
whether dispatch created work, reused work, was suppressed, or failed.

For signed Sentry deliveries, Paperclip derives the immutable issue ID only after verifying the raw
request body. It stores that ID as server-owned provider identity metadata on the routine run.
Exact delivery retries return the original run. Later lifecycle deliveries for the same Sentry ID
(including delayed `assigned`, `resolved`, or `unresolved` events) create auditable run records but
link to the first canonical issue, even when that issue is closed. They add a system comment with
the action, project, issue key, status, count, and last-seen time instead of creating another issue.

Project selection, assignee selection, and workspace selection remain properties of the matched
routine. Payload project fields cannot redirect work to another project or agent. Providers should
send only the projects covered by that routine's subscription/filter; ignored projects (for
example an explicitly excluded `iot` project) must not be forwarded to the trigger.

## Recovery

1. Check the trigger's latest delivery result and the routine activity feed. A rejection means the
   signing secret/header or raw-body forwarding must be repaired before replay.
2. For an accepted delivery, inspect the routine run. A failed run retains the original payload and
   immutable provider identity for diagnosis.
3. Replay the original signed delivery after repairing the failure. An exact retry is idempotent;
   a later Sentry lifecycle event links to the same canonical issue.
4. If the canonical issue is closed, leave it closed unless the operating workflow explicitly
   reopens it. The recurrence comment is the durable signal for post-closure triage.

Webhook payloads can contain customer and error context. Routine access and activity visibility
remain company-scoped; do not copy raw payloads into public logs or comments.
