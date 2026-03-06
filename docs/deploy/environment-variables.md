---
title: Environment Variables
summary: Full environment variable reference
---

All environment variables that Paperclip uses for server configuration.

## Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `HOST` | `127.0.0.1` | Server host binding |
| `DATABASE_URL` | (embedded) | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Base directory for all Paperclip data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance identifier (for multiple local instances) |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | Runtime mode override |
| `PAPERCLIP_CORS_ALLOWED_ORIGINS` | (empty) | Comma-separated explicit CORS origins (`https://app.example.com`) |
| `PAPERCLIP_RATE_LIMIT_ENABLED` | `true` | Enable/disable API rate limiting |
| `PAPERCLIP_RATE_LIMIT_WINDOW_MS` | `3600000` | Global API rate-limit window (ms) |
| `PAPERCLIP_RATE_LIMIT_MAX` | `100` | Global API rate-limit max requests per key/window |
| `PAPERCLIP_AUTH_RATE_LIMIT_WINDOW_MS` | `3600000` | Auth route rate-limit window (ms) |
| `PAPERCLIP_AUTH_RATE_LIMIT_MAX` | `30` | Auth route max requests per IP/window |
| `PAPERCLIP_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS` | `3600000` | Password-reset route rate-limit window (ms) |
| `PAPERCLIP_PASSWORD_RESET_RATE_LIMIT_MAX` | `3` | Password-reset route max requests per email/IP/window |
| `PAPERCLIP_AGENT_API_KEY_MAX_AGE_DAYS` | `90` | Maximum allowed age for agent API keys before forced rejection/revocation |

## Secrets

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | (from file) | 32-byte encryption key (base64/hex/raw) |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | Path to key file |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | Require secret refs for sensitive env vars |

## Agent Runtime (Injected into agent processes)

These are set automatically by the server when invoking agents:

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | Agent's unique ID |
| `PAPERCLIP_COMPANY_ID` | Company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Short-lived JWT for API auth |
| `PAPERCLIP_RUN_ID` | Current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | Issue that triggered this wake |
| `PAPERCLIP_WAKE_REASON` | Wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | Comment that triggered this wake |
| `PAPERCLIP_APPROVAL_ID` | Resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | Approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Comma-separated linked issue IDs |

## Telegram Notifications (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PAPERCLIP_TELEGRAM_BOT_TOKEN` | (empty) | Telegram bot token. When set, enables push notifications for approval requests, budget exhaustion, and stuck agent runs. Per-company chat IDs are stored as company secrets under the name `TELEGRAM_CHAT_ID`. |

## LLM Provider Keys (for adapters)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude Local adapter) |
| `OPENAI_API_KEY` | Optional OpenAI API key (for Codex Local adapter). Not required when using `codex login --device-auth` subscription auth. |
