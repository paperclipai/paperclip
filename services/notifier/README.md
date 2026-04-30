# Koenig Telegram Notifier

Single-user Telegram bot that bridges Paperclip events to a mobile chat. Built for Vardaan to track meeting-derived task progress, blocked tickets, and shipped content from anywhere.

## Setup (one-time, ~10 minutes)

1. **Create the bot** via [@BotFather](https://t.me/BotFather) on Telegram:
   - `/newbot`
   - Pick a name (e.g. "Koenig Org Bot")
   - Pick a username (e.g. `koenig_org_bot`)
   - Save the token it returns (`<digits>:<alpha>`)

2. **Find your numeric chat id** by messaging the bot once with `/start`, then visiting:
   ```
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
   ```

3. **Add to `.env.koenig`:**
   ```
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_CHAT_ID=<numeric id from getUpdates>
   ```

4. **Generate a Paperclip board API key** (covered in `reference_paperclip_ids.md` memory) and add:
   ```
   PAPERCLIP_BOARD_TOKEN=pcb_<hex>
   ```

5. **Start the service:**
   ```
   cd /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/services/notifier
   pip install -r requirements.txt
   python main.py
   # OR via launchd: load /Users/vardaankoenig/Library/LaunchAgents/com.koenig.notifier.plist
   ```

## Outbound notifications

The poll loop scans `/api/companies/{cid}/issues` every 30 seconds and detects state changes:

| Event | Telegram message |
|---|---|
| Ticket created | `📋 New: [KOE-X] <title> · <agent>` |
| Meeting-mandate ticket created | `🎯 MEETING ACTION: [KOE-X] <title>` (highlighted) |
| Ticket goes in_progress | `▶️ Started: [KOE-X] <title> · <agent>` |
| Ticket blocked | `🚫 Blocked: [KOE-X] <title>` |
| Adapter failed | `❌ FAILED: [KOE-X] <title>` |
| publish_state=ready | `✅ Shipped: [KOE-X] <title>` |
| Daily digest at 09:00 IST | Queue summary + open meeting mandates |

## Inbound commands (DM the bot)

- `/status` — queue counts by status
- `/blocked` — list blocked tickets
- `/queue` — top of todo + in_progress
- `/cancel KOE-X` — cancel a ticket
- `/priority KOE-X high` — change priority
- `/note KOE-X text` — add a comment (TBD)
- `/pause` `/resume` — toggle dispatch (TBD; needs watchdog wire-up)
- `/help` — command menu

## VPS migration

When you move Paperclip to a VPS, point `PAPERCLIP_BASE_URL` at that VPS's host (or use a Cloudflare Tunnel). The notifier itself can run anywhere — VPS, your Mac, even a Raspberry Pi.

## State persistence

The bot stores last-seen ticket state at `${NOTIFIER_STATE_DIR}/state.json` (default `/var/lib/koenig-notifier/state.json`) so it doesn't re-emit notifications on restart.
