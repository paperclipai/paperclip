# @paperclipai/plugin-slack

Two-way Slack integration for [Paperclip](https://github.com/paperclipai/paperclip). Each AI agent gets its own Slack bot identity — they post updates to channels, respond in threads, receive tasks as DMs or `@mentions`, and stay in sync with issues, comments, and status changes in both directions.

---

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Slack app setup](#slack-app-setup)
- [Configuration](#configuration)
- [Channel mappings](#channel-mappings)
- [Inbound: Socket Mode vs Events API](#inbound-socket-mode-vs-events-api)
- [Emoji → status shortcuts](#emoji--status-shortcuts)
- [Development](#development)
- [Architecture notes](#architecture-notes)

---

## What it does

### Slack → Paperclip

| Slack action | Paperclip result |
|---|---|
| `@mention` a bot in any channel | Creates an issue assigned to that agent |
| DM a bot directly | Creates an issue assigned to that agent |
| Reply in a tracked thread | Adds a comment to the linked issue |
| Add a reaction to a tracked message | Updates the issue status (see [emoji map](#emoji--status-shortcuts)) |

### Paperclip → Slack

| Paperclip event | Slack action |
|---|---|
| Issue created | Posts a Block Kit card to the mapped channel |
| Comment added | Replies in the issue's Slack thread using the author's bot token |
| Issue status changed | Posts a status update to the issue's Slack thread |

---

## How it works

```
Slack (inbound)
  │
  ├─ Socket Mode (WebSocket, no public URL needed — good for local / Docker)
  └─ Events API  (POST webhook — for production deployments with a public URL)
       │
       ▼
  onWebhook() / socket-mode.ts
       │
       ├─ app_mention  ──► create issue
       ├─ message (DM) ──► create issue
       ├─ message (thread reply) ──► add comment
       └─ reaction_added ──► update status

Paperclip (outbound)
  │
  ├─ issue.created ──► chat.postMessage (Block Kit card)
  ├─ issue.comment.created ──► chat.postMessage (thread reply)
  └─ issue.updated (status) ──► chat.postMessage (thread reply)
```

State is stored in `ctx.state` (instance-scoped):

| Key | Contents |
|---|---|
| `thread:{issueId}` | `{ channelId, threadTs, slackUrl, createdAt }` |
| `rev:{channelId}:{threadTs}` | `issueId` — reverse lookup |
| `msg:{commentId}` | Slack message `ts` — for future edits |
| `dedup:{eventId}` | Boolean — deduplication of Slack events |

---

## Prerequisites

- Paperclip instance (self-hosted)
- One Slack app per agent. Each app needs:
  - A **Bot Token** (`xoxb-…`) with scopes: `chat:write`, `channels:read`, `channels:history`, `reactions:write`, `im:history`, `im:write`
  - For **Socket Mode**: one **App-Level Token** (`xapp-…`) with scope `connections:write` (one token is enough per workspace, shared across all apps)
  - For **Events API**: a public HTTPS URL to receive webhooks

---

## Install

Build the plugin and install it into your Paperclip instance:

```sh
# From the repo root
pnpm --filter @paperclipai/plugin-slack build

# Install via CLI
pnpm paperclipai plugin install ./packages/plugins/plugin-slack
```

Or install it from the Paperclip plugin manager UI by pointing at the local path.

---

## Slack app setup

For each agent bot:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch
2. **OAuth & Permissions** → Bot Token Scopes → add:
   - `chat:write`
   - `channels:read`
   - `channels:history`
   - `reactions:write`
   - `im:history`
   - `im:write`
   - `app_mentions:read`
3. **Install to Workspace** → copy the **Bot OAuth Token** (`xoxb-…`)
4. Note the **Signing Secret** from **Basic Information** (used for Events API verification)
5. Invite each bot to the channels it should monitor: `/invite @BotName`

**For Socket Mode** (recommended for local/Docker setups):

6. **Settings → Socket Mode → Enable Socket Mode**
7. **Features → App-Level Tokens → Generate** — name it anything, scope: `connections:write`
8. Copy the `xapp-…` token (one per workspace is enough, share it across all agents)

**For Events API** (production with public URL):

6. **Features → Event Subscriptions → Enable Events**
7. Set Request URL: `https://YOUR_HOST/api/plugins/plugin-slack/webhooks/slack-events`
8. Subscribe to bot events: `message.channels`, `message.im`, `reaction_added`, `app_mention`

---

## Configuration

Configure the plugin in **Paperclip → Settings → Plugins → plugin-slack → Configure**.

### Full config schema

```jsonc
{
  // Optional: xapp-… App-Level Token.
  // When set, the plugin connects via Socket Mode (persistent WebSocket).
  // When omitted, the plugin listens for events via the Events API webhook.
  "appToken": "xapp-1-...",

  // Optional: Global fallback signing secret.
  // Per-agent secrets (see below) are tried first; this is used if none match.
  // Only relevant for Events API mode.
  "signingSecret": "",

  // Paperclip agent ID to use when no agent-specific match is found
  // (e.g. for DMs where the bot identity isn't deterministic).
  "defaultAgentId": "uuid-of-your-default-agent",

  // One entry per Slack bot / Paperclip agent pair.
  "agents": [
    {
      // Paperclip agent UUID
      "agentId": "...",

      // Bot OAuth Token (xoxb-…)
      "botToken": "xoxb-...",

      // Bot's Slack user ID (Uxxxxxxx) — used for echo prevention so the
      // plugin doesn't react to its own messages. Find via auth.test or the
      // token health job logs.
      "botUserId": "U...",

      // Human-readable label shown in logs and UI
      "displayName": "Aria (CMO)",

      // Signing secret for this specific Slack app — used to verify
      // incoming Events API webhooks. Found under Basic Information in
      // the Slack app settings.
      "signingSecret": "abc123..."
    }
  ],

  // Map Slack channels to Paperclip projects.
  // Issues created from messages in a mapped channel are assigned to that project.
  // Issues created in Paperclip and posted to Slack use this mapping to find
  // the right channel.
  "channelMappings": [
    {
      "slackChannelId": "C...",
      "channelName": "engineering",        // human-readable label for logs/UI
      "paperclipProjectId": "uuid-..."     // leave "" for board-level channels
    }
  ]
}
```

---

## Channel mappings

Channel mappings control the bidirectional project ↔ channel link:

- **Paperclip → Slack**: when an issue is created in a project, the plugin posts its card to the mapped Slack channel.
- **Slack → Paperclip**: when a message triggers issue creation (via `@mention` or DM), the issue is assigned to the mapped project.

Channels without a `paperclipProjectId` (empty string) receive board-level updates and are not linked to a specific project. Use these for executive/summary channels.

To find a channel's ID: open the channel in Slack web, the URL ends in `/CXXXXXXXXXX` — that `C…` value is the channel ID.

---

## Inbound: Socket Mode vs Events API

| | Socket Mode | Events API |
|---|---|---|
| **How** | Persistent WebSocket (outbound from your server) | POST webhook (inbound from Slack) |
| **Public URL needed** | No | Yes (HTTPS) |
| **Setup** | Set `appToken` in config | Configure Request URL in Slack app |
| **Best for** | Local dev, Docker, private networks | Production cloud deployments |
| **Reconnects** | Automatic (exponential backoff) | N/A |

Both modes feed events into the same handlers. You can switch between them by adding or removing `appToken` from the config — the change takes effect immediately without a restart.

---

## Emoji → status shortcuts

Add any of these reactions to a Slack message that's linked to a Paperclip issue to update the issue status:

| Emoji | Slack name | Status |
|---|---|---|
| ✅ | `:white_check_mark:` | `done` |
| 🚫 | `:no_entry_sign:` | `cancelled` |
| 🔄 | `:arrows_counterclockwise:` | `in_progress` |
| 👀 | `:eyes:` | `in_review` |
| 🔴 | `:red_circle:` | `blocked` |

---

## Development

```sh
# Type-check and bundle (worker + UI)
pnpm --filter @paperclipai/plugin-slack build

# Type-check only (no emit)
pnpm --filter @paperclipai/plugin-slack typecheck
```

The build produces:

| Output | Description |
|---|---|
| `dist/worker.js` | Self-contained esbuild bundle — runs in Node, no external deps needed |
| `dist/manifest.js` | Plugin manifest (capabilities, schema, jobs, webhooks, UI slots) |
| `dist/ui/index.js` | UI components (Settings page, Issue tab, Comment annotation) |

The worker is bundled with esbuild so it runs correctly inside Docker or any environment without access to the monorepo's `node_modules`.

### Volume mount for local Docker

If running Paperclip in Docker and developing the plugin locally, add the plugin directory as a read-only volume mount so the container can access the built worker:

```yaml
# docker-compose.yml
services:
  server:
    volumes:
      - ./packages/plugins/plugin-slack:/path/to/plugin-slack:ro
```

### Scheduled jobs

| Job | Schedule | What it does |
|---|---|---|
| `token-health` | Hourly | Calls `auth.test` for every configured bot token and logs pass/fail |
| `channel-sync` | Daily | Refreshes the Slack channel list cache used by the settings UI |

---

## Architecture notes

**No external Slack SDK.** The plugin uses `ctx.http.fetch` (the host-auditable HTTP client from the plugin SDK) for all Slack Web API calls. The only Slack-specific code is in `src/slack-client.ts`. This keeps the bundle small and keeps all outbound traffic visible to the host.

**Per-agent bot tokens.** Each agent uses its own `xoxb-` token when posting to Slack. Outbound messages feel like they come from the right person, not a single shared bot.

**Echo prevention.** Incoming Slack events are checked against the list of known bot user IDs. Events from our own bots are silently dropped to prevent feedback loops.

**Deduplication.** Every incoming Slack event is checked against a short-lived dedup index in `ctx.state` before processing. Slack occasionally delivers the same event twice; this prevents duplicate issues or comments.

**Thread continuity.** The mapping between Paperclip issue IDs and Slack thread timestamps is stored bidirectionally in `ctx.state`, so replies and status updates always land in the right thread regardless of which direction the conversation started.

---

## License

MIT — see [LICENSE](../../../LICENSE) at the repo root.
