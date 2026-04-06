# Report Agents — Setup Guide

## Prerequisites

- Node.js >= 18
- pnpm (`npm install -g pnpm`)
- Claude CLI installed ([https://docs.anthropic.com/claude-code](https://docs.anthropic.com/claude-code))

## 1. Clone & Install

```bash
git clone https://github.com/amanbuild/paperclip.git
cd paperclip
git checkout amando/report-agents
pnpm install
```

## 2. Setup Metabase Sync

The bot needs a local SQLite copy of the Whales Market Postgres database. We sync via Metabase API.

```bash
# Create metabase-sync directory (sibling to paperclip)
mkdir -p ../metabase-sync
cd ../metabase-sync
npm init -y
npm install better-sqlite3
```

Copy `sync.mjs` from the working setup, or create `.env`:

```env
METABASE_URL=https://metabase.uslab.dev
METABASE_USERNAME=amando@lab3.asia
METABASE_PASSWORD=ahtuanz18
METABASE_DB_ID=4
```

Run full sync:
```bash
node sync.mjs --full
```

This creates `whales_market.db` with tables: `[order]`, `offer`, `token`, `users`, `network_chains`, plus derived: `_order_flat`, `_user_first_order`, `_user_token_first`, `_sync_log`.

**Important files in metabase-sync/:**
- `SYSTEM_PROMPT.md` — AI analyst rules, schema, business context, analysis framework
- `QUERY_PATTERNS.md` — 15 verified SQL patterns (P1-P15)
- `whales_market.db` — SQLite database

## 3. Environment Variables

Create `.env` at paperclip root:

```env
# Paperclip server (not required for bot)
DATABASE_URL=postgres://amando@localhost:5432/paperclip
PORT=3100
SERVE_UI=false

# Telegram
TELEGRAM_BOT_TOKEN=<get from @BotFather>
TELEGRAM_CHAT_ID=<your chat/group ID>

# Platform Data (absolute path to SQLite)
WHALES_DB_PATH=/absolute/path/to/metabase-sync/whales_market.db

# Metabase sync directory (optional, default: ../../metabase-sync relative to report-agents)
# METABASE_SYNC_DIR=/absolute/path/to/metabase-sync

# Social (RapidAPI twitter241)
RAPIDAPI_KEY=<your RapidAPI key>
SOCIAL_ACCOUNTS=[{"id":"1952633251249688576","name":"WhalesPreMarket"},{"id":"2440149164","name":"WhalesMarket"}]

# GA4 (Service Account)
GA4_PROPERTY_ID=504123772
GA4_SERVICE_ACCOUNT_JSON_PATH=/absolute/path/to/ga4-key.json
```

## 4. Run Bot

```bash
cd scripts/report-agents
pnpm bot
```

Bot will start long-polling Telegram for messages.

## 5. Telegram Commands

| Command | Description |
|---------|-------------|
| `/daily` | Daily report (Platform + Social + GA4) |
| `/weekly` | Weekly report with WoW comparison |
| `/monthly` | Monthly report with MoM comparison |
| `/token WLFI` | Token analysis (instant SQL) + buttons |
| `/toptrader` | Top traders across platform |
| `/toptrader WLFI` | Full forensic analysis for token |
| `/reset` | Reset conversation context |
| `/help` | Show help |
| Free text | Ask anything — Claude Q&A with pre-fed data |

### Buttons after commands:
- **AI Insight** — Claude deep analysis using forensic data + SYSTEM_PROMPT context
- **Visual Report** — HTML dark-theme report with Chart.js charts

## 6. Architecture

```
bot-listener.ts          — Main bot (Telegram long-polling)
lib/
  report-builder.ts      — Unified report data builder (daily/weekly/monthly)
  period-report-html.ts  — HTML visual report generator (all periods)
  token-analysis.ts      — Token analysis (direct SQL, instant)
  token-report-html.ts   — Token HTML visual report
  top-traders.ts         — Top traders ranking
  trader-forensic.ts     — Full 8-module forensic analysis
  social-format.ts       — Twitter data sync + format (RapidAPI → local SQLite)
  ga4-client.ts          — Google Analytics 4 API client
  metabase-queries.ts    — Platform metrics SQL queries
  platform-format.ts     — Platform report format (legacy)
  formatters.ts          — moneySmart, growthBadge utilities
  telegram.ts            — Telegram API helpers

metabase-sync/           — Sibling directory
  sync.mjs               — Metabase API → SQLite sync script
  SYSTEM_PROMPT.md       — AI rules + business context + analysis framework
  QUERY_PATTERNS.md      — 15 verified SQL patterns
  whales_market.db       — Local SQLite database
  social.db              — Local tweet storage (auto-created by bot)
```

## 7. Data Quirks (IMPORTANT)

### Boolean fields
`is_exit_position` stored as TEXT `'0.0'` / `'1.0'` in SQLite.
- Use `NOT is_exit_position` (falsy) or `is_exit_position` (truthy)
- NEVER use `= 0` or `= 1`

### Volume is 1-sided
`order_value_usd` in `_order_flat` = 1-sided value.
- Always multiply by 2 for reporting: `SUM(order_value_usd) * 2`

### Settlement mechanics
- Low settle rate = BULLISH (seller forfeits collateral because token mooned)
- Cancel = seller default, buyer receives collateral compensation
- NOT platform risk

## 8. Adding New Query Patterns

1. Write and test SQL in Metabase dashboard
2. Convert Postgres → SQLite (no `::numeric`, use `CAST`, no `width_bucket`)
3. Add to `QUERY_PATTERNS.md` as P16, P17...
4. Claude CLI will use these patterns for free text Q&A

## 9. Troubleshooting

| Issue | Fix |
|-------|-----|
| `Missing TELEGRAM_BOT_TOKEN` | `.env` must be at paperclip root (not in scripts/) |
| Social always empty | Tweets only from yesterday for `/daily`. Use `/weekly` for 7-day range |
| GA4 error | Check `ga4-key.json` path. Service account needs Analytics read access |
| Sync failed | Re-login to Metabase: check credentials in metabase-sync/.env |
| Bot crash on restart | Old process killed (exit 144) — normal, new bot starts fine |
