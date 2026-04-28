# Architecture Research

**Domain:** RealTycoon2 wikiLLM ingest cycle + coin_ledger integration
**Researched:** 2026-04-27
**Confidence:** HIGH

## Executive Summary

Two new subsystems integrate into the existing RT2 append-only event stream architecture:

1. **wikiLLM/Graphify ingest cycle** — Activity events from the daily report board flow through the existing `rt2_v33_domain_events` event stream → a new **daily wiki projector** materializes `rt2_v33_daily_wiki_pages` (daily pages, index, log) → M1.5 Graphify projector reads those pages + task metadata → projects `rt2_v33_graph_nodes/edges` → Graph tab + GRAPH_REPORT.md. No new event types needed; new projectors added to the projector chain.

2. **coin_ledger consistency** — `rt2_coin_ledger` is an existing append-only ledger table. Double-entry consistency validation joins `rt2_coin_ledger` rows by `referenceId/referenceType` to reconstruct implied balance snapshots and detects drift. The existing `rt2_personal_pnl` table provides the authoritative period net P&L against which coin ledger balance can be cross-validated.

Both subsystems extend the existing CQRS projector pattern with no core schema changes required.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           WRITE PATH                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐     ┌──────────────────────────────────────────────────┐ │
│  │  Board UI   │────▶│  appendRt2DomainEvent(rt2.execution.*, rt2.todo.*) │ │
│  │  (3-col     │     │  rt2.deliverable.*, rt2.participant.*)             │ │
│  │   Kanban)   │     └──────────────────────┬─────────────────────────────┘ │
│  └──────────────┘                          │                                │
│                                           ▼                                │
│                    ┌───────────────────────────────────────────────┐        │
│                    │         rt2_v33_domain_events                 │        │
│                    │  (append-only, per company, idempotency-safe)  │        │
│                    └──────────────────────┬────────────────────────┘        │
└───────────────────────────────────────────┼───────────────────────────────┘
                                            │
            ┌───────────────────────────────┼───────────────────────────────┐
            │                    PROJECTOR CHAIN                             │
            ├───────────────────────────────────────────────────────────────┤
            │                                                               │
            ▼                                                               ▼
┌───────────────────────────┐                        ┌───────────────────────────┐
│ rt2.activity_live_bridge  │                        │  rt2.knowledge_core      │
│ (existing)                 │                        │  (existing)               │
│                             │                        │                           │
│ activity_log +             │                        │ rt2_v33_wiki_pages ←─┐   │
│ live-events SSE             │                        │ rt2_v33_graph_nodes  ←─┤   │
│                             │                        │ rt2_v33_graph_edges  ←─┤   │
└───────────────────────────┘                        │ rt2_v33_graph_reports←─┤   │
                                                        └───────────────────────┘   │
                                                                                   │
              ┌────────────────────────────────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────┐
│      NEW: rt2.daily_wiki_projector         │   ◄── M1.4 wikiLLM ingest
│                                           │
│  Input:  domain events (todo.*)          │
│  Output: rt2_v33_daily_wiki_pages         │
│          (daily pages, index, log)        │
│                                           │
└───────────────────┬───────────────────────┘
                    │         + M1.5 Graphify projector input
                    ▼
┌───────────────────────────────────────────┐
│      NEW: rt2.graphify_projector           │   ◄── M1.5 Graphify
│                                           │
│  Input:  daily_wiki_pages + task metadata│
│  Output: rt2_v33_graph_nodes/edges        │
│          (per project, confidence-tagged) │
│                                           │
└───────────────────┬───────────────────────┘
                    │         + per-project cache
                    ▼
┌───────────────────────────────────────────┐
│         READ PATH (query side)              │
│                                           │
│  Graph tab          GRAPH_REPORT.md       │
│  (per-project)      (markdown export)      │
└───────────────────────────────────────────┘
```

---

## Component Responsibilities

| Component | Responsibility | Location |
|-----------|----------------|----------|
| `rt2_v33_domain_events` | Append-only event log; source of truth for all activity | `packages/db/src/schema/rt2_v33_domain_events.ts` |
| `rt2_domain_event_service` | Event append, idempotency, projector invocation | `server/src/services/rt2-domain-events.ts` |
| `rt2.activity_live_bridge` | Projects board events → activity_log + live SSE | Existing projector |
| `rt2.knowledge_core` | Projects events → wiki_pages (index/log/topic) + graph_nodes/edges | `server/src/services/rt2-knowledge-projector.ts` |
| **`rt2.daily_wiki_projector`** | **[NEW]** Projects daily report events → `rt2_v33_daily_wiki_pages` (daily pages per user/project) | New service |
| **`rt2.graphify_projector`** | **[NEW]** Projects daily wiki + task metadata → `rt2_v33_graph_nodes/edges` with confidence tags | New service |
| `rt2_v33_daily_wiki_pages` | Daily wiki page materialization (per user/project/date) | `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` |
| `rt2_v33_graph_nodes/edges` | Graph projection read model | `packages/db/src/schema/rt2_v33_graph_projection.ts` |
| `rt2_v33_graph_cache` | Input hash cache for incremental per-project updates | Existing |
| `rt2CoinLedger` | Append-only coin transaction ledger | `packages/db/src/schema/rt2_personal_pnl.ts` |
| `rt2PersonalPnL` | Period P&L per actor (income/expenses/net) | `packages/db/src/schema/rt2_personal_pnl.ts` |

---

## wikiLLM Ingest Pipeline (M1.4 → M1.5)

### Phase 1: Daily Wiki Projection (M1.4)

**Trigger:** Board UI emits `rt2.todo.created | updated | moved | completed` etc.  
**Projector:** `rt2.daily_wiki_projector` (new)

```
Board event (e.g. rt2.todo.created)
    ↓
rt2_v33_domain_events (already written)
    ↓
rt2.daily_wiki_projector.processEvent()
    ↓
rt2_v33_daily_wiki_pages.upsert()
    ├─ daily/YYYY-MM-DD-{userId}.md   (per-user daily page)
    ├─ index.md                      (date-indexed catalog)
    └─ log.md                        (chronological activity log)
```

**Key rules from design doc (2026-04-17-m1-4-wikillm-daily-report-design.md):**
- Board events are the **only input** — no direct wiki writes
- Activity log entries per event: `todo.created`, `todo.updated`, `todo.moved`, `todo.progress_updated`, `todo.completed`
- Daily page has fixed sections: short summary, completed items, in-progress items, tomorrow's items, deferred items, ideas, activity history
- Daily wiki projector reads from domain events, not from board state directly (CQRS compliance)
- After projection: board UI shows "기억됨" / "위키 반영 예정" feedback

### Phase 2: Graphify Projection (M1.5)

**Trigger:** `rt2.daily_wiki_projector` output changes (daily wiki page updated)  
**Projector:** `rt2.graphify_projector` (new)

```
rt2_v33_daily_wiki_pages (updated)
    + task metadata (project, task, todo, task dependency)
    ↓
rt2.graphify_projector.refreshGraph(projectId)
    ↓
rt2_v33_graph_nodes  (upsert per entity)
rt2_v33_graph_edges  (upsert with confidence: EXTRACTED | INFERRED | AMBIGUOUS)
rt2_v33_graph_cache (input hash for incremental update)
rt2_v33_graph_reports (markdown summary + metrics)
```

**Key rules from design doc (2026-04-17-m1-5-graphify-project-graph-design.md):**
- Graph is a **read-optimized projection**, not source of truth
- Reproducible: can rebuild from `rt2_v33_daily_wiki_pages` + task metadata
- Confidence rules:
  - `project → task` / `task → todo` / `task → task dependency` = **EXTRACTED** (from metadata)
  - `daily_wiki_page → task` via explicit wiki reference = **EXTRACTED**
  - `daily_wiki_page → task` via inference from wiki text + metadata = **INFERRED** (rationale required)
  - Candidate link with multiple possible targets = **AMBIGUOUS** (not hidden, surfaced)
- `graph_cache` input hash enables incremental per-project refresh
- Output surfaces: `Graph` tab (read-only visualization) + `GRAPH_REPORT.md` (markdown report)

### Integration with Existing Projector Chain

The key integration point is in `rt2-domain-events.ts` `appendAndProject()`:

```typescript
// Current (simplified):
await processEvent("rt2.activity_live_bridge", event.id, projectActivityAndLive);
await rt2KnowledgeProjectorService(db).projectEvent(event.id);

// After M1.4 + M1.5:
await processEvent("rt2.activity_live_bridge", event.id, projectActivityAndLive);
await rt2KnowledgeProjectorService(db).projectEvent(event.id);     // existing wiki/graph
await rt2DailyWikiProjectorService(db).projectEvent(event.id);     // M1.4 daily wiki
await rt2GraphifyProjectorService(db).projectEvent(event.id);       // M1.5 graph (on daily wiki change)
```

Or better: chain the projectors so `graphify` only runs when daily wiki pages change, using the existing `rt2_v33_projector_state` checkpoint mechanism.

---

## coin_ledger Consistency Validation

### Existing Architecture

```
Board action (earn/spent/transfer)
    ↓
rt2_coin_ledger.append()
    ├─ fromActorId/fromActorType
    ├─ toActorId/toActorType
    ├─ amount (positive = gain, negative = spend)
    ├─ balanceAfter
    ├─ transactionType (earned|spent|transferred|reward|penalty)
    ├─ referenceId/referenceType
    └─ period (YYYY-MM)
    ↓
rt2_personal_pnl (period aggregates)
    ├─ income  (sum of gains)
    ├─ expenses (sum of spends)
    └─ netPnL = income - expenses
```

### Double-Entry Consistency Model

The `rt2_coin_ledger` table already records both sides of every transaction:
- For every transfer: `fromActor` balance decreases, `toActor` balance increases
- `balanceAfter` is denormalized but auditable

**Consistency check** (against drift):

```sql
-- For every coin_ledger row, verify balanceAfter = priorBalance + amount
-- Grouped by actorId, ordered by createdAt, compute running balance
WITH running AS (
  SELECT
    id, actor_id, amount, balance_after,
    LAG(balance_after) OVER (PARTITION BY actor_id ORDER BY created_at) as prior_balance
  FROM rt2_coin_ledger
  WHERE company_id = $1
)
SELECT
  id,
  ABS(COALESCE(prior_balance, 0) + amount - balance_after) as drift
FROM running
WHERE prior_balance IS NOT NULL
  AND ABS(COALESCE(prior_balance, 0) + amount - balance_after) > 0;
```

**Cross-table P&L consistency:**

```sql
-- Verify coin ledger period net matches rt2_personal_pnl.net_pnl
SELECT
  p.period, p.actor_id, p.net_pnl,
  COALESCE(SUM(cl.amount), 0) as coin_ledger_net,
  ABS(p.net_pnl - COALESCE(SUM(cl.amount), 0)) as drift
FROM rt2_personal_pnl p
LEFT JOIN rt2_coin_ledger cl
  ON cl.company_id = p.company_id
  AND cl.to_actor_id = p.actor_id
  AND cl.period = p.period
  AND cl.transaction_type IN ('earned', 'reward')
GROUP BY p.id, p.period, p.actor_id, p.net_pnl
HAVING ABS(p.net_pnl - COALESCE(SUM(cl.amount), 0)) > 0;
```

### coin_ledger Consistency Validation — Build Order

1. **First:** Write the consistency query as a stored procedure / Drizzle query
2. **Second:** Add a validation route (`GET /rt2/coin-ledger/:companyId/:actorId/consistency-check`)
3. **Third:** Add a background job that runs validation after every `coin_ledger` append and reports drift

No schema changes required. `rt2_coin_ledger` schema already exists (0067 migration shows rule cleanup only). The consistency check is a **read-only validation query** against existing rows.

---

## Data Flow

### wikiLLM Ingest Flow (M1.4)

```
User moves/creates/updates To-Do on daily board
    ↓
Board API → appendRt2DomainEvent(todo.created|updated|moved|...)
    ↓
rt2_v33_domain_events (append)
    ↓
rt2.daily_wiki_projector (new)
    ├─ Read all domain events for this user/project today
    ├─ Render daily page markdown (short summary + history sections)
    ├─ Render index.md (date catalog)
    └─ Render log.md (chronological)
    ↓
rt2_v33_daily_wiki_pages.upsert()
    ↓
Board UI shows "기억됨" / "위키 반영 예정"
```

### Graphify Flow (M1.5)

```
daily_wiki_pages updated (M1.4 projector)
    + task/project/todo metadata changes
    ↓
rt2.graphify_projector (new)
    ├─ Check rt2_v33_graph_cache input hash
    ├─ If unchanged: skip
    └─ If changed:
         ├─ Read daily_wiki_pages + task metadata for this project
         ├─ Upsert graph_nodes (project, task, todo, daily_wiki_page)
         ├─ Upsert graph_edges with confidence tags
         ├─ Upsert graph_reports (markdown)
         └─ Update rt2_v33_graph_cache
    ↓
Project Detail > Graph tab (read-only)
Project > GRAPH_REPORT.md (markdown)
```

### coin_ledger Flow

```
User/Agent earns/spends/transfers coins
    ↓
rt2_coin_ledger.append()
    ├─ Validates balance consistency (running balance)
    └─ Returns updated balanceAfter
    ↓
Background: rt2_personal_pnl aggregation job (periodically or on-demand)
    ↓
rt2_personal_pnl lookup shows period income/expenses/net
    ↓
Coin ledger consistency check:
    ├─ Running balance drift check (per actor)
    └─ Cross-table P&L match check
```

---

## New vs Modified Components

### New Components

| Component | Type | Purpose |
|-----------|------|---------|
| `rt2-daily-wiki-projector.ts` | Service | Projects domain events → `rt2_v33_daily_wiki_pages` (daily pages, index, log) |
| `rt2-graphify-projector.ts` | Service | Projects daily wiki + task metadata → `rt2_v33_graph_nodes/edges/reports` |
| `rt2_v33_daily_wiki_pages` | Schema table | Per-user/per-project daily wiki materialization (already exists in schema, projector writes to it) |
| `rt2CoinLedger` consistency validator | Query/Route | Detects running balance drift and P&L cross-table drift |

### Modified Components

| Component | Change |
|-----------|--------|
| `rt2-domain-events.ts` `appendAndProject()` | Add calls to new projectors: `rt2DailyWikiProjectorService(db).projectEvent()` and `rt2GraphifyProjectorService(db).projectEvent()` |
| `rt2-knowledge-projector.ts` | Add `projectGraphEvent` / `refreshGraphReport` entry points that `rt2.graphify_projector` can call |

### No Core Schema Changes Required

Both `rt2_v33_daily_wiki_pages` and `rt2_coin_ledger` schemas already exist. The new projectors write to existing tables.

---

## Build Order (Dependencies)

```
[Now]  existing: domain events + projectors (rt2.knowledge_core)
         │
         ▼
[M1.4] Add: rt2.daily_wiki_projector
         │  - Reads from rt2_v33_domain_events
         │  - Writes to rt2_v33_daily_wiki_pages (already in schema)
         │  - Triggers: rt2.todo.* events
         │  - Deliverable: board → daily page materialization
         │
         ▼
[M1.5] Add: rt2.graphify_projector
         │  - Reads from rt2_v33_daily_wiki_pages + task metadata
         │  - Writes to rt2_v33_graph_nodes/edges/reports/cache
         │  - Triggers: daily_wiki_pages update events
         │  - Deliverable: Graph tab + GRAPH_REPORT.md
         │
         ▼
[M1.6+] Add: coin_ledger consistency check
            - Read-only queries against rt2_coin_ledger + rt2_personal_pnl
            - No schema changes
            - Deliverable: consistency report / drift alerts
```

**Reasoning:**
- M1.4 must come first because M1.5's graph projector reads from M1.4's daily wiki pages
- The projector chain (`processEvent`) handles ordering — M1.4 projector runs after `knowledge_core`, M1.5 projector runs after M1.4
- `graphify` projector should be event-triggered by `daily_wiki_pages` updates, not by all domain events (performance)
- coin_ledger consistency is independent but logically last (validates the outputs of both subsystems)

---

## Architectural Patterns

### Pattern 1: Event-Driven Projector Chain

**What:** `appendAndProject()` calls multiple projectors sequentially. Each projector reads the same domain event and produces its own read-model projection.

**When to use:** When one business event (board action) needs to update multiple read models (daily wiki, graph, activity log).

**Trade-offs:**
- ✅ Simple, auditable (every projection traced to source event)
- ✅ Reproducible (can rebuild any read model from event log)
- ⚠️ Projectors must be idempotent (handled via `rt2_v33_projector_events` dedup)
- ⚠️ Chain latency grows with projector count → consider async/background for heavy projectors

**Example:**
```typescript
// rt2-domain-events.ts appendAndProject
await processEvent("rt2.activity_live_bridge", event.id, projectActivityAndLive);
await rt2KnowledgeProjectorService(db).projectEvent(event.id);   // existing
await rt2DailyWikiProjectorService(db).projectEvent(event.id);    // M1.4
// M1.5: conditional — only if daily_wiki changed for this project
if (dailyWikiChanged) {
  await rt2GraphifyProjectorService(db).projectEvent(event.id);
}
```

### Pattern 2: Incremental Cache + Hash for投影 Updates

**What:** `rt2_v33_graph_cache` stores `inputHash` of all inputs for a given scope (project). Before reprocessing, recompute hash and compare.

**When to use:** When projector output is expensive (graph computation) and inputs change infrequently (daily wiki updates).

**Trade-offs:**
- ✅ Prevents redundant reprocessing
- ✅ Natural unit of work is "project" (matches the design doc)
- ⚠️ Requires hash computation over all inputs (acceptable for daily volumes)

### Pattern 3: Double-Entry Ledger Consistency via Running Balance

**What:** `rt2_coin_ledger` stores `balanceAfter` per row. Consistency validation computes running balance per actor and detects drift.

**When to use:** When a ledger records both sides of every transaction and balance drift must be detectable.

**Trade-offs:**
- ✅ Self-auditing (each row can be verified against prior rows)
- ✅ Cross-table validation against `rt2_personal_pnl` catches aggregation errors
- ⚠️ `balanceAfter` is denormalized — requires write-time discipline

---

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Board UI → Domain Events | `appendRt2DomainEvent()` API call | All board mutations emit events; no direct state writes |
| Domain Events → Daily Wiki Projector | `processEvent()` with projector name | Idempotent per `rt2_v33_projector_events` |
| Daily Wiki Projector → `rt2_v33_daily_wiki_pages` | Drizzle upsert | Per-user daily page per day |
| Daily Wiki Pages → Graphify Projector | `rt2_v33_graph_cache` input hash check | Incremental per project |
| Graphify Projector → `rt2_v33_graph_*` | Drizzle upsert | Confidence-tagged edges |
| `rt2_coin_ledger` → `rt2_personal_pnl` | Period aggregation query | `coin_ledger.amount` sums vs `personal_pnl.net_pnl` cross-check |

### External Services (none for this milestone)

wikiLLM/Graphify and coin_ledger are entirely self-contained within the RT2 PostgreSQL schema. No external AI API calls, no vector DB, no third-party services required for M1.4/M1.5.

---

## Anti-Patterns

### Anti-Pattern 1: Direct Wiki Write from Board UI

**What people do:** Bypass event stream, write directly to `rt2_v33_wiki_pages` from board component.

**Why it's wrong:** Violates CQRS. Board state would not be auditable/replayable from event log.

**Do this instead:** Board emits `rt2.todo.*` event → projector materializes wiki page.

### Anti-Pattern 2: Graph as Source of Truth

**What people do:** Treat `rt2_v33_graph_nodes` as authoritative and edit it directly.

**Why it's wrong:** Graph is a read-optimized projection. Edits would be lost on next rebuild.

**Do this instead:** Edit source (`rt2_v33_daily_wiki_pages` + task metadata) → projector rebuilds graph.

### Anti-Pattern 3: Rebuilding Entire Graph on Every Event

**What people do:** No cache check — recompute all graph nodes/edges on every domain event.

**Why it's wrong:** O(n) graph rebuild per event; will not scale.

**Do this instead:** Store `graph_cache.inputHash` per project; only rebuild if inputs changed.

### Anti-Pattern 4: coin_ledger balance as Single Point of Truth

**What people do:** Store only `balanceAfter` without `amount` + `fromActor/toActor`.

**Why it's wrong:** Cannot verify consistency without full transaction replay.

**Do this instead:** Store both sides (`fromActor`, `toActor`, `amount`) — `balanceAfter` is auditable convenience.

---

## Scaling Considerations

| Scale | wikiLLM/Graphify | coin_ledger |
|-------|-----------------|-------------|
| 0-100 users | Daily projector per user/project — fine | Single `rt2_coin_ledger` table — fine |
| 100-1K users | Per-project graph cache prevents full rebuild — fine | Add period index on `companyId + period` — fine |
| 1K-10K users | Consider async projector queue (SQS/background job) | Add `fromActorId` + `toActorId` composite indexes |
| 10K+ users | Shard graph projections by company; async event processing | Partition `rt2_coin_ledger` by `companyId + period` |

### First Bottleneck

**wikiLLM:** Daily projector runs synchronously in `appendAndProject()` chain — could slow board response. **Fix:** Move projector to background queue with `rt2_v33_projector_state` checkpoint tracking.

**coin_ledger:** Consistency check is O(n) per actor on large tables. **Fix:** Run as background job on period close, not on every transaction.

---

## Sources

- `doc/superpowers/specs/2026-04-17-m1-4-wikillm-daily-report-design.md` — M1.4 design spec (EXTRACTED for scope, exclusions, event types)
- `doc/superpowers/specs/2026-04-17-m1-5-graphify-project-graph-design.md` — M1.5 design spec (EXTRACTED for graph schema, confidence rules, cache strategy)
- `doc/plans/2026-03-14-billing-ledger-and-reporting.md` — Billing/ledger architecture (supplies `cost_events` + `finance_events` separation, not directly used by coin_ledger but informs ledger design)
- `packages/db/src/schema/rt2_v33_domain_events.ts` — Core event schema
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — Daily wiki page schema
- `packages/db/src/schema/rt2_v33_graph_projection.ts` — Graph projection schema
- `packages/db/src/schema/rt2_personal_pnl.ts` — `rt2CoinLedger` + `rt2PersonalPnL` schema
- `server/src/services/rt2-domain-events.ts` — Event append + projector chain invocation
- `server/src/services/rt2-knowledge-projector.ts` — Existing `knowledge_core` projector (pattern reference)

---

*Architecture research for: wikiLLM/Graphify ingest cycle + coin_ledger integration*
*Researched: 2026-04-27*
