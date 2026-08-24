# VOY-1342 — Notification dispatch + UI + email templates

## State on Aug 18, 2026 (COO takeover from CTO handoff)

### Status: Code written, never committed, now tracked as PRA-893

The complete notification system exists as untracked/modified working tree files but was
never committed to git. The hotfix commit 727c14bc40 explicitly removed notification
code from the v0.4.0-alpha deploy scope because notifications.ts was uncommitted.

### What exists (working tree only)

| File | Status | Purpose |
|------|--------|---------|
| `server/src/services/notifications.ts` | untracked (849 lines) | Notification service: SMTP mailer, web push, prefs, digest, CRUD |
| `server/src/services/email-templates.ts` | untracked (182 lines) | Branded HTML email templates with escape-safe rendering |
| `server/src/services/email-templates.test.ts` | untracked (74 lines) | Tests for email template rendering |
| `ui/src/api/notifications.ts` | untracked (65 lines) | API client for notification endpoints |
| `ui/src/pages/NotificationPreferences.tsx` | untracked (278 lines) | Preferences UI page with toggle switches + digest selector |
| `server/src/routes/approvals.ts` | modified | Dispatch approval_needed on approval create |
| `server/src/routes/issues.ts` | modified | Dispatch review_requested / work_completed on status transitions |
| `server/src/services/budgets.ts` | modified | Dispatch budget_threshold on threshold cross |
| `server/src/services/heartbeat.ts` | modified | Dispatch execution_error on run failure |
| `server/src/services/index.ts` | modified | Exports notificationService |
| `ui/src/App.tsx` | modified | Route for /company/settings/notifications |

### What else is needed
- DB migration 0138 exists (schema for notifications tables)
- `@paperclipai/shared` exports NOTIFICATION_TYPES, NOTIFICATION_CHANNELS, etc.
- SMTP config vars (SMTP_HOST, SMTP_USER, SMTP_PASS) must be set in deployment env
- VAPID keys for web push (optional)
- `web-push` npm dep must be in server/package.json

### Current tracking
- Epic: PRA-892 (v0.5.0 — Market Readiness)
- Sub-issue: PRA-893 (Email/push notifications — commit and ship VOY-1342 code)
- Owner: Founding Engineer or CTO (engineering work)