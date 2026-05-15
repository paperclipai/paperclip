# chase-telegram — Telegram-to-Paperclip Bridge

Supabase Edge Function that forwards Telegram messages from @AvvAChaseBot to the
Paperclip API using Chase's credentials and personality.

```
Telegram → Webhook → Edge Function → Paperclip API → Formatted Response
             ↑                                         |
             └──────── Response back via Telegram ←─────┘
```

## Architecture

The edge function is a thin front-end — it does not run the Chase agent itself.
It uses Chase's Paperclip API key to query live data, formats the response using
Chase's defined personality (warm, efficient operations assistant tone), and replies via
Telegram.

### Tool-Router Architecture

Messages are processed through a layered routing pipeline:

```
Telegram message → routeQuery(text) → regex dispatch (fast path)
                                       ↓ no match
                                   NL regex patterns (Paperclip queries, agent actions)
                                       ↓ no match
                                   LLM intent classifier (DeepSeek/Claude)
                                       ↓ no match
                                   AI chat response (generateReply)
```

### Module Structure

| File | Purpose |
|---|---|
| `index.ts` | Server entry: HTTP serve, webhook handler, notification endpoint, health check |
| `router.ts` | Message routing: regex dispatch + NL patterns + LLM intent classifier |
| `types.ts` | Shared interfaces (TelegramUpdate, Paperclip models, intent results) |
| `lib/html.ts` | HTML formatting helpers (escapeHtml, issueLink) |
| `lib/telegram.ts` | Telegram API client (sendMessage) |
| `lib/api.ts` | Paperclip API client (GET/POST with auth) |
| `lib/llm.ts` | LLM helpers (DeepSeek primary, Claude fallback, intent classifier, system prompts) |
| `tools/paperclip.ts` | Paperclip query tools (blocked, approvals, agents, detail, search, overview, agentIssues) |
| `tools/actions.ts` | Agent action tools (createIssue) |
| `tools/aviation.ts` | Aviation weather tools (METAR, TAF) |
| `tools/places.ts` | Location-aware search tools (cinemas, restaurants, hotels) |

### Routing Pipeline

1. **Slash commands** — `/overview`, `/blocked`, `/detail`, `/metar`, etc. (fastest path, no AI)
2. **Natural language patterns** — Regex-based routing for common phrases like "what is X working on?", "have X do Y"
3. **LLM intent classifier** — For unmatched queries, uses DeepSeek/Claude to classify intent (greeting, paperclip_query, agent_action, aviation_weather, location_search, web_search, chat)
4. **AI chat fallback** — Free-text conversation using Chase's system prompt

### Supported NL Queries

| Natural Language | Action |
|---|---|
| "What is Hunter working on?" | Returns Hunter's assigned issues |
| "How many tasks are blocked?" | Returns blocked issue count |
| "Show pending approvals" | Returns pending approvals |
| "Who is on the team?" | Lists all agents |
| "Company status" | Company overview |
| "Tell me about CRE-123" | Issue details |
| "Have Christie send a report" | Creates issue for Christie |
| "METAR KDFW" | Returns METAR weather data |
| "weather at KJFK" | NL METAR query (no slash needed) |
| "TAF for KLAX" | NL TAF query (no slash needed) |
| "forecast at KDFW" | NL TAF query |
| "movies near downtown Austin" | Find cinemas near a location |
| "restaurants in Brooklyn" | Find restaurants near a location |
| "hotels near Soho London" | Find hotels near a location |
| "where to eat in Paris" | Find restaurants near a location |
| "places to stay near Eiffel Tower" | Find hotels near a location |
| "hello", "hi" | Warm greeting (no API call) |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token for @AvvAChaseBot |
| `PAPERCLIP_API_URL` | Yes | Paperclip API base URL (e.g. `https://paperclip.avva.aero`) |
| `CHASE_PAPERCLIP_API_KEY` | Yes | Chase's Paperclip API key (read-only) |
| `PAPERCLIP_COMPANY_ID` | Yes | Company UUID for API queries |
| `ALLOWED_TELEGRAM_USER_IDS` | No | Comma-separated Telegram user IDs to restrict access (empty = open) |
| `WEBHOOK_SETUP_SECRET` | No | Secret for `/setup-webhook` endpoint auth |
| `DEEPSEEK_API_KEY` | No | DeepSeek API key (primary AI provider) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (fallback AI provider) |

## Deployment

### Supabase

> **Note:** Deploy via GitHub Actions push trigger (May 15, 2026).

### Supabase

```bash
# 1. Install Supabase CLI
# 2. Link your project
supabase link --project-ref <ref>

# 3. Deploy the function
supabase functions deploy chase-telegram --no-verify-jwt

# 4. Set environment variables
supabase secrets set TELEGRAM_BOT_TOKEN=<token>
supabase secrets set PAPERCLIP_API_URL=<url>
supabase secrets set CHASE_PAPERCLIP_API_KEY=<key>
supabase secrets set PAPERCLIP_COMPANY_ID=<id>
supabase secrets set ALLOWED_TELEGRAM_USER_IDS=<ids>
supabase secrets set WEBHOOK_SETUP_SECRET=<secret>
supabase secrets set DEEPSEEK_API_KEY=<key>
supabase secrets set ANTHROPIC_API_KEY=<key>

# 5. Configure Telegram webhook to point at the function URL
#    (the function URL is https://<ref>.functions.supabase.co/chase-telegram)
```

### Alternative: Deno Deploy or other

The function is a standard Deno HTTP server. Deploy anywhere that supports Deno:

```bash
deno run --allow-net --allow-env index.ts
```

## Setting the Telegram Webhook

Once deployed, configure the Telegram bot to send updates to the function:

```bash
curl -X POST https://<function-url>/setup-webhook \
  -H "Authorization: Bearer <WEBHOOK_SETUP_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<function-url>/"}'
```

Or use the Telegram API directly:

```bash
curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<function-url>/"}'
```

## Commands

| Command | Description |
|---|---|
| `/start`, `hello`, `hi` | Welcome message |
| `/help`, `/commands` | Show available commands |
| `/overview`, `/status` | Company overview |
| `/blocked` | Blocked issues |
| `/approvals` | Pending approvals |
| `/agents` | List agents |
| `/detail <ID>` | Issue details (e.g. `/detail CRE-123`) |
| `/search <query>` | Search issues |
| `/metar <ICAO>` | Current METAR weather report (e.g. `/metar KJFK`) |
| `/taf <ICAO>` | TAF weather forecast (e.g. `/taf KJFK`) |
| `/movies <location>` | Find cinemas near a location (e.g. `/movies downtown Austin`) |
| `/restaurants <location>` | Find restaurants near a location (e.g. `/restaurants Brooklyn`) |
| `/hotels <location>` | Find hotels near a location (e.g. `/hotels Soho London`) |
| Free text | Natural language routing to queries |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` or `/health` | Health check |
| POST | `/` | Telegram webhook handler |
| POST | `/setup-webhook` | Configure Telegram webhook URL |
| POST | `/notify` | Push notification from Paperclip to Telegram |
