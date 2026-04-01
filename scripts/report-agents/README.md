# Whales Market — Report Agents System

Hệ thống agent tự động thu thập, phân tích và báo cáo performance từ nhiều nguồn data cho Whales Market (nền tảng pre-market trading).

## Architecture

```
Telegram Bot (bot-listener)
│
├── /report     → Report Manager orchestrate 3 collectors
├── /visual     → Dashboard PNG + AI insight
├── /wallet     → Full wallet behavior analysis (5 steps)
├── /whales     → Top whale wallets
├── /volume     → Top tokens by volume
├── /token BP   → Deep analysis 1 token
├── /trend      → 14-day daily trend
├── /settle     → Settlement rate per token
├── /mom        → Month-over-Month comparison
├── /funnel     → On-chain conversion funnel
├── /users      → New vs Returning users
├── Free text   → Claude CLI Q&A (persistent session)
│
Report Manager (brain, ceo role in Paperclip)
├── Platform Collector → SQLite (whales_market.db) → Telegram
├── Social Collector   → RapidAPI twitter241 → Telegram
├── GA Collector       → GA4 Data API → Telegram
└── Data Validator     → anomaly detection
```

## Data Sources

| Source | Type | Data |
|--------|------|------|
| **whales_market.db** | SQLite (synced from Metabase) | Orders, offers, users, tokens, settlements — all-time |
| **GA4 Data API** | Google Analytics | Website traffic, sessions, landing pages, countries |
| **RapidAPI twitter241** | X/Twitter | Social engagement, tweets, likes, views |

## Quick Start

```bash
# 1. Install
cd scripts/report-agents
pnpm install

# 2. Config (.env ở root paperclip/)
# Xem .env section bên dưới

# 3. Sync data
cd /path/to/metabase-sync && node sync.mjs

# 4. Run bot (chạy liên tục)
pnpm bot

# 5. Hoặc chạy report 1 lần
pnpm report          # Daily report (text)
pnpm visual          # Daily dashboard (PNG)
pnpm visual:weekly   # Weekly dashboard
pnpm visual:monthly  # Monthly dashboard
```

## Commands

### Reports
| Command | Output | Mô tả |
|---------|--------|-------|
| `pnpm bot` | Telegram bot | Chạy liên tục, nhận messages |
| `pnpm report` | Text messages | Daily: Platform + Social + GA4 + AI Overview |
| `pnpm visual` | PNG dashboard | Dark theme chart: volume, users, traffic, settlement |
| `pnpm visual:weekly` | PNG dashboard | Weekly summary |
| `pnpm visual:monthly` | PNG dashboard | Monthly summary + insights |
| `pnpm monthly` | Text analysis | Monthly deep analysis by Claude |

### Individual Collectors
| Command | Output |
|---------|--------|
| `pnpm platform` | Platform performance → Telegram |
| `pnpm social` | X/Twitter engagement → Telegram |
| `pnpm ga` | GA4 website metrics → Telegram |

## Telegram Bot Commands

```
/report     — Full daily report (3 collectors + AI overview)
/visual     — Dashboard PNG + insight bullets
/visual weekly/monthly — Weekly/Monthly dashboard

/volume     — Top tokens by 24h filled volume
/volume 7d  — Top tokens by 7-day volume
/users      — New vs Returning users
/token BP   — Deep analysis: volume, PnL, traders, settle rate
/trend      — 14-day daily volume & orders trend
/settle     — Settlement rate per token
/mom        — Month-over-Month comparison
/funnel     — On-chain conversion funnel (30d)

/wallet 0xABC... — Full wallet behavior analysis
/whales     — Top 10 whale wallets

/reset      — Reset conversation context
/help       — Show all commands

Free text   — Hỏi bất kỳ câu hỏi nào về data
```

## Wallet Analysis Flow

Khi dùng `/wallet`, bot chạy 5-step analysis:

1. **Classify** — Whale ($100K+) / Big Trader / Active Retail / Small Retail
2. **Profile** — Trading history, tokens traded, PnL per token
3. **Behavior** — Buyer/seller ratio, settle rate, frequency, timing
4. **Network** — Top counterparties, trading relationships
5. **Intent** — Accumulator / Flipper / Hedger / Speculator (hypothesis, not fact)

## .env Configuration

```env
# Paperclip
DATABASE_URL=postgres://...
PORT=3100

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Platform Data
WHALES_DB_PATH=/path/to/metabase-sync/whales_market.db

# Social
RAPIDAPI_KEY=your_rapidapi_key
SOCIAL_ACCOUNTS=[{"id":"123","name":"Account1"},{"id":"456","name":"Account2"}]

# GA4
GA4_PROPERTY_ID=123456789
GA4_SERVICE_ACCOUNT_JSON_PATH=/path/to/ga4-key.json
```

## AI System

Bot dùng **Claude CLI** (`claude --print`) cho mọi AI tasks:

- **SYSTEM_PROMPT.md** — Role, nguyên tắc phân tích, format trả lời
- **QUERY_PATTERNS.md** — 20 verified SQL patterns, bot PHẢI dùng (không tự viết SQL)
- **BUSINESS_CONTEXT.md** — KPIs, benchmarks, mục tiêu, campaigns
- **SCHEMA.md** — Database schema + business logic

### Conversation Memory
- Persistent Claude sessions per chat (1h TTL)
- Follow-up questions hiểu context ("token này" = token vừa nói)
- `/reset` để bắt đầu conversation mới

### Response Format
- Tiếng Việt, metric giữ tiếng Anh
- 3-layer: **Fact** (số liệu) → **Observation** (pattern) → **Recommendation** (đề xuất)
- So sánh với benchmarks: Tệ / Trung bình / Tốt / Rất tốt

## Visual Report

Dashboard PNG dark theme, generated bằng Chart.js + Puppeteer:

- Volume & Orders trend line (14 days)
- Top tokens horizontal bar
- New vs Returning users doughnut
- Traffic sources doughnut
- Settlement rate per token table
- Core metrics cards (volume, orders, fees, wallets)

## File Structure

```
scripts/report-agents/
├── bot-listener.ts          # Telegram bot (main entry, chạy liên tục)
├── report-manager.ts        # Orchestrate daily/weekly/monthly reports
├── visual-report.ts         # Dashboard PNG generator
├── monthly-report.ts        # Monthly deep analysis
├── platform-collector.ts    # Query SQLite → format → Telegram
├── social-collector.ts      # Fetch X/Twitter → format → Telegram
├── ga-collector.ts          # Fetch GA4 → format → Telegram
├── lib/
│   ├── telegram.ts          # Send message/photo to Telegram
│   ├── metabase-queries.ts  # SQLite queries for platform data
│   ├── ga4-client.ts        # GA4 Data API client
│   ├── ga4-monthly.ts       # GA4 monthly metrics
│   ├── formatters.ts        # moneySmart, growthBadge, acqBadge
│   ├── platform-format.ts   # HTML format for platform report
│   ├── social-format.ts     # Fetch + format social data
│   ├── report-html.ts       # Dashboard HTML template + Puppeteer render
│   ├── charts.ts            # QuickChart.io chart generator
│   └── paperclip-api.ts     # Paperclip API client
├── package.json
└── tsconfig.json

# AI Config Files (metabase-sync/)
├── SYSTEM_PROMPT.md         # AI analyst role + response rules
├── QUERY_PATTERNS.md        # 20 verified SQL patterns
├── BUSINESS_CONTEXT.md      # KPIs, benchmarks, goals
├── SCHEMA.md                # Database schema + business logic
└── whales_market.db         # SQLite database
```

## Paperclip Integration

Agents registered in Paperclip (http://localhost:3100):

| Agent | Role | Adapter | Heartbeat |
|-------|------|---------|-----------|
| Report Manager | ceo | process | 24h |
| Platform Collector | researcher | process | 12h |
| Social Collector | researcher | process | 24h |
| GA Collector | researcher | process | 24h |
| Data Validator | qa | claude_local | 5min |

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Database**: SQLite (better-sqlite3)
- **AI**: Claude CLI (claude --print / -r session resume)
- **Charts**: Chart.js + Puppeteer (server-side render)
- **Telegram**: Bot API (long polling)
- **GA4**: Google Analytics Data API v1beta (googleapis)
- **Social**: RapidAPI twitter241
- **Platform**: Paperclip (agent orchestration)
