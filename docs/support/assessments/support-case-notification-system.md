# Support Case Assessment: Notification System — Email, Push, and In-App Notifications

**Feature**: Multi-channel notification system with user-configurable preferences, email digests, push subscriptions, delivery status tracking, and automatic notifications for key events
**Assessed by**: Support Engineer
**Date**: 2026-08-21 (updated 2026-08-21 — PRX-46 heartbeat failure webhook added)
**Related**: VOY-1342, VOY-1364, VOY-1367, VOY-1365, VOY-1402, VOY-1527, VOY-1531, PRX-46
**Release**: v0.4.0-alpha (hotfix VOY-1367) + H-3 delivery telemetry (VOY-1402) + PRX-46 heartbeat webhook

## Feature Overview (User Perspective)

The Notification System provides a multi-channel notification infrastructure for Voyonder. Board users receive notifications about events requiring their attention — approval requests, review requests, completed work, budget threshold crosses, and execution errors.

**What users experience:**

- **In-app notifications** — A notification panel accessible from the board UI shows recent notifications with read/unread state
- **Email notifications** — Branded HTML emails sent via SMTP when enabled for a notification type, with a click-through "Open in board" action button
- **Push notifications** — Web push notifications delivered via configured push subscriptions
- **Daily/weekly digests** — A summary email of all notifications from the past day or week, instead of instant individual emails
- **Per-type preferences** — Users can control which channels (email, webpush, in_app) are active for each notification type, and choose between instant delivery or digest bundling
- **Delivery status tracking** — Each notification records per-channel delivery status (pending/sent/failed) with error messages. A Notification History view in the notification preferences page shows color-coded status badges (green = delivered, yellow = pending, red = failed).

### Notification Types

| Type | Triggered When | Default Email |
|------|---------------|---------------|
| `review_requested` | An issue transitions to `in_review` status | Off (in-app only by default) |
| `approval_needed` | An approval is created on an issue | Off (in-app only by default) |
| `work_completed` | An issue transitions to `done` status | Off (in-app only by default) |
| `budget_threshold` | A budget soft/hard threshold is crossed | On |
| `execution_error` | An agent run fails or times out | Off (in-app only by default) |

### Channels

| Channel | Description | Requires Setup |
|---------|-------------|---------------|
| `in_app` | Notification appears in the board notification panel | None — always available |
| `email` | HTML email sent to the user's email address | SMTP server (see Environment Configuration) |
| `webpush` | Web push notification via browser push API | Push subscription registration |

### Digests

Users can choose a digest frequency for each notification type × channel:
- **`instant`** — Each notification is delivered immediately
- **`daily`** — Notifications are bundled into a single daily email
- **`weekly`** — Notifications are bundled into a single weekly email
- **`never`** — No notifications for this type/channel

### Notification preference defaults

| Notification Type | In-App | Email | Web Push |
|-------------------|--------|-------|----------|
| review_requested | ✅ Enabled | ❌ Disabled | ❌ Disabled |
| approval_needed | ✅ Enabled | ❌ Disabled | ❌ Disabled |
| work_completed | ✅ Enabled | ❌ Disabled | ❌ Disabled |
| budget_threshold | ✅ Enabled | ✅ Enabled | ❌ Disabled |
| execution_error | ✅ Enabled | ❌ Disabled | ❌ Disabled |

## What Changed

### New API endpoints

**Notification Preferences:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/companies/:companyId/notification-preferences` | Board user | Get all notification preferences |
| `PUT` | `/api/companies/:companyId/notification-preferences` | Board user | Batch upsert notification preferences |

**In-App Notifications:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/companies/:companyId/notifications` | Board user | List notifications (paginated, optional `unreadOnly` filter) |
| `GET` | `/api/companies/:companyId/notifications/unread-count` | Board user | Get unread notification count |
| `POST` | `/api/companies/:companyId/notifications/read-all` | Board user | Mark all notifications as read |
| `POST` | `/api/companies/:companyId/notifications/:notificationId/read` | Board user | Mark a single notification as read |

**Push Subscriptions:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/companies/:companyId/push-subscriptions` | Board user | List push subscriptions |
| `POST` | `/api/companies/:companyId/push-subscriptions` | Board user | Register a push subscription |
| `DELETE` | `/api/companies/:companyId/push-subscriptions/:subscriptionId` | Board user | Unregister a push subscription |

**System Notifications (Admin/Server):**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/companies/:companyId/notifications/send` | Agent or board user | Manually send a notification to a company member |
| `POST` | `/api/companies/:companyId/notifications/digest` | Board user | Trigger a digest send for a frequency (daily/weekly) |

### Auto-notification triggers

Notifications are automatically sent by the system at these points:

| Trigger | Notification Type | Where | 
|---------|-------------------|-------|
| Issue transitions to `in_review` | `review_requested` | `issues.ts` route — issue status change |
| Issue transitions to `done` | `work_completed` | `issues.ts` route — issue status change |
| Approval is created | `approval_needed` | `approvals.ts` route — approval creation |
| Budget threshold crossed | `budget_threshold` | `budgets.ts` service — threshold incident creation |
| Agent run execution error | `execution_error` | `heartbeat.ts` service — run terminal error |

All auto-notifications are fire-and-forget: a failure to dispatch a notification never causes the triggering operation to fail. Errors are logged as warnings.

### Execution error deduplication (VOY-1364 B3 fix)

The `notifyExecutionErrorOnce` function deduplicates execution error notifications by tracking `metadataJson->>'runId'`. This ensures that if the same run transitions to terminal error status through multiple code paths (e.g., process loss *and* status setting), only one notification is sent per run ID.

### SMTP mailer

Notifications use a **built-in SMTP client** built on Node.js `net` and `tls` modules — no external email library required. It supports:
- Plain TCP (port 25/587) with STARTTLS
- SSL/TLS (port 465)
- AUTH LOGIN authentication

### Email branding

All notification emails use Voyonder branding:
- Dark header banner with brand name
- Greeting line with recipient name (when available)
- Action button linking into the board
- Company name in the footer
- Unsubscribe/Preference management note

### Digest emails

Digest emails bundle multiple notifications into a single summary with:
- Frequency label ("Daily" or "Weekly") with date
- List of notification items with title, body, and links
- Footer note explaining the digest preference

### Delivery status tracking (VOY-1402 H-3)

Each notification now records per-channel delivery status:

| Field | Values | Description |
|-------|--------|-------------|
| `emailDelivery.status` | `pending` / `sent` / `failed` / `null` | Email delivery outcome. `null` when email was not attempted (channel disabled, SMTP unconfigured, or deferred to digest). |
| `emailDelivery.error` | string or `null` | SMTP error message when email delivery failed |
| `pushDelivery.status` | `pending` / `sent` / `failed` / `null` | Push delivery outcome. `null` when push was not attempted. |
| `pushDelivery.error` | string or `null` | Push delivery error message when push delivery failed |
| `deliveryStatus` | `pending` / `sent` / `failed` / `null` | Computed overall status: `failed` if any channel failed, `sent` if all attempted channels succeeded, `pending` otherwise. `null` when no external channels were attempted (in-app only — no delivery tracking). |

**Status initialization**: When `notify()` dispatches a notification, per-channel statuses are initialized to `pending` for each attempted channel before the SMTP/VAPID calls start. If a channel fails later, its status transitions to `failed` with an error message. If it succeeds, status transitions to `sent`.

> **✅ Resolved (VOY-1527/VOY-1531, hotfix shipped 2026-08-20 ~17:20 UTC):** For email+digest notifications, `emailDeliveryStatus` is now initialized correctly. The digest preference query (`SELECT digestFrequency`) runs *before* the `initUpdates` block, so `emailDeferredToDigest` is correctly resolved before the status init decision. Deferred emails no longer show stale `pending` status. The fix is confirmed in commit 9949b6dfcb (hotfix VOY-1531) — see the [Async UX Release Notes](../releases/voy-1474-async-ux.md) for details.

**Backfill on existing data**: Notifications created before this feature (`email_sent_at`/`push_sent_at` without delivery status columns) are backfilled during migration 0143: notifications with a non-null `email_sent_at` get `emailDelivery.status = 'sent'`, and similarly for `push_sent_at`.

**Telemetry**: Two PostHog events fire on delivery outcomes (lazy-loaded to ensure telemetry failures never block delivery):
- `notification.delivery_sent` — emitted when an SMTP or push delivery succeeds
- `notification.delivery_failed` — emitted when an SMTP or push delivery fails

Telemetry failures are silently caught — delivery is never blocked by a telemetry error.

**Notification History UI**: The notification preferences page now includes a "Notification history" section that lists recent notifications with color-coded delivery status badges:
- **Green** ("Delivered") — all attempted channels succeeded
- **Yellow** ("Pending") — at least one channel is still pending
- **Red** ("Failed") — at least one channel failed

The table shows Email, Push, and Overall delivery status in separate columns for quick diagnostics.

### Default preference resolution (VOY-1364 S1 fix)

The `getEffectiveChannels` function applies default preferences **only when no preference row exists** for the user. If a user has explicitly disabled a channel for a notification type, that preference is respected — defaults do not override explicit user choices.

## Environment Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SMTP_HOST` | For email notifications | SMTP server hostname |
| `SMTP_PORT` | For email notifications | SMTP server port (default: 587) |
| `SMTP_USER` | For email notifications | SMTP authentication username |
| `SMTP_PASS` | For email notifications | SMTP authentication password |
| `SMTP_FROM` | No (default: noreply@voyonder.com) | From email address |
| `SMTP_FROM_NAME` | No (default: Voyonder) | From display name |

**Web push notifications** use the [web-push](https://www.npmjs.com/package/web-push) package with VAPID keys:

| Variable | Required | Description |
|----------|----------|-------------|
| `VAPID_PUBLIC_KEY` | For web push | VAPID public key |
| `VAPID_PRIVATE_KEY` | For web push | VAPID private key |
| `VAPID_SUBJECT` | No (default: mailto:noreply@voyonder.com) | VAPID contact URI |

Without VAPID keys, web push is silently skipped (returns false). Push subscriptions can still be registered, but delivery only occurs when VAPID is configured.

If SMTP is not configured, email notifications are silently skipped (logged as warnings). In-app notifications work regardless.

## Potential User Confusion Points

1. **"I'm not getting email notifications"** — Check: (1) SMTP is configured (SMTP_HOST, SMTP_USER, SMTP_PASS), (2) email is enabled for the notification type in preferences, (3) the notification type's digest is set to `instant` rather than `daily`/`weekly`/`never`. Defaults have email disabled for most types — users must opt in.

2. **"I'm getting too many emails"** — Change the notification preference for the notification type to `daily` or `weekly` digest, or set email to disabled. Each notification type × channel has independent settings.

3. **"I set my preferences but notifications still go to email"** — Ensure the preference upsert is for the correct `notificationType` and `channel` combination. The `getEffectiveChannels` function only falls back to defaults when **no preference row exists at all** — an explicit `enabled: false` preference is respected.

4. **"Notifications say they're sent but I didn't receive an email"** — Emails are sent asynchronously. Check the server logs for SMTP connection errors. If SMTP is not configured, the notification record is still created (in-app notification works) but email is silently skipped with a log warning.

5. **"Digest emails are empty"** — If no notifications were created during the digest period, the digest email may have zero items. This is expected behavior. Check that notifications are being created by verifying the notification records in the database.

6. **"I'm getting duplicate execution error notifications"** — The `notifyExecutionErrorOnce` deduplication prevents multiple notifications for the same run ID. If duplicates still occur, verify the `metadataJson` payload includes a unique `runId`. This should be a rare edge case — escalate to Staff Engineer.

7. **"Push notifications aren't working"** — Push subscriptions require browser Push API support. Verify the subscription was registered successfully. Push notifications use web push protocol — check that the VAPID keys or other push service configuration is correct if needed.

9. **"My email notifications have garbled content"** — The email templates escape all user-controlled content for HTML safety. If content appears garbled, it may be an encoding issue in the SMTP transport. Check server logs.

10. **"I chose daily digest but I'm still getting instant emails"** — Digest preferences are per notification type × channel. Ensure the digest frequency is set for the specific `email` channel on the specific notification type. When email is deferred to digest, `emailSentAt` stays `null` on the notification record until the digest sends.

11. **"I tried to send a notification to a user but got 'Target user is not an active member'"** — The `/notifications/send` endpoint verifies that the target `userId` is an active member of the company. Check that the user has an active membership (`status = 'active'`) in the company. Users who have been removed or whose membership is inactive cannot receive notifications via this endpoint.

12. **"My notification shows 'Pending' for email delivery and it's been hours"** — Delivery status is updated asynchronously. If SMTP is not configured, the status stays `pending` because email was never attempted. Check SMTP configuration. If SMTP is configured, check the server logs for SMTP connection errors — the status may be stuck at `pending` if the SMTP send threw an unhandled error.

13. **"My notification shows 'Pending' for email delivery but I chose daily/weekly digest"** — **This was a known bug that is now resolved.** The fix (VOY-1527/VOY-1531, shipped 2026-08-20) moves the digest preference query before the status initialization. If you still see this after the fix, verify the server was restarted with the hotfix (commit 9949b6dfcb+). The email is correctly batched for the next digest delivery regardless.

14. **"My notification shows 'Failed' for email delivery — what does the error mean?"** — The `emailDelivery.error` field contains the SMTP error message. Common causes: SMTP connection refused (wrong host/port), authentication failed (wrong credentials), or TLS negotiation failure. Check the server logs for the full SMTP conversation.

15. **"I see 'Failed' in the Notification History but I did receive the email"** — Per-channel status is independent. If email shows `failed` but you received the email, the SMTP send succeeded on the server side but the status update to `sent` may have been skipped due to a database error. Check the server logs for the notification ID. Escalate if it's repeatable.

16. **"The Notification History shows a notification I don't remember"** — Notifications are created by the system (auto-triggered events) or by other agents/users via `POST /notifications/send`. Check the `notificationType` and `metadataJson` for context about who created it and why.

17. **"Some notifications have no delivery status at all (null)"** — This is correct for in-app-only notifications where no external channel (email or push) was attempted. `deliveryStatus: null` means the notification was delivered in-app only and no external delivery tracking applies.

18. **"I see 'Pending' for push delivery even though I'm not using push"** — If push channel is enabled by default for a notification type, the system initializes `pushDelivery.status = 'pending'` before attempting delivery. If VAPID is not configured, push delivery is skipped but the initial status may still show as `pending` if the notification was created before the skip check. This is harmless — the in-app notification was delivered successfully.

## Support Escalation Path

| Issue | Severity | Action |
|---|---|---|
| Email notifications not delivering (SMTP configured) | High | Check server logs for SMTP connection/auth errors. Verify SMTP credentials. Test SMTP connectivity manually. |
| Notification system causing request failures | Critical | Notifications are designed as fire-and-forget — they should never fail the triggering request. If they do, escalate to CTO immediately. |
| Duplicate execution error notifications | Medium | Check if the same run ID is being processed through multiple error paths. Escalate to Staff Engineer if confirmed. |
| Digest not sending on schedule | Medium | Verify digest trigger is being called. The digest endpoint is manual/triggered — check if a scheduled job or cron is configured to call `POST /notifications/digest`. |
| User cannot find notification preferences | Low | Preferences UI is accessed from the board. Direct user to their account/notification settings. |
| Notification preference save fails | Medium | Verify the request body matches the expected schema (notificationType, channel, enabled). The batch endpoint accepts 1-50 preferences per request. |
| In-app notification count is wrong | Low | The `unread-count` endpoint counts notifications with `readAt IS NULL`. Verify no other user is marking notifications as read. |
| Web push notification delivery failure | Medium | Push subscriptions are stored per browser. If a subscription endpoint is stale (browser unsubscribed), push delivery will fail silently. Re-register the push subscription. |
| Notifications stuck at "Pending" for email delivery | Medium | SMTP may be unconfigured or misconfigured. Check SMTP_HOST/SMTP_USER/SMTP_PASS. Test SMTP connectivity manually. If SMTP is configured but notifications remain pending, escalate — the delivery update may not be persisting to the database. |
|| Notification delivery shows "Failed" with specific SMTP error | Medium | Interpret the error: connection refused (wrong host/port), authentication failed (wrong credentials), or TLS error. Verify SMTP credentials and test manually. |
| Delivery status shows "Failed" for email but user received the email | Low | The SMTP send succeeded but the status update query may have failed. Check server logs for the notification ID. Escalate if repeatable — possible database write issue. |
| Email status shows "Pending" for digest-deferred notifications | Low | **RESOLVED** (VOY-1527/VOY-1531, shipped 2026-08-20). If still seen after fix, server may not have been restarted with the hotfix. Verify server is on commit 9949b6dfcb+. |
| Notification History UI fails to load | Low | Check browser console for errors. The component queries `GET /notifications` endpoint. If the endpoint fails, check server-side notification route health. |
| Delivery telemetry events not appearing in PostHog | Low | Telemetry is lazy-loaded and fire-and-forget — failures are silently caught. If PostHog events are missing, check PostHog API key/host configuration and the telemetry import path. |

## Heartbeat Failure Webhook (Operator Channel)

In addition to the user-facing notification channels (in-app, email, web push), the server supports an **operator-facing notification channel** for heartbeat failures. This is not a user-configurable channel — it is set by the server operator via environment variable.

### How it works

When `PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL` is set, the server POSTs a JSON payload to the configured URL each time a heartbeat run reaches a terminal failure status. The webhook is fire-and-forget: errors calling the URL are logged as warnings and never break the triggering operation.

### Payload

```json
{
  "event": "heartbeat.failed",
  "timestamp": "2026-08-21T19:30:00.000Z",
  "runId": "run-xxx",
  "agentId": "agent-xxx",
  "agentName": "Agent Name or null",
  "companyId": "company-xxx",
  "errorCode": "adapter_failed|process_lost|agent_not_found|setup_failed",
  "error": "Human-readable error message",
  "previousStatus": "running|queued"
}
```

### When it fires

The webhook is called at 4 terminal failure paths:

| Failure Path | `errorCode` | Description |
|---|---|---|
| Process lost | `process_lost` | The reaper detected a process is lost and marked the run as failed |
| Agent not found | `agent_not_found` | The agent referenced by the run no longer exists |
| Adapter execution failure | `adapter_failed` | The adapter threw during execution |
| Setup failure | `setup_failed` | Setup code (before adapter.execute) threw |

### Configuration

| Variable | Description |
|---|---|
| `PAPERCLIP_HEARTBEAT_FAILURE_WEBHOOK_URL` | A webhook URL (e.g., Discord channel webhook) that accepts JSON POST requests. When set, the server sends heartbeat failure notifications to this URL. |

The server startup banner shows whether this is configured on the "HB Failure Webhook" line.

### What support should know

- This is an **operator channel** — board users cannot configure it; it is set at the server level.
- The webhook URL can point to any service that accepts JSON POST (Discord, Slack, custom HTTP endpoint, PagerDuty, etc.).
- If the webhook is not configured, heartbeat failures are still logged locally and visible in the server logs.
- If the webhook is configured but unreachable, failures are logged as warnings but no escalation occurs — operators should monitor their webhook endpoint health separately.

## Related Documentation

- [Billing System Support Case Assessment](support-case-billing-system.md)
- [Heartbeat Failure Webhook Internal Doc](/server/docs/notifications.md#heartbeat-failure-webhook)
- [v0.4.0-alpha Release Notes](../releases/v0.4.0-alpha-deep-planning.md)