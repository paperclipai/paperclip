# Paperclip inbox Telegram notifier

This bridge polls Paperclip's inbox badge signal and sends Telegram notifications only when the inbox becomes actionable.

## What it uses

- Source signal: `GET /api/companies/:companyId/sidebar-badges`
- Script entrypoint: `scripts/paperclip-inbox-telegram-notifier.ts`
- Decision logic: `server/src/services/inbox-telegram-notifier.ts`
- Root package command: `pnpm run notify:paperclip-inbox-telegram`

## Behavior

The notifier reads the current sidebar badge snapshot and persists local state so it does not spam on every poll.

Notification rules:

- do not notify when inbox count is `0`
- notify on the first observed positive inbox count
- notify when a positive inbox count changes
- do not re-notify when the positive inbox count is unchanged

The message includes:

- company label
- current inbox count
- confirmation that the source is `sidebar-badges`
- breakdown of failed runs / alerts / join requests / approvals
- optional inbox URL
- observation timestamp

## Required environment variables

- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_TELEGRAM_BOT_TOKEN`
- `PAPERCLIP_TELEGRAM_CHAT_ID`

## Optional environment variables

- `PAPERCLIP_API_BASE` — defaults to `http://127.0.0.1:3100/api`
- `PAPERCLIP_COMPANY_LABEL` — display label in the Telegram message
- `PAPERCLIP_INBOX_URL` — link included in the message
- `PAPERCLIP_INBOX_STATE_FILE` — path to persisted anti-spam state

Default state path:

- `.runtime/paperclip-inbox-telegram-state.json`

## Example

```bash
PAPERCLIP_COMPANY_ID="cbc62b74-e2c6-43c5-ab0e-1310102cadb8" \
PAPERCLIP_TELEGRAM_BOT_TOKEN="<bot-token>" \
PAPERCLIP_TELEGRAM_CHAT_ID="8287422597" \
PAPERCLIP_COMPANY_LABEL="Emtesseract" \
PAPERCLIP_INBOX_URL="https://paperclip.example/inbox/recent" \
pnpm run notify:paperclip-inbox-telegram
```

## Verification

Targeted tests:

```bash
pnpm vitest run \
  server/src/__tests__/inbox-telegram-notifier.test.ts \
  server/src/__tests__/paperclip-inbox-telegram-notifier-script.test.ts
```

The package-script smoke test verifies that the root command works end-to-end against a stubbed `sidebar-badges` response and does not attempt Telegram delivery when the inbox count is unchanged.
