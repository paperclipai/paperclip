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

Most action buttons are URL deep-links into the Paperclip dashboard. The exception is plan confirmations (`request_confirmation` interactions): they carry **Approve** / **Decline** buttons that resolve the confirmation from Telegram. Only the authorized approver can press them — the Telegram user set as approver for the company, or by default the operator who paired the chat. No board API key is stored in the plugin.

## Morning digest

Optional daily summary sent to each paired chat at a configurable hour. The digest is company-wide (not limited to the operate-as agent) and is sent only to companies that have an operate-as agent set. It includes:

- **Completed yesterday** — the company's issues marked `done` in the last ~36 hours
- **In progress** — the company's `in_progress` issues
- **Todo** — the company's `todo` issues

Each section caps at six bullets with a `+N more` hint for longer lists. The digest piggy-backs on the same minute-tick polling job (no extra cron entry); the schedule is fully driven by config: enable, pick an hour, optionally restrict to weekdays. Times are server local time, deduped per company by `YYYY-MM-DD` so a Paperclip restart inside the digest hour won't double-send.

Disabled by default — turn it on under **Plugins → Telegram Notifier → Morning digest**.

## Pairing — per company, token in, code out, paste back

The handshake requires control of *both* ends, so neither half on its own is enough to hijack notifications. Each company is paired separately:

The settings page works on the company selected in the dashboard. Plugin config is stored per company, so switch the company in the dashboard to configure another one.

1. Install the plugin and paste your bot token in **Settings → Telegram Notifier → Telegram bot token**. After saving the token is masked (`1234567890:••••AAAA`); click the eye icon to reveal. Companies can use the same bot or different bots.
2. On the company card, click **Start pairing**. The plugin enters `awaiting_chat` mode for 10 minutes. Only one handshake runs at a time per instance; while another company is pairing, **Start pairing** is disabled until that window ends.
3. Open your bot in Telegram and send any message. The bot replies with a 6-character verification code addressed to that company.
4. Paste the code into the **Confirm pairing** input back in Paperclip. The bot sends a confirmation in Telegram, the company card shows ✅ paired. The Paperclip user who confirms is recorded as the chat's operator (see *Replies* below).
5. Click **Edit** and pick the operate-as agent for that company so `/new`, `/inbox`, and the morning digest can attribute and assign work correctly. Different companies can have different operate-as agents.
6. Repeat for each company you want covered.

Agents for the dropdown are listed via the plugin bridge (`ctx.agents.list({ companyId })`).

To re-pair: click **Unpair** on the row (or run `/unpair` from the chat), then **Start pairing** again.

## Bot commands

The bot publishes these via `setMyCommands` so they show up in the Telegram command menu. The bot infers which company a command applies to from the chat's pairing — no `/use` switching needed:

| Command | What it does | Requires |
|---|---|---|
| `/help` | List all commands | — |
| `/status` | Show pairing status for this chat | — |
| `/start` | Send during a pairing handshake to receive the code | active handshake |
| `/test` | Send yourself a sample notification | paired |
| `/unpair` | Disconnect this chat from its company | paired |
| `/new <title>` (single line) | Create an issue with just a title | paired + operate-as agent set |
| `/new <title>\n<description…>` (multi-line) | Create an issue with a title and a multi-line description; description is rendered as markdown in Paperclip | paired + operate-as agent set |
| `/inbox` | Show the 5 most recent issues assigned to the operate-as agent | paired + operate-as agent set |

After `/new` succeeds the bot replies with a confirmation card that has a 👤 *Reassign* callback button. Tapping it swaps the keyboard to a list of agents in that company — pick one and the issue is reassigned in Paperclip without leaving Telegram.

Comment notifications include a 💬 *Reply* button that prompts you for text (Telegram's force-reply); send the reply and the plugin posts it back as a comment on the same issue. A reply from the operator who paired the chat is posted as the Paperclip user who confirmed the pairing, so the issue's assignee wakes up exactly as for a dashboard comment. Replies from anyone else, and chats paired before that user was recorded, are attributed to the operate-as agent and do not wake the assignee. If the comment body is too long for one Telegram message, the notification gets a 📄 *Show full* button that fetches the rest in chunks. You can also use Telegram's standard quote-reply on the notification — the plugin treats both paths identically.

## Configuration

Stored per company (the host keeps one plugin config row per company):

| Field | Type | Notes |
|---|---|---|
| `botToken` | string | Bot API token from `@BotFather`. Either the literal token (e.g. `1234567890:AAAA…`) or the name of a Paperclip secret. The plugin auto-detects literal-looking tokens, so a secret provider is not required for local-trusted setups. |
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
- `telegram.get_approval_config` — returns the plan-approval approver and whether the agent (optional `{ agentId }`) must gate plans before acting.

## Capabilities

The plugin requests a deliberately narrow surface:

- `events.subscribe` — receive the six event types listed above.
- `jobs.schedule` — register the polling job that fetches Telegram updates, handles slash commands, and fires the morning digest.
- `http.outbound` — call `api.telegram.org` for outbound messages and `getUpdates` long-polling.
- `secrets.read-ref` — resolve `botToken` if it's a secret reference.
- `plugin.state.read` / `plugin.state.write` — store the per-company pairing map and per-message callback context.
- `companies.read` — read the selected company's name for the settings card and pairing messages.
- `agents.read` — populate the Operate-as-agent dropdown and enrich run-failure notifications.
- `issues.read` / `issues.create` / `issues.update` — list the inbox, create issues from `/new`, and reassign via the inline picker.
- `issue.comments.read` — read the full comment body and author when building comment notifications.
- `issue.comments.create` — post a Paperclip comment when someone replies to a comment notification in Telegram.
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

Outbound notifications are sent only to the chat paired with the event's `companyId`, using that company's config. The poll job reads the config of each paired company (and of the company with an in-flight handshake) and polls each distinct bot once. Inbound messages and slash commands are routed via reverse lookup (Telegram chat → paired company → operate-as agent); a chat paired to a company that uses a different bot is ignored. Polling uses long-polling (`timeout=25s`) inside a 50-second loop per cron tick, so callback-button taps and replies are processed within ~10 seconds — comfortably under Telegram's 60-second `callback_query` expiry.

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
