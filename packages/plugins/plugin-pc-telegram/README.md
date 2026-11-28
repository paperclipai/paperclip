# @andhash/plugin-pc-telegram

Paperclip plugin for personal Telegram accounts.

This is not the Bot API `telegram` chat channel. It uses MTProto sessions in a plugin worker.

## What it does

- Operators store Telegram app credentials (`api_id` / `api_hash`) as secret-refs in plugin config.
- Company settings: Connect Telegram, show a QR code, and collect a cloud password once if needed.
- The worker stores the MTProto session as a per-account secret and reconnects after a worker restart.
- Connection fields: optional answering agent, incoming mode `dialog = task`, pause.
- Inbound DMs become or continue an issue and are assigned to the connection's agent when one is set.
- The assigned agent can send a text reply through the `telegram_send_text` plugin tool.

## Secrets

Session strings, `api_id`, `api_hash`, and cloud passwords never go into issues, comments, skills, logs, or the agent prompt. The cloud password is discarded after login.
