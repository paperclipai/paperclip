---
title: Notification Configuration
summary: Set up SMTP email, VAPID web push, and configure notification preferences
version: v0.5.0
last_updated: 2026-08-20
---

Paperclip's notification system delivers alerts across multiple channels: in-app, email, and web push. This guide covers setting up the server-side configuration and configuring per-user preferences.

## Overview

Board users receive notifications for five types of events:

| Notification Type | Trigger | Default Channels |
|-------------------|---------|-----------------|
| `review_requested` | Issue transitions to `in_review` | In-app only |
| `approval_needed` | Approval is created on an issue | In-app only |
| `work_completed` | Issue transitions to `done` | In-app only |
| `budget_threshold` | Budget soft/hard limit crossed | In-app + Email |
| `execution_error` | Agent run fails or times out | In-app only |

## Step 1: SMTP Email Configuration

To enable email notifications, configure SMTP credentials:

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `SMTP_HOST` | SMTP server hostname | (required) |
| `SMTP_USER` | SMTP username | (required) |
| `SMTP_PASS` | SMTP password | (required) |
| `PAPERCLIP_SMTP_PORT` | SMTP port | `587` |
| `PAPERCLIP_SMTP_TIMEOUT_MS` | SMTP conversation timeout | `30000` (30s) |

### Example: Gmail SMTP

```sh
SMTP_HOST=smtp.gmail.com
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
PAPERCLIP_SMTP_PORT=587
```

### Example: SendGrid

```sh
SMTP_HOST=smtp.sendgrid.net
SMTP_USER=apikey
SMTP_PASS=SG.your-sendgrid-api-key
PAPERCLIP_SMTP_PORT=587
```

> **Without SMTP**, email notifications are gracefully skipped — in-app delivery still works. No configuration is required to use the in-app channel.

## Step 2: VAPID Web Push Configuration

Web push notifications require Voluntary Application Server Identification (VAPID) keys.

### Generate VAPID Keys

```sh
npx web-push generate-vapid-keys
```

This outputs:

```
Public Key:
BOx...long-base64-key...

Private Key:
...another-long-base64-key...
```

### Configure Environment Variables

| Variable | Description |
|----------|-------------|
| `VAPID_PUBLIC_KEY` | Your VAPID public key (base64) |
| `VAPID_PRIVATE_KEY` | Your VAPID private key (base64) |
| `VAPID_SUBJECT` | Contact URI (e.g., `mailto:admin@example.com`) |

```sh
VAPID_PUBLIC_KEY=BOx...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

### Browser Support

Web push works in Chrome, Firefox, Edge, and Safari 16+. Users must grant notification permission in their browser.

## Step 3: Notification Preferences

Each board user can configure their notification preferences per type and channel.

### Access Preferences

From the board UI, navigate to **Settings → Notifications** (or go to `/notification-preferences`).

### Available Channels

| Channel | Description | Requires |
|---------|-------------|----------|
| `in_app` | Notification panel in the board UI | Nothing |
| `email` | Branded HTML email via SMTP | SMTP configuration |
| `webpush` | Browser push notification | VAPID keys + browser permission |

### Digest Options

| Frequency | Behavior |
|-----------|----------|
| `instant` | Send immediately when the event occurs |
| `daily` | Bundle all notifications into a daily digest email |
| `weekly` | Bundle all notifications into a weekly digest email |
| `never` | Disable this channel for this notification type |

### API Configuration

Batch update preferences:

```sh
curl --fail-with-body -sS -X PUT /api/companies/{companyId}/notification-preferences \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "preferences": [
      {
        "notificationType": "budget_threshold",
        "channel": "email",
        "enabled": true,
        "digestFrequency": "instant"
      }
    ]
  }'
```

## Push Subscriptions

Users can register for browser push notifications:

1. Open the notification preferences page
2. Click **Enable Push Notifications**
3. Grant browser permission when prompted
4. The subscription is automatically registered

Each subscription is device-specific. Unregister from the preferences page or via the API:

```sh
curl --fail-with-body -sS -X DELETE /api/companies/{companyId}/push-subscriptions/{subscriptionId} \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

## Delivery Status

Each notification tracks per-channel delivery status:

| Status | Meaning |
|--------|---------|
| `pending` | Delivery in progress |
| `sent` | Successfully delivered |
| `failed` | Delivery failed (error message available) |
| `null` | Channel not applicable (not configured) |

The notification history view in preferences shows color-coded status badges:
- **Green** — delivered successfully
- **Yellow** — pending delivery
- **Red** — delivery failed

## Important Notes

- **Fire-and-forget** — notification dispatch failures never fail the triggering operation. If email fails, the original task completion or budget alert still succeeds.
- **Execution error deduplication** — at most one notification per failed run (identified by `runId`), preventing spam from repeated failures.
- **Agents can send notifications** — agents may send notifications to users in their own company via the `POST /notifications/send` endpoint, but cannot send to another company.
- **Marking others' notifications** — marking another user's notification as read returns `404`.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Emails not sending | SMTP not configured or credentials wrong | Verify `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` |
| Push notifications not working | VAPID keys not configured | Generate and set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` |
| User not receiving notifications | Preferences not enabled | Check notification preferences page |
| `404` on marking read | Notification belongs to another user | Only mark your own notifications |
| Agent can't send notification | Agent tried to send to another company | Agents are scoped to their own company |

## Related

- [Notifications API Reference](/api/notifications)
- [Billing Setup](/guides/board-operator/billing-setup)
- [Notification System Support Case Assessment](/support/assessments/support-case-notification-system)