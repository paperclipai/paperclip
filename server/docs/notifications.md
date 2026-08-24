# Notifications — delivery system

## Overview

The notification service (`notificationService` in
`server/src/services/notifications.ts`) manages in-app and out-of-band
delivery of notifications to users. It supports two delivery channels:

- **Email** — sent immediately or batched into a digest
- **Web push** — sent immediately via the web-push protocol

### Notification lifecycle

```
created → [pending delivery] → sent|failed
```

When a notification is created via `notify()`:

1. A row is inserted into the `notifications` table.
2. The user's effective channels are resolved (which channels are enabled
   for this notification type).
3. **If email is enabled**, the system checks whether this user has opted
   into a digest for this notification type.
4. Delivery statuses are initialised (`emailDeliveryStatus`, `pushDeliveryStatus`)
   for channels that will be dispatched immediately.
5. Dispatch is attempted in parallel for each eligible channel.

## Email delivery

Email can be delivered in two modes:

### Immediate email

Sent straight away via SMTP. The notification row is updated with
`emailDeliveryStatus = 'pending'` before dispatch, then `'sent'` on
success or `'failed'` on failure.

### Digest (daily / weekly)

Users may configure a digest frequency (`digestFrequency` column on
`notification_preferences`). When a user has `digestFrequency =
'daily'` or `'weekly'` for a given notification type:

- No immediate email is sent.
- `sentAt` is left `null` so the digest job can pick it up.
- `emailDeliveryStatus` is left `null` (not `'pending'`) — this is
  **critical** because a `'pending'` status would incorrectly imply a
  delivery attempt was made.

#### `emailDeferredToDigest` ordering (hotfix P1)

The digest-preference query **must** run before the
`initUpdates` block that sets delivery statuses. In the initial
implementation, `emailDeferredToDigest` was initialised to `false` and
the `initUpdates` block ran before the preference query, causing every
email-enabled notification to be marked `emailDeliveryStatus =
'pending'` even when it was deferred to a digest.

**Fix**: The `emailDeferredToDigest` query was moved above the
`initUpdates` block (commit `dd2a41f9a0`). The `initUpdates` block now
correctly skips email when `emailDeferredToDigest === true`.

### Digest send job (`sendDigest`)

The `sendDigest(frequency)` method:

1. Finds all users with at least one unsent notification in this company.
2. For each user, checks `notification_preferences` for a matching
   `digestFrequency` preference.
3. Queries up to 50 pending (`sentAt IS NULL`) notifications, ordered by
   `createdAt` (ascending — oldest first).
4. Renders and sends a single digest email containing all pending items.
5. On success, bulk-updates all delivered notifications with
   `sentAt = now` and `emailDeliveryStatus = 'sent'`.

**Note**: The pending-query includes `.orderBy(notifications.createdAt)`
to ensure deterministic ordering. Without it, the same set of pending
notifications could be ordered differently across digest runs (commit
`953249ae19`).

## Web push delivery

Web push notifications are dispatched immediately via the web-push
protocol. The notification row is updated with `pushDeliveryStatus =
'pending'` before dispatch, then `'sent'` or `'failed'`.

## Notification preferences

The `notification_preferences` table stores per-user, per-type, per-channel
settings:

| Column | Type | Notes |
|---|---|---|
| `company_id` | uuid | FK → companies |
| `user_id` | uuid | FK → auth_users |
| `notification_type` | text | e.g. `mention`, `issue_update` |
| `channel` | text | `email` or `webpush` |
| `enabled` | boolean | |
| `digest_frequency` | text | `null`, `daily`, or `weekly` |

## Configuration

| Constant | Env var | Default | Description |
|---|---|---|---|
| `SMTP_CONVERSATION_TIMEOUT_MS` | `PAPERCLIP_SMTP_TIMEOUT_MS` | 30000 | SMTP conversation timeout |
| `WEB_PUSH_TTL_SECONDS` | `PAPERCLIP_WEB_PUSH_TTL_SECONDS` | 86400 | Web push TTL (seconds) |
| `DEFAULT_SMTP_PORT` | `PAPERCLIP_SMTP_DEFAULT_PORT` | 587 | Default SMTP port |

## Known issues

| # | Issue | Status | Workaround |
|---|---|---|---|
| 1 | Digest sends at most 50 pending notifications | Current design | No workaround; run sendDigest more frequently |
| 2 | No per-user unsubscribe link in email template | Current design | User must update preferences in-app |
| 3 | SMTP failures are logged but not retried | Current design | Failed notifications remain in `failed` status |

## Version history

| Date | Version | Changes |
|---|---|---|
| 2026-08-20 | v1 | Initial documentation. Document `emailDeferredToDigest` ordering fix, digest `.orderBy()` fix |
