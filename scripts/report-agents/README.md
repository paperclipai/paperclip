# Report Agents

Telegram bot + data collectors for Whales Market daily reporting. Part of the [Paperclip](https://github.com/lab3-ai/paperclip) agent system.

## How It Works

```
Telegram ──► bot-listener.ts ──┬──► platform-collector  ──► SQLite (Metabase sync)
                               ├──► social-collector     ──► RapidAPI (X/Twitter)
                               ├──► ga-collector         ──► Google Analytics 4
                               ├──► visual-report        ──► Puppeteer → PNG chart
                               └──► free-text Q&A        ──► Claude CLI + SQLite
```

The bot runs long-polling on Telegram. Slash commands trigger specific collectors; free-text questions are routed to Claude CLI which queries the SQLite database directly.

## Prerequisites

- **Node.js** >= 20
- **pnpm** (or npm)
- **Claude CLI** — required for free-text Q&A (`npm install -g @anthropic-ai/claude-code`)
- **Google Chrome** — required by Puppeteer for `/visual` chart screenshots
- **Metabase sync** — a sibling script that syncs Metabase → local SQLite (see [Data Source](#data-source) below)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/lab3-ai/paperclip.git
cd paperclip/scripts/report-agents
npm install
```

### 2. Environment variables

The bot reads from the repo root `.env` file (`../../.env` relative to this directory).

Create it from the example or add these variables:

```bash
# Telegram Bot
TELEGRAM_BOT_TOKEN=your-bot-token        # Get from @BotFather on Telegram
TELEGRAM_CHAT_ID=-100xxxxxxxxxx          # Group/channel chat ID
TELEGRAM_THREAD_ID=                      # (Optional) Forum topic thread ID

# Platform Data
WHALES_DB_PATH=/absolute/path/to/whales_market.db   # SQLite database path

# Social (X/Twitter)
RAPIDAPI_KEY=your-rapidapi-key           # From https://rapidapi.com — subscribe to twitter241
SOCIAL_ACCOUNTS=[{"id":"123","name":"AccountName"}]  # JSON array of X account IDs to track

# Google Analytics 4
GA4_PROPERTY_ID=123456789                # GA4 property ID (numbers only)
```

### 3. Google Analytics 4 setup

The GA4 collector supports 3 authentication methods (checked in order):

| Method | Env var | Best for |
|--------|---------|----------|
| Service account JSON string | `GA4_SERVICE_ACCOUNT_JSON` | CI/CD, Docker |
| Service account key file | `GA4_SERVICE_ACCOUNT_JSON_PATH` | Server deployment |
| Application Default Credentials | _(none needed)_ | Local development |

**Option A — Service account key file (recommended for servers):**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → IAM → Service Accounts
2. Create a service account with **Viewer** role
3. Create a JSON key and save it as `ga4-key.json` in the repo root (gitignored)
4. In GA4 Admin → Property Access Management, add the service account email as **Viewer**
5. Set in `.env`:
   ```
   GA4_SERVICE_ACCOUNT_JSON_PATH=../../ga4-key.json
   ```

**Option B — Application Default Credentials (local dev):**

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly
```

No env var needed — the client auto-detects ADC.

### 4. Telegram bot setup

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Add the bot to your group/channel
3. Get the chat ID:
   ```bash
   curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
   ```
   Look for `"chat":{"id":-100xxxxx}` in the response
4. (Optional) If using Forum Topics, note the `message_thread_id` for `TELEGRAM_THREAD_ID`

### 5. Data source

The bot queries a local SQLite database that mirrors your Metabase/PostgreSQL data. You need the **metabase-sync** script running alongside:

```bash
# In a sibling directory
cd ../../../metabase-sync   # or wherever your sync script lives
npm install
node sync.mjs               # incremental sync
node sync.mjs --full        # full re-sync (3 months)
```

The bot auto-syncs before each query (with a 5-minute cooldown), but you can also run sync on a cron:

```bash
# Example: sync every 30 minutes
*/30 * * * * cd /path/to/metabase-sync && node sync.mjs >> sync.log 2>&1
```

## Usage

### Start the bot

```bash
npm run bot
```

The bot starts long-polling and logs incoming messages to stdout. Keep it running (use `screen`, `tmux`, or a process manager like `pm2`).

### One-shot commands

```bash
npm run report              # Full daily report → Telegram
npm run visual              # Daily dashboard chart → Telegram
npm run visual:weekly       # Weekly chart
npm run visual:monthly      # Monthly chart
npm run monthly             # Month-over-month comparison

# Individual collectors (output to Telegram)
npm run platform            # Trading metrics only
npm run social              # X/Twitter stats only
npm run ga                  # GA4 website metrics only
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/report` | Full daily report (platform + social + GA4) |
| `/volume [7d]` | Top tokens by volume (24h or 7d) |
| `/users` | New vs returning users (24h) |
| `/token <SYMBOL>` | Deep dive on a single token |
| `/funnel` | On-chain conversion funnel (30d) |
| `/trend` | 14-day daily trend |
| `/settle` | Settlement rate overview |
| `/mom` | Month-over-month comparison |
| `/visual [weekly\|monthly]` | Dashboard chart image |
| `/reset` | Reset conversation context |
| `/help` | Show all commands |

**Free-text Q&A:** Any message that isn't a command gets routed to Claude CLI. The bot maintains conversation context per chat thread — ask follow-up questions naturally.

Examples:
- "WLFI co bao nhieu trader tuan nay?"
- "Token nao co nhieu user moi nhat?"
- "So sanh BP vs WET"

## Architecture

```
scripts/report-agents/
├── bot-listener.ts          # Telegram bot — routes commands, manages sessions
├── report-manager.ts        # Orchestrates all collectors into one report
├── platform-collector.ts    # Queries SQLite for trading metrics
├── social-collector.ts      # Fetches X stats via RapidAPI (twitter241)
├── ga-collector.ts          # Google Analytics 4 website metrics
├── visual-report.ts         # Puppeteer → dark-theme dashboard PNG
├── monthly-report.ts        # Month-over-month comparison
├── package.json
├── tsconfig.json
└── lib/
    ├── telegram.ts          # Send text/photo to Telegram (with retry + HTML cleanup)
    ├── metabase-queries.ts  # SQLite queries — volume, users, settlements
    ├── ga4-client.ts        # GA4 Data API client (daily metrics)
    ├── ga4-monthly.ts       # GA4 Data API client (monthly rollups)
    ├── charts.ts            # HTML chart templates for Puppeteer
    ├── formatters.ts        # moneySmart(), growthBadge(), number formatting
    ├── platform-format.ts   # Platform metrics → Telegram HTML
    ├── social-format.ts     # Social metrics → Telegram HTML
    ├── report-html.ts       # Full visual report HTML builder
    └── paperclip-api.ts     # Paperclip control plane API client
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing TELEGRAM_BOT_TOKEN` | Check `.env` exists at repo root with the token |
| `GA4 credentials expired` | Run `gcloud auth application-default login` with analytics scope |
| `/visual` hangs or fails | Ensure Chrome/Chromium is installed (Puppeteer needs it) |
| `Sync failed` | Check metabase-sync is installed and `WHALES_DB_PATH` points to the right `.db` file |
| Claude Q&A returns empty | Ensure `claude` CLI is installed and authenticated (`claude auth login`) |
| `can't parse entities` | Telegram HTML issue — bot auto-falls back to plain text |
