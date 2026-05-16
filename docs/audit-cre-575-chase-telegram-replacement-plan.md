# CRE-575 Phase 1 Audit: Chase Telegram → Paperclip Agent Runtime Integration

## Executive Summary

**Current state:** Chase Telegram is a standalone Supabase Edge Function (Deno) that acts as its own agent — it has no entry in the Paperclip `agents` table, does not use `agent_wakeup_requests`, does not use the heartbeat service, and does not use `PluginToolDispatcher`. It authenticates to the Paperclip REST API via a Chase-specific API key and performs all routing (regex dispatch, NL patterns, LLM intent classification, AI chat) locally within the Edge Function.

**Core decision:** Chase Telegram should become a thin input/output adapter. The Paperclip agent runtime ("Chase — Dispatcher") is already more capable and reliable than the custom routing logic in chase-telegram (proven by Jeff's test: "Delete CRE-549" was handled correctly by the runtime but failed through the Telegram router).

---

## 1. Current Architecture

```
┌──────────────────────────┐
│      Telegram User       │
│  (Jeff / allowed users)  │
└──────────┬───────────────┘
           │ POST / (webhook)
           ▼
┌──────────────────────────────────────────────────────┐
│              Chase Telegram Edge Function             │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ index.ts │→ │router.ts │→ │tools/             │  │
│  │ (HTTP    │  │(809 lines│  │  paperclip.ts     │  │
│  │  serve)  │  │ routing) │  │  actions.ts       │  │
│  └──────────┘  └──────────┘  │  aviation.ts      │  │
│         │          │         │  places.ts        │  │
│         ▼          ▼         │  web_search.ts    │  │
│  ┌──────────┐  ┌──────────┐  └────────┬──────────┘  │
│  │lib/      │  │lib/      │           │             │
│  │telegram  │  │llm.ts    │           ▼             │
│  │.ts       │  │(DeepSeek │  ┌──────────────────┐  │
│  └──────────┘  │ /Claude) │  │lib/api.ts        │  │
│                └──────────┘  │(Paperclip REST   │  │
│                              │ client)          │  │
│                              └────────┬─────────┘  │
└───────────────────────────────────────┼────────────┘
                                        │ Bearer token
                                        ▼
┌──────────────────────────────────────────────────────┐
│                 Paperclip Server                      │
│                                                      │
│  ┌─────────────────┐  ┌──────────────────────────┐  │
│  │ REST API        │  │ Agent Runtime            │  │
│  │ (agents, issues,│  │  heartbeat service       │  │
│  │  approvals,     │  │  agent_wakeup_requests   │  │
│  │  comments)      │  │  PluginToolDispatcher    │  │
│  └─────────────────┘  │  ← NOT USED by Telegram  │  │
│                       └──────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Routing Pipeline (router.ts — 809 lines)

Four-tier routing system that is entirely redundant with the Paperclip agent runtime:

| Tier | Method | Lines | What it handles |
|------|--------|-------|-----------------|
| 1 | Regex slash commands | ~30 | `/blocked`, `/overview`, `/detail`, `/metar`, etc. |
| 2 | NL regex patterns | ~100 | "what is X working on", "have X do Y", "Delete CRE-549", etc. |
| 3 | LLM intent classifier | ~80 | Classifies into 7 intents (greeting, paperclip_query, agent_action, etc.) |
| 4 | AI chat fallback | ~30 | Free-text conversation via DeepSeek/Claude |

### Modules Mapped

| Module | Lines | Current Role | Target Role |
|--------|-------|--------------|-------------|
| `index.ts` | 238 | HTTP server, webhook handler, `/notify`, `/setup-webhook`, health | **Keep** — HTTP entry point, authentication, user whitelist |
| `router.ts` | 809 | Message routing (all 4 tiers) | **Delete** — replace with wake-agent payload |
| `types.ts` | 115 | TypeScript interfaces | **Trim** — keep only Telegram types, remove Paperclip API types |
| `lib/telegram.ts` | 36 | Core Telegram client (`sendTelegram`) | **Keep** — send responses back to user |
| `lib/api.ts` | 66 | Paperclip REST API client | **Delete** — agent runtime replaces direct API calls |
| `lib/llm.ts` | 205 | DeepSeek/Claude integration, intent classification, AI chat | **Delete** — agent runtime provides AI capability |
| `lib/html.ts` | ~30 | Formatting helpers | **Maybe keep** — for Telegram HTML formatting |
| `lib/location.ts` | 52 | In-memory user location store | **Delete** — agent runtime can manage state |
| `lib/pending-tasks.ts` | 104 | Multi-message task creation flow | **Delete** — agent runtime handles task creation |
| `tools/paperclip.ts` | 215 | Paperclip query tools | **Delete** — agent runtime handles queries |
| `tools/actions.ts` | 227 | Issue creation, agent resolution | **Delete** — agent runtime handles actions |
| `tools/aviation.ts` | 114 | Aviation weather (METAR, TAF, NOTAM) | **Delete** — agent runtime can use tools |
| `tools/places.ts` | 194 | Location-aware POI search | **Delete** — agent runtime can use tools |
| `tools/web_search.ts` | 138 | Web search (Tavily/SerpAPI/DuckDuckGo) | **Delete** — agent runtime can use tools |
| `tools/cleanup.ts` | ~40 | Title/description cleaning | **Delete** |
| `tools/preview.ts` | ~40 | Task preview formatting | **Delete** |

### Key Problems

1. **Duplicated agent capability** — The Edge Function implements its own routing, NLU, and decision-making that duplicates what the Paperclip agent runtime already provides
2. **No standardized tool interface** — Tools like aviation weather, places, and web search are hardcoded in the Edge Function rather than being Paperclip plugin tools
3. **No session/state management** — Location state, pending tasks are ad-hoc in-memory
4. **"Delete CRE-549" handled wrong** — The regex-based destructive action pattern tries to create a task to handle deletion; the Paperclip runtime correctly identified that hard DELETE is not supported and cancelled the issue with proper lifecycle management
5. **Two copies** — The codebase has two identical copies (`supabase/functions/chase-telegram/` and `scripts/chase-telegram/`), creating maintenance burden

---

## 2. Target Architecture

```
┌──────────────────────────┐
│      Telegram User       │
│  (Jeff / allowed users)  │
└──────────┬───────────────┘
           │ POST / (webhook)
           ▼
┌──────────────────────────────────────┐
│   Chase Telegram (Thin Adapter)      │
│                                      │
│  ┌──────────┐  ┌──────────────────┐ │
│  │ index.ts │→│ normalizeMessage │ │
│  │ (HTTP    │  │ → userId/chatId │ │
│  │  serve)  │  │ → text          │ │
│  └──────────┘  │ → attachments   │ │
│         │      └────────┬─────────┘ │
│         ▼               │           │
│  ┌──────────┐           ▼           │
│  │lib/      │  ┌──────────────────┐ │
│  │telegram  │←│ wakeChaseAgent() │ │
│  │.ts       │  │ via API: POST   │ │
│  └──────────┘  │ /agents/{id}/   │ │
│                │   wakeup        │ │
│                │ payload: {      │ │
│                │   source:       │ │
│                │    "automation",│ │
│                │   payload: {    │ │
│                │     channel:    │ │
│                │      "telegram",│ │
│                │     chatId: ...,│ │
│                │     message: .. │ │
│                │   }             │ │
│                │ }               │ │
│                └────────┬─────────┘ │
└─────────────────────────┼───────────┘
                          │ POST /api/agents/{chase.id}/wakeup
                          ▼
┌──────────────────────────────────────────────────────┐
│              Paperclip Server                         │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │           Agent Runtime                       │    │
│  │                                              │    │
│  │  ┌──────────────┐       ┌─────────────────┐  │    │
│  │  │ Chase Agent  │──────→│ PluginTool      │  │    │
│  │  │ (DB row)     │       │ Dispatcher      │  │    │
│  │  │              │       │                 │  │    │
│  │  │ adapter:     │       │ tools:          │  │    │
│  │  │ opencode-local│      │ - paperclip API │  │    │
│  │  │ instructions:│       │ - aviation      │  │    │
│  │  │ "You are     │       │ - places        │  │    │
│  │  │  Chase..."   │       │ - web search    │  │    │
│  │  └──────────────┘       └─────────────────┘  │    │
│  │                                              │    │
│  │  ┌──────────────────────────────────────┐    │    │
│  │  │ Telegram Output Plugin               │    │    │
│  │  │ (sendTelegram via POST /notify back  │    │    │
│  │  │  to chase-telegram Edge Function)    │    │    │
│  │  └──────────────────────────────────────┘    │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### How It Works

1. **Telegram message arrives** at the chase-telegram Edge Function webhook
2. **Authenticate** the user (check `ALLOWED_TELEGRAM_USER_IDS`)
3. **Normalize** the message: extract `chatId`, `text`, `firstName`, and any attachments
4. **Wake the Chase agent** via `POST /api/agents/{chaseAgentId}/wakeup` with a payload containing:
   ```json
   {
     "source": "automation",
     "triggerDetail": "callback",
     "reason": "Telegram message from Jeff",
     "payload": {
       "channel": "telegram",
       "chatId": 123456,
       "message": {
         "text": "Delete CRE-549",
         "firstName": "Jeff",
         "messageId": 789
       }
     }
   }
   ```
5. **Chase agent wakes up**, processes the message using the Paperclip agent runtime (heartbeat service, PluginToolDispatcher, full AI capability)
6. **Chase agent responds** by making a `POST /notify` call back to the chase-telegram Edge Function, which sends the Telegram message to the user
7. **User sees response** in Telegram

---

## 3. Gap Analysis

### What already exists and can be reused

| Component | Status | Notes |
|-----------|--------|-------|
| `lib/telegram.ts` | ✅ Reuse | Core Telegram API client is already thin (36 lines) |
| `index.ts` HTTP server | ✅ Reuse | Webhook handler, auth, `/notify` endpoint all needed |
| `/notify` endpoint | ✅ Reuse | Already provides the Telegram output channel |
| `ALLOWED_TELEGRAM_USER_IDS` | ✅ Reuse | Authentication logic stays |
| Telegram webhook setup | ✅ Reuse | `/setup-webhook` endpoint stays |
| Chase agent system prompt | 🔄 Migrate | `lib/llm.ts` system prompt becomes agent instructions |

### What needs to be created

| Component | Priority | Description |
|-----------|----------|-------------|
| Chase Agent in DB | **P0** | Create a row in `agents` table for Chase with adapter, instructions, permissions |
| Agent wakeup payload in index.ts | **P0** | Replace `routeQuery()` call with `POST /agents/{id}/wakeup` |
| Telegram output tool/plugin | **P1** | Way for Chase agent to call back to Telegram via `/notify` |
| Agent instructions bundle | **P1** | Instructions telling Chase how to handle Telegram messages, use tools, respond via `/notify` |

### What needs to be deleted

| File | Risk | Notes |
|------|------|-------|
| `router.ts` (809 lines) | Medium | Entire routing pipeline — replaced by agent runtime |
| `lib/api.ts` (66 lines) | Low | Direct REST calls replaced by agent runtime's own API access |
| `lib/llm.ts` (205 lines) | Low | AI capability provided by agent runtime + adapter |
| `lib/location.ts` (52 lines) | Low | State managed by agent session |
| `lib/pending-tasks.ts` (104 lines) | Low | Task creation handled by agent runtime |
| `tools/*` (~1000 lines total) | Medium | All tool implementations — agent runtime provides equivalent via plugins |
| `lib/html.ts` (if not needed) | Low | Formatting can be done by agent or by Telegram plugin |

### What needs to be merged

| Action | Description |
|--------|-------------|
| Merge two copies | `supabase/functions/chase-telegram/` and `scripts/chase-telegram/` must be consolidated — keep only one canonical copy |

---

## 4. Implementation Plan (Phases 2-4)

### Phase 2: Create Chase Agent + Thin Adapter

**Goal:** Create the Chase agent in Paperclip's agent runtime and reduce the Edge Function to a thin adapter.

**Steps:**

1. **Create Chase agent in DB** — Add a migration/seed for the Chase agent:
   - `name`: "Chase"
   - `role`: "general" (or add "executive_assistant" to `AGENT_ROLES`)
   - `title`: "Executive Assistant to Jeff"
   - `adapter_type`: "opencode-local" (or appropriate adapter)
   - `permissions`: Read issues, read agents, read approvals, create issues, add comments
   - `reports_to`: Jeff/CEO agent ID
   - `instructions_bundle`: Contains system prompt from `lib/llm.ts`

2. **Create agent instructions bundle** — The instructions must include:
   - Identity: "You are Chase, the Executive Assistant to Jeff at Paperclip"
   - Response channel: how to use `/notify` API to send Telegram messages
   - Available tools/plugins
   - Behavior rules (confirmation before destructive actions, etc.)

3. **Strip router.ts** — Delete all tool routing logic. Replace `routeQuery()` with:
   - Auth check (keep)
   - Normalize message (keep)
   - `POST /api/agents/{chaseAgentId}/wakeup` (new)
   - Return "One moment..." acknowledgement (new)

4. **Delete unused tools** — Remove `tools/paperclip.ts`, `tools/actions.ts`, `tools/aviation.ts`, `tools/places.ts`, `tools/web_search.ts`, `tools/cleanup.ts`, `tools/preview.ts`
5. **Delete lib modules** — Remove `lib/api.ts`, `lib/llm.ts`, `lib/location.ts`, `lib/pending-tasks.ts`
6. **Trim types.ts** — Remove Paperclip API types, keep only Telegram types
7. **Consolidate copies** — Keep one canonical copy (propose: `supabase/functions/chase-telegram/` as canonical, delete `scripts/chase-telegram/`)
8. **Update tests** — Rewrite tests to mock the wakeup endpoint instead of the REST API

### Phase 3: Wire Telegram Through Agent Runtime

**Goal:** Telegram messages flow through the Paperclip agent runtime and responses come back.

**Steps:**

1. **Wakeup payload handler** — ensure the Edge Function sends a structured payload:
   ```typescript
   const response = await fetch(
     `${PAPERCLIP_API_URL}/api/agents/${CHASE_AGENT_ID}/wakeup`,
     {
       method: "POST",
       headers: {
         Authorization: `Bearer ${CHASE_PAPERCLIP_API_KEY}`,
         "Content-Type": "application/json",
       },
       body: JSON.stringify({
         source: "automation",
         triggerDetail: "callback",
         reason: `Telegram message from ${firstName}`,
         payload: {
           channel: "telegram",
           chatId,
           message: { text, firstName, messageId: msg.message_id },
         },
       }),
     }
   );
   ```

2. **Agent receives wakeup** — The heartbeat service picks up the wakeup request, launches the Chase agent with the payload in context
3. **Agent processes message** — Chase agent reads the payload, understands it came from Telegram, processes the request using Paperclip API tools and any configured plugins
4. **Agent responds via /notify** — Chase agent calls `POST /notify` on the chase-telegram Edge Function:
   ```json
   {
     "chatId": 123456,
     "text": "<formatted response>",
     "title": "Chase Response"
   }
   ```
5. **Edge Function sends Telegram** — The `/notify` endpoint receives the response and calls `sendTelegram()` as it does today

### Phase 4: Polish and Cleanup

**Goal:** Remove all vestiges of old routing, ensure reliable operation.

**Steps:**

1. **Remove unused env vars** — `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `CHECKWX_API_KEY` are no longer needed by the Edge Function
2. **Clean up CI/CD** — Update `deploy-chase-telegram.yml` to match new source location
3. **Remove scripts copy** — Delete `scripts/chase-telegram/` entirely
4. **Add Telegram output plugin** — If agent needs richer Telegram capabilities (inline keyboards, file uploads, media), create a Paperclip plugin for Telegram
5. **Monitoring and alerting** — Add health checks for the wakeup → process → response round-trip
6. **Documentation** — Update `README.md` to reflect new architecture
7. **End-to-end test** — Write an integration test: Telegram webhook → agent wakeup → agent response → Telegram message

---

## 5. Files Modified Summary

### Phase 2 Changes

| File | Action |
|------|--------|
| `supabase/functions/chase-telegram/index.ts` | **Modify** — Replace `routeQuery()` with wakeup API call |
| `supabase/functions/chase-telegram/router.ts` | **Delete** entire file |
| `supabase/functions/chase-telegram/types.ts` | **Trim** — Remove Paperclip API types |
| `supabase/functions/chase-telegram/lib/api.ts` | **Delete** |
| `supabase/functions/chase-telegram/lib/llm.ts` | **Delete** |
| `supabase/functions/chase-telegram/lib/location.ts` | **Delete** |
| `supabase/functions/chase-telegram/lib/pending-tasks.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/paperclip.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/actions.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/aviation.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/places.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/web_search.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/cleanup.ts` | **Delete** |
| `supabase/functions/chase-telegram/tools/preview.ts` | **Delete** |
| `supabase/functions/chase-telegram/lib/html.ts` | **Keep** (or delete if not needed) |
| `supabase/functions/chase-telegram/index_test.ts` | **Rewrite** |
| `supabase/functions/chase-telegram/router_test.ts` | **Delete** |
| `supabase/functions/chase-telegram/deno.json` | **Update** deps |
| `supabase/functions/chase-telegram/README.md` | **Rewrite** |
| `scripts/chase-telegram/` | **Delete** entire directory |
| `packages/db/src/migrations/` | **Add** migration for Chase agent |
| Agent instructions bundle (new) | **Create** |

### Phase 3 Changes

| File | Action |
|------|--------|
| Agent instructions (existing) | **Modify** — Add Telegram response protocol |
| `supabase/functions/chase-telegram/index.ts` | **Refine** — Wakeup payload format |
| `supabase/functions/chase-telegram/index.ts` | **Enhance** — `/notify` ID tracking |

### Phase 4 Changes

| File | Action |
|------|--------|
| `.github/workflows/deploy-chase-telegram.yml` | **Update** |
| `docs/deployment-guide.md` | **Update** |
| `docs/audit-cre-453-christie-telegram-alerts.md` | **Update** |
| `supabase/config.toml` | **Possibly update** — env vars |

---

## 6. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Agent wakeup latency (agent may take seconds to start) | High | Medium | Show "One moment..." to user immediately; agent runtime handles async |
| Agent runtime lacks Telegram-specific capabilities (inline keyboards, file uploads) | Medium | Medium | Keep `/notify` endpoint for text; add Telegram plugin for rich features later |
| Agent runtime doesn't support "interrupt" pattern (user sends follow-up while agent is thinking) | Medium | High | Use idempotency keys and session coalescing; handle in agent instructions |
| Agent runtime cost higher than current Edge Function | Low-Medium | Medium | Chase agent runs on-demand; Edge Function costs are negligible |
| Breaking existing Telegram commands that rely on fast regex path | High | Medium | Phase 2 deployment must be tested with Jeff explicitly; keep old code path with feature flag if needed |
| Aviation/places/web search tools not yet available as Paperclip plugins | Medium | Medium | These can be added as plugin tools or Chase can use web search via its own capability |
| Dual-copy consolidation may miss divergent changes | Medium | Low | Diff both copies before deleting to ensure any drift is captured |

---

## 7. Decision Record

| Decision | Rationale |
|----------|-----------|
| Use `POST /agents/{id}/wakeup` with `source: "automation"` | Matches the intended use case: external system triggering agent work, not a human-initiated on-demand request |
| Keep `/notify` endpoint as Telegram output channel | Already exists, works, and avoids needing the agent to directly call Telegram API (which would require exposing `TELEGRAM_BOT_TOKEN` to the agent) |
| Keep `supabase/functions/chase-telegram/` as canonical | Already deployed and wired into CI/CD; `scripts/` copy was for local testing |
| No new Paperclip plugin for Telegram (Phase 2) | `/notify` is sufficient for text responses; plugin can be added in Phase 4 if needed |
| Add Chase agent to DB via migration | Requires a `company_id` — must be the production Paperclip company where Jeff operates |
| Keep `ALLOWED_TELEGRAM_USER_IDS` in Edge Function | Authentication happens before wakeup, not inside the agent (agent doesn't manage Telegram credentials) |
