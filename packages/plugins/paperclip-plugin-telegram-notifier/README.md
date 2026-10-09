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

All action buttons are URL deep-links into the Paperclip dashboard, so decisions stay with whoever is logged in there. No board API key is stored in the plugin.

## Morning digest

Optional daily summary sent to each paired chat at a configurable hour. Per company, includes:

- **Completed yesterday** — issues marked `done` in the last ~36 hours, assigned to or created by the company's operate-as user
- **In progress** — `in_progress` issues assigned to the operate-as user
- **Todo** — `todo` issues assigned to the operate-as user

Each section caps at six bullets with a `+N more` hint for longer lists. The digest piggy-backs on the same minute-tick polling job (no extra cron entry); the schedule is fully driven by config: enable, pick an hour, optionally restrict to weekdays. Times are server local time, deduped per company by `YYYY-MM-DD` so a Paperclip restart inside the digest hour won't double-send.

Disabled by default — turn it on under **Plugins → Telegram Notifier → Morning digest**.

## Pairing — per company, token in, code out, paste back

The handshake requires control of *both* ends, so neither half on its own is enough to hijack notifications. Each company is paired separately:

1. Install the plugin and paste your bot token in **Settings → Telegram Notifier → Telegram bot token**. After saving the token is masked (`1234567890:••••AAAA`); click the eye icon to reveal.
2. In the **Companies** list, pick a company and click **Start pairing**. The plugin enters `awaiting_chat` mode for 10 minutes.
3. Open your bot in Telegram and send any message. The bot replies with a 6-character verification code addressed to that company.
4. Paste the code into the **Confirm pairing** input back in Paperclip. The bot sends a confirmation in Telegram, the company row shows ✅ paired.
5. Pick the operate-as user for that company (dropdown) so `/new`, `/inbox`, and the morning digest can attribute and assign work correctly. Different companies can have different operate-as users.
6. Repeat for each company you want covered. Single-company instances see a compact, single-row view that auto-targets the only company.

Companies are listed via the plugin bridge (`ctx.companies.list()` — works in every deployment mode). Users are listed via the dashboard's own admin endpoint (`/api/admin/users`); the plugin UI calls it directly so it inherits the operator's session cookie. If the endpoint isn't reachable (e.g. the operator isn't an instance admin), the user field falls back to a free-text UUID input.

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

Comment notifications include a 💬 *Reply* button that prompts you for text (Telegram's force-reply); send the reply and the plugin posts it back as a comment on the same issue, attributed to the operate-as agent. If the comment body is too long for one Telegram message, the notification gets a 📄 *Show full* button that fetches the rest in chunks. You can also use Telegram's standard quote-reply on the notification — the plugin treats both paths identically.

## Configuration

Exposed in the plugin's instance settings:

| Field | Type | Notes |
|---|---|---|
| `botToken` | string (required) | Bot API token from `@BotFather`. Either the literal token (e.g. `1234567890:AAAA…`) or the name of a Paperclip secret. The plugin auto-detects literal-looking tokens, so a secret provider is not required for local-trusted setups. |
| `paperclipBaseUrl` | string | Base URL used to build dashboard deep-links. Default `http://localhost:3100`. |
| `notifyOn.{approvals,assignedToYou,comments,runFailures,budgetIncidents,wakeRequests}` | boolean | Toggle each event class. All default `true`. |
| `morningDigest.enabled` | boolean | Daily digest opt-in. Default `false`. |
| `morningDigest.hour` | integer 0–23 | Hour of day, server local time. Default `8`. |
| `morningDigest.weekdaysOnly` | boolean | Skip Saturdays and Sundays. Default `true`. |
| `silent` | boolean | Send messages without sound. Default `false`. |

Per-company pairing state and operate-as users are picked through the plugin's settings page (not the JSON-schema form) so they require no UUID hunting.

## Tools

Five agent tools (namespaced under `paperclip.telegram-notifier`), useful for headless setups, scripts, and agent workflows. Most take `companyId` since pairing state is per company:

- `telegram.get_status` — returns the bot username, list of paired companies, and any in-flight handshake.
- `telegram.start_pairing` — begins a handshake. Params: `{ companyId }`.
- `telegram.confirm_pairing` — completes pairing with `{ code: "XXXXXX" }` against the active handshake.
- `telegram.unpair` — disconnects a company's chat. Params: `{ companyId }`.
- `telegram.send_test` — sends a sample notification to a company's chat. Params: `{ companyId }`.

## Capabilities

The plugin requests a deliberately narrow surface:

- `events.subscribe` — receive the six event types listed above.
- `jobs.schedule` — register the polling job that fetches Telegram updates, handles slash commands, and fires the morning digest.
- `http.outbound` — call `api.telegram.org` for outbound messages and `getUpdates` long-polling.
- `secrets.read-ref` — resolve `botToken` if it's a secret reference.
- `plugin.state.read` / `plugin.state.write` — store the per-company pairing map and per-message callback context.
- `companies.read` — populate the Companies list (filtering archived).
- `agents.read` — populate the Operate-as-agent dropdown and enrich run-failure notifications.
- `issues.read` / `issues.create` / `issues.update` — list the inbox, create issues from `/new`, and reassign via the inline picker.
- `issue.comments.create` — post a Paperclip comment when the operator replies to a comment notification in Telegram.
- `agent.tools.register` — expose the five headless agent tools.
- `instance.settings.register` — render the settings page.

The plugin does not pause/resume agents, decide approvals, or store any board API key. Decision-grade actions go through deep-links to the dashboard, where the logged-in user retains full control.

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

Outbound notifications are sent only to the chat paired with the event's `companyId`. Inbound messages and slash commands are routed via reverse lookup (Telegram chat → paired company → operate-as agent). Polling uses long-polling (`timeout=25s`) inside a 50-second loop per cron tick, so callback-button taps and replies are processed within ~10 seconds — comfortably under Telegram's 60-second `callback_query` expiry.

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
