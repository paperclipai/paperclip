# Telegram Notifier — Paperclip plugin

Pushes Paperclip approvals, issue assignments, comments, run failures, budget incidents, and wake requests to Telegram — with formatted MarkdownV2 messages, contextual deep-link buttons, a token + verification-code pairing flow, and bidirectional `/new` and `/inbox` commands.

**Pair one Telegram chat per company** in your Paperclip instance. Each chat receives notifications and accepts commands only for its own company; routing happens automatically based on `event.companyId` and a chat-to-company reverse lookup.

## What it sends

| Event | Trigger | Message contents | Action button |
|---|---|---|---|
| Approval | `approval.created` | 🛂 title, requester, reason | Decide approval → |
| Assignment | `issue.updated` (assignee changed) | 📥 identifier, title, status, who handed off | Open issue → |
| Comment | `issue.comment.created` | 💬 identifier, issue title, author, body preview | Open issue → |
| Run failure | `agent.run.failed` | ⚠️ agent, issue, reason | Open issue · Open agent |
| Budget | `budget.incident.opened` | 💸 subject, severity, reason | — |
| Wake | `issue.assignment_wakeup_requested` | 🔔 identifier, title, reason | Open issue → |

Most action buttons are URL deep-links into the Paperclip dashboard. The exception is plan confirmations (`request_confirmation` interactions): they carry **Approve** / **Decline** buttons that resolve the confirmation from Telegram. Only the authorized approver can press them — the Telegram user set as approver for the company, or by default the operator who paired the chat. A confirmation message carries the issue title and link, not the prompt text, and is sent only when the plugin may read the issue in that company. No board API key is stored in the plugin.

## Morning digest

Optional daily summary sent to each paired chat at a configurable hour. The digest is company-wide (not limited to the operate-as agent) and is sent only to companies that have an operate-as agent set. It includes:

- **Completed yesterday** — the company's issues marked `done` in the last ~36 hours
- **In progress** — the company's `in_progress` issues
- **Todo** — the company's `todo` issues

Each section is read by status, up to 1000 issues, and shows six bullets with a `+N more` hint; a section that hit the 1000 cap says so. The digest piggy-backs on the same minute-tick polling job (no extra cron entry); the schedule is fully driven by config: enable, pick an hour, optionally restrict to weekdays. Times are server local time, deduped per company by `YYYY-MM-DD` so a Paperclip restart inside the digest hour won't double-send.

Disabled by default — turn it on under **Plugins → Telegram Notifier → Morning digest**.

## Pairing — per company, token in, code out, paste back

The handshake requires control of *both* ends, so neither half on its own is enough to hijack notifications. Each company is paired separately:

The settings page works on the company selected in the dashboard. Plugin config is stored per company, so switch the company in the dashboard to configure another one.

1. Store the bot token from `@BotFather` as a company secret (**Company settings → Secrets**). Then install the plugin, select that secret in **Settings → Telegram Notifier → Telegram bot token secret**, and click **Save**. The plugin keeps only the secret reference and resolves the token when it calls Telegram; a literal token is not accepted. Companies can use the same bot or different bots.
2. On the company card, click **Start pairing**. The plugin enters `awaiting_chat` mode for 10 minutes. Only one handshake runs at a time per instance; while another company is pairing, **Start pairing** is disabled until that window ends.
3. Open your bot in Telegram and send any message. The bot replies with a 6-character verification code addressed to that company. In a group, the bot sends the code to the sender's private chat instead, so press **Start** in a private chat with the bot first; that sender becomes the chat's operator. If the bot cannot reach the sender privately, it posts the code in the group and the group has no operator: Approve/Decline, replies and `/unpair` from the group stay off until you pair again.
4. Paste the code into the **Confirm pairing** input back in Paperclip. The bot sends a confirmation in Telegram, the company card shows ✅ paired. The Paperclip user who confirms is recorded as the chat's operator (see *Replies* below).
5. Click **Edit** and pick the operate-as agent for that company so `/new`, `/inbox`, and the morning digest can attribute and assign work correctly. Different companies can have different operate-as agents.
6. Repeat for each company you want covered.

Agents for the dropdown are listed via the plugin bridge (`ctx.agents.list({ companyId })`).

To re-pair: click **Unpair** on the row (or run `/unpair` from the chat), then **Start pairing** again.

**Who can act in a group.** Only the chat's operator, or the company's explicit Telegram approver, can write to Paperclip from a group: `/new`, 👤 *Reassign*, and 💬 *Reply*. Other members still get every notification and can use `/inbox`, `/status`, and 📄 *Show full*; a write attempt from them gets a one-line refusal and changes nothing.

## Bot commands

The bot publishes these via `setMyCommands` so they show up in the Telegram command menu. The bot infers which company a command applies to from the chat's pairing — no `/use` switching needed:

| Command | What it does | Requires |
|---|---|---|
| `/help` | List all commands | — |
| `/status` | Show pairing status for this chat | — |
| `/start` | Send during a pairing handshake to receive the code | active handshake |
| `/test` | Send yourself a sample notification | paired |
| `/unpair` | Disconnect this chat from its company | paired |
| `/new <title>` (single line) | Create an issue with just a title | paired + operate-as agent set; in a group, the operator |
| `/new <title>\n<description…>` (multi-line) | Create an issue with a title and a multi-line description; description is rendered as markdown in Paperclip | paired + operate-as agent set; in a group, the operator |
| `/inbox` | Show the 5 most recent issues assigned to the operate-as agent | paired + operate-as agent set |

After `/new` succeeds the bot replies with a confirmation card that has a 👤 *Reassign* callback button. Tapping it swaps the keyboard to a list of agents in that company — pick one and the issue is reassigned in Paperclip without leaving Telegram.

Comment notifications include a 💬 *Reply* button that prompts you for text (Telegram's force-reply); send the reply and the plugin posts it back as a comment on the same issue. Only the operator who paired the chat (or the company's explicit Telegram approver) can reply; replies from other chat members are ignored. The operator's reply is posted as the Paperclip user who confirmed the pairing, so the issue's assignee wakes up exactly as for a dashboard comment. If that user was not recorded or cannot post, the reply is attributed to the operate-as agent and does not wake the assignee. If the comment body is too long for one Telegram message, the notification gets a 📄 *Show full* button that fetches the rest in chunks. You can also use Telegram's standard quote-reply on the notification — the plugin treats both paths identically.

## Configuration

Stored per company (the host keeps one plugin config row per company):

| Field | Type | Notes |
|---|---|---|
| `botToken` | secret reference | Paperclip secret that holds the Bot API token from `@BotFather`, stored as `{ "type": "secret_ref", "secretId": "<secret uuid>" }`. A literal token is rejected on save. A literal token saved by an earlier version is never used: the plugin stops polling and sending for that company and the settings page asks for a secret. |
| `paperclipBaseUrl` | string | Base URL used to build dashboard deep-links. Default `http://localhost:3100`. |
| `notifyOn.{approvals,assignedToYou,comments,runFailures,budgetIncidents,wakeRequests}` | boolean | Toggle each event class. All default `true`. |
| `morningDigest.enabled` | boolean | Daily digest opt-in. Default `false`. |
| `morningDigest.hour` | integer 0–23 | Hour of day, server local time. Default `8`. |
| `morningDigest.weekdaysOnly` | boolean | Skip Saturdays and Sundays. Default `true`. |
| `silent` | boolean | Send messages without sound. Default `false`. |

`botToken` is optional so that **Disconnect** can clear it; a company without a token is skipped. Pairing state, operate-as agents, and plan-approval settings are managed on the plugin's settings page (not the JSON-schema form) so they require no UUID hunting.

## Tools

Six agent tools (namespaced under `paperclip.telegram-notifier`), useful for headless setups, scripts, and agent workflows. Every tool acts on the **calling agent's own company** (from the host's run context). A `companyId` argument is not needed; if one is passed it must be the caller's company, otherwise the tool returns an error.

- `telegram.get_status` — returns the bot username, this company's paired chat, and its in-flight handshake (never the verification code).
- `telegram.start_pairing` — begins a handshake for this company.
- `telegram.confirm_pairing` — completes pairing with `{ code: "XXXXXX" }` when the active handshake is for this company.
- `telegram.unpair` — disconnects this company's chat.
- `telegram.send_test` — sends a sample notification to this company's chat.
- `telegram.get_approval_config` — returns the plan-approval approver and whether the calling agent (or the agent named by the optional `{ agentId }`) must gate plans before acting.

## Capabilities

The plugin requests a deliberately narrow surface:

- `events.subscribe` — receive the six event types listed above.
- `jobs.schedule` — register the polling job that fetches Telegram updates, handles slash commands, and fires the morning digest.
- `http.outbound` — call `api.telegram.org` for outbound messages and `getUpdates` long-polling.
- `secrets.read-ref` — resolve the `botToken` secret reference at use time.
- `plugin.state.read` / `plugin.state.write` — store the per-company pairing map and per-message callback context.
- `companies.read` — read the selected company's name for the settings card and pairing messages.
- `agents.read` — populate the Operate-as-agent dropdown and enrich run-failure notifications.
- `issues.read` / `issues.create` / `issues.update` — list the inbox, create issues from `/new`, and reassign via the inline picker.
- `issue.comments.read` — read the full comment body and author when building comment notifications.
- `issue.comments.create` — post a Paperclip comment when the chat's operator replies to a comment notification in Telegram.
- `issue.comments.create_human_attributed` — post the pairing operator's replies as the Paperclip user who confirmed the pairing, so the assignee wakes up.
- `agent.tools.register` — expose the six agent tools.
- `instance.settings.register` — render the settings page.

The plugin does not pause/resume agents or store any board API key. The only decisions it takes from Telegram are plan confirmations, and only from the authorized approver; everything else goes through deep-links to the dashboard.

## Architecture

```
┌─────────────┐     events.subscribe        ┌────────────────┐
│ Paperclip   │  ──────────────────────►    │ telegram-notif │
│ event bus   │     (filtered by            │   worker       │
└─────────────┘      event.companyId)       └────────┬───────┘
                                                      │ http.outbound (sendMessage)
                                                      ▼
                                              ┌──────────────┐
                                              │ Telegram     │
                                              │ Bot API      │
                                              └──────┬───────┘
                                                     │ /start, /test, /new, /inbox …
                                                     ▼
┌─────────────┐    jobs.schedule (* * * * *) ┌────────────────┐
│ Paperclip   │  ──────────────────────►    │ pollUpdates    │
│ scheduler   │     getUpdates → route      │   + digest     │
└─────────────┘     by chat → company       └────────────────┘
```

Outbound notifications are sent only to the chat paired with the event's `companyId`, using that company's config. The poll job reads the config of each paired company (and of the company with an in-flight handshake) and polls each distinct bot once. Inbound messages and slash commands are routed via reverse lookup (Telegram chat → paired company → operate-as agent); a chat paired to a company that uses a different bot is ignored. Polling uses long-polling (`timeout=20s`) inside a 55-second loop per cron tick: Telegram answers as soon as an update arrives, so callback-button taps and replies are processed within seconds, well under Telegram's 60-second `callback_query` expiry.

### Why the plugin polls

Telegram delivers bot updates either by webhook or by `getUpdates`. A webhook needs a public HTTPS endpoint, which local-trusted and self-hosted instances usually do not have, and the plugin platform has no inbound webhook route for this plugin, so `getUpdates` is the only ingress. This is the external-source exception in `rules/sleep-aware-background-work.mdc`:

- **Active scope:** only bots of companies that are paired or have a live pairing handshake. Without one, a tick reads plugin state once and stops; it makes no Telegram request and resolves no secret.
- **Cadence:** one minute-tick job; inside it, long polls of up to 20 seconds (about three requests per idle minute per bot). Outbound notifications are event-driven and do not poll.
- **Stop condition:** unpair every company (or clear the bot token secret) and the job stops contacting Telegram.
- **Sleep impact:** while a company is paired, the job keeps the worker and the host awake and makes outbound network calls every minute. A paired instance cannot idle until the platform offers an inbound webhook route for plugins.

### URL fallbacks for non-public Paperclip instances

Telegram rejects `http://` and private-host URLs in inline-keyboard buttons (`Bad Request: Wrong HTTP URL`). When a notification is built against a non-public `paperclipBaseUrl` (e.g. `http://localhost:3100`), the plugin transforms each URL button into a code-span URL embedded in the message text — the URL is visible and copyable, and most Telegram clients let you tap-and-hold to open. To get native inline-keyboard buttons, expose Paperclip behind an HTTPS tunnel (`ngrok`, `cloudflared`, etc.) and set `paperclipBaseUrl` accordingly.

## Development

```bash
pnpm --filter @paperclipai/plugin-telegram-notifier typecheck
pnpm --filter @paperclipai/plugin-telegram-notifier build
pnpm --filter @paperclipai/plugin-telegram-notifier test
```

After build, `dist/manifest.js`, `dist/worker.js`, and `dist/ui/` are the entrypoints declared in the manifest. Install with the CLI:

```bash
paperclipai plugin install ./packages/plugins/paperclip-plugin-telegram-notifier
```

## License

MIT.
