# Telegram Relay Plugin (Example)

Bridge incoming Telegram messages to Paperclip issue comments in real time. When a message arrives, it's posted as a comment on a designated "Inbound" issue, triggering the assigned agent's heartbeat so it wakes up and processes the message immediately.

## How it works

```
Telegram user → sends message → relay posts comment on "Inbound" issue
                                       ↓
                              agent heartbeat fires → agent wakes up and responds
                                       ↓
                              pulse reply sent back → "Got it — on it now."
```

The relay sends a quick acknowledgment ("pulse") back to Telegram so the user knows their message was received while the agent starts working.

## Setup

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`. Save the API token.

### 2. Get your chat ID

Send any message to your new bot, then run:

```bash
curl https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

The `chat.id` field in the response is your chat ID.

### 3. Create the "Inbound" relay issue

Create a persistent issue in Paperclip that will receive all Telegram messages as comments. Assign it to the agent you want to wake (e.g. the CEO):

```bash
curl -X POST http://127.0.0.1:3100/api/companies/<COMPANY_ID>/issues \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Inbound — Telegram Messages",
    "description": "Each incoming Telegram message is posted here as a comment to wake the assigned agent.",
    "status": "in_progress",
    "priority": "high",
    "assigneeAgentId": "<AGENT_ID>"
  }'
```

Save the issue `id` from the response.

### 4. Run the real-time relay

The `relay.mjs` script uses Telegram long-polling for instant delivery (no cron delay):

```bash
TELEGRAM_BOT_TOKEN=<your-bot-token>    \
TELEGRAM_CHAT_ID=<your-chat-id>        \
RELAY_ISSUE_ID=<issue-uuid>            \
PAPERCLIP_API_KEY=<your-api-key>       \
AGENT_MENTION=@CEO                     \
node relay.mjs
```

> **Note:** `PAPERCLIP_API_KEY` is optional in local trusted mode (no auth required) but required for authenticated Paperclip deployments. See the [Authentication docs](https://docs.paperclip.dev/authentication) for details on creating agent API keys.

The `AGENT_MENTION` variable is optional — when set, comments include an `@AgentName` mention which triggers a heartbeat for that specific agent.

To run it in the background:

```bash
nohup node relay.mjs > relay.log 2>&1 &
```

### 5. (Optional) Install the plugin for cron-based fallback

The plugin provides a cron job that polls Telegram every 2 minutes as a safety net in case the relay script goes down.

Install the plugin from a local path:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{
    "packageName": "/path/to/plugin-telegram-relay-example",
    "isLocalPath": true
  }'
```

Then configure it:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/config \
  -H "Content-Type: application/json" \
  -d '{
    "configJson": {
      "telegramBotToken": "<your-bot-token>",
      "telegramChatId": "<your-chat-id>",
      "relayIssueId": "<issue-uuid>",
      "agentMention": "@CEO"
    }
  }'
```

## Environment variables (relay.mjs)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Telegram chat ID to monitor |
| `RELAY_ISSUE_ID` | Yes | — | Paperclip issue UUID for the "Inbound" relay issue |
| `PAPERCLIP_BASE` | No | `http://127.0.0.1:3100` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | No | — | Bearer token for authenticated Paperclip deployments (not needed in local trusted mode) |
| `AGENT_MENTION` | No | — | `@AgentName` to include in comments for heartbeat triggers |

## Security notes

- **Bot token in URLs:** The Telegram bot token is included in `getUpdates` API URLs. If an error is logged (e.g. via `console.error` or `ctx.logger.error`), the token may appear in log output. Keep your log files protected and avoid piping relay output to shared dashboards.
- **Token storage:** The plugin stores the bot token in Paperclip's plugin config (plaintext). For production deployments, consider moving it to Paperclip's secrets store and referencing it via `ctx.secrets.resolve()`.

## Architecture notes

- **Long-polling vs webhooks:** This example uses Telegram long-polling (`getUpdates` with `timeout=30`) rather than webhooks. This avoids needing a public URL or TLS certificate, making it ideal for local Paperclip instances.
- **Pulse acknowledgment:** The relay sends a random short confirmation message back to the Telegram user immediately, so they know the message was received before the agent starts processing.
- **Cursor persistence:** Both the relay script (in-memory) and the plugin (via `ctx.state`) track a cursor so messages aren't double-posted across restarts.
- **The "Inbound" pattern:** A single persistent issue assigned to a top-level agent (like the CEO) acts as a message bus. The agent sees each new comment and can triage, delegate, or respond directly.
