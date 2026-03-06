---
id: paperclip-feature-telegram-notifications
title: Telegram Notifications
doc_type: spec
owner: paperclip
status: active
version: 1.0.0
updated: 2026-03-06
applies_to:
  - server
depends_on: []
related_docs:
  - /home/avi/projects/paperclip/docs/api/approvals.md
  - /home/avi/projects/paperclip/docs/deploy/environment-variables.md
toc: auto
---

Paperclip can push Telegram messages to a board member's chat when attention is needed, eliminating the need to poll the browser.

## Setup

1. Set `PAPERCLIP_TELEGRAM_BOT_TOKEN` in the server environment (the bot token from BotFather).
2. In the Paperclip UI, go to **Company Settings → Secrets** and add a secret named `TELEGRAM_CHAT_ID` with the Telegram chat ID to notify (e.g., a personal DM ID or group chat ID).

Each company routes to its own chat ID — different companies can notify different chats.

## Notification Events

| Event | Trigger | Payload |
|-------|---------|---------|
| **New Approval Required** | `POST /companies/:id/approvals` | Approval title, type, requesting agent name, approval ID |
| **Agent Budget Exhausted** | Agent `spentMonthlyCents >= budgetMonthlyCents` (costs service) | Agent name, agent ID |
| **Stuck Agent Run** | `sweepStuckRuns()` detects a queued/running run exceeding staleness threshold | Agent name, run ID, stale duration, reason (`queued_stale` or `running_no_progress`), issue ID if linked |

## Behavior

- All notifications are fire-and-forget — they never delay or block API responses.
- If the bot token is not set, the notification service is a no-op at startup.
- If the company has no `TELEGRAM_CHAT_ID` secret, notifications for that company are silently skipped.
- Errors (failed Telegram API calls, missing secret) are logged as `warn` and suppressed.

## Implementation

| File | Role |
|------|------|
| `server/src/services/notifications.ts` | Singleton service — `initNotifications(db)` / `getNotifications()` |
| `server/src/app.ts` | Initializes the service at startup |
| `server/src/routes/approvals.ts` | Fires `notifyApprovalCreated` on POST |
| `server/src/services/costs.ts` | Fires `notifyBudgetExhausted` when agent is paused |
| `server/src/services/heartbeat.ts` | Fires `notifyStuckRun` in `sweepStuckRuns()` |
