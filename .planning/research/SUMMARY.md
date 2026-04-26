# Project Research Summary

**Project:** RealTycoon2 (Paperclip) — Knowledge+Economy 심화
**Domain:** wikiLLM/Graphify ingest cycle + coin ledger ACID integrity
**Researched:** 2026-04-27
**Confidence:** HIGH

## Executive Summary

This milestone extends the RT2 append-only event stream with two new subsystems: a **wikiLLM/Graphify knowledge ingest cycle** that materializes daily wiki pages and knowledge graphs from board events, and a **coin ledger ACID integrity layer** that ensures double-entry bookkeeping consistency with audit trail. Both subsystems integrate via the existing projector chain with no core schema changes required.

For wikiLLM/Graphify, the recommended approach is: domain events → daily wiki projector (M1.4) → Graphify projector (M1.5). Vector embeddings are deferred to v2+ — the MVP uses deterministic extraction from event payloads only, no LLM calls in the write path. For coin ledger, the critical fix is atomic `balanceAfter` computation using SQL subqueries instead of read-then-write, plus transaction wrapping around income/expense pairs.

**Key risks:** (1) Graph edge confidence tagging leakage — inferred edges emitted as EXTRACTED; (2) coin ledger race condition on `balanceAfter` — concurrent transactions compute from stale snapshot; (3) full graph scan on every event — O(n²) projector latency. All three are preventable with the fixes identified in research.

---

## Key Findings

### Recommended Stack

**Embedding + Vector Storage (deferred to v2+):** For v2.4 MVP, skip vector storage. The ingest cycle is deterministic extraction from event payloads. When vector search is needed (v2+), use `openai@^5.19.1` with `text-embedding-3-small` model + `pgvector@^0.3.0` on existing PGlite/Postgres — no new infrastructure. `pdf-parse@^2.x` for PDF text extraction if document ingest is needed.

**Document Parsing:** Pure TypeScript stack — `pdf-parse` (server-side) + `marked` (markdown). No OCR, no browser deps. Chunking strategy: semantic split by heading boundaries (512-token target) for wiki pages; fixed 512-token overlap for flat documents.

**Linting:** Extend existing `rt2_wiki_lint_service` — empty stubs already exist. Add `embedding_consistency` check that verifies vector chunk matches source markdown. Consistency linting runs on schedule (nightly), not on every write.

**Coin Ledger:** Extend existing `rt2CoinLedger` + `rt2PersonalPnL` schema. Add `transaction_group uuid`, `leg text` ('debit'/'credit'), and check constraint `balance_after >= 0`. Wrap income/expense pairs in `db.transaction([...])` for atomicity.

**What NOT to use:** Standalone vector DBs (ChromaDB, Milvus) — contradict embedded Postgres strategy. Langchain/LlamaIndex — heavy abstraction, 200KB+ bundle overhead. PDF.js (Mozilla) — browser-optimized, needs WebWorker in Node.js.

---

### Expected Features

**Must have (table stakes):**
- **Replay-safe wiki materialization** — Domain events → `rt2_v33_daily_wiki_pages` via idempotent projector. Board events are only input, no direct wiki writes. Index/log/topic pages from event replay.
- **Persisted provenance graph** — `rt2_v33_graph_nodes/edges` with EXTRACTED/INFERRED/AMBIGUOUS confidence tags. Nodes/edges survive projector restart.
- **ACID settlement ledger** — Atomic write to `rt2_coin_ledger` + `rt2_personal_pnl` on deliverable approval. Rollback on any failure. `balanceAfter` computed via SQL, not read-then-write.
- **Anti-gaming signal generation** — Read ledger/quality score history, emit signals (repeated_self_review, abnormal_gold_farming, quality_score_bias). Display in settlement UI. Do NOT auto-execute penalties.

**Should have (competitive):**
- **Consistency linting with LLM deep scan** — Batch job comparing wiki pages for contradictions. `lint.py --deep` pattern. Flag issues, don't auto-fix.
- **Graph community detection** — Leiden algorithm clustering on persisted edges. Report communities as read model.
- **Configurable anti-gaming thresholds UI** — Per-company threshold configuration after operational baseline.

**Defer (v2+):**
- Vector embedding + semantic search — Phase 6 covers hybrid lexical/semantic retrieval. Chunks, embeddings, vector DB.
- Automated penalty execution — Requires appeal workflow, legal review, governance policy.
- Cross-company knowledge federation — Outside trusted ecosystem scope.
- Obsidian bidirectional sync — Requires vault export/import flow with conflict resolution (Phase 21 started).

---

### Architecture Approach

Two new projectors integrate into the existing RT2 event-driven CQRS projector chain:

1. **`rt2.daily_wiki_projector`** (M1.4): Reads from `rt2_v33_domain_events`, writes to `rt2_v33_daily_wiki_pages`. Produces per-user daily pages, date-indexed catalog, and chronological activity log.

2. **`rt2.graphify_projector`** (M1.5): Reads from `rt2_v33_daily_wiki_pages` + task metadata, writes to `rt2_v33_graph_nodes/edges/reports`. Uses `graph_cache` input hash for incremental refresh. Only runs when daily wiki pages change (not on every domain event).

Both projectors extend `appendAndProject()` in `rt2-domain-events.ts` via `processEvent()`. Chain ordering: `knowledge_core` → `daily_wiki` → `graphify`. `graphify` should be conditional on daily wiki changes, not synchronous on every event.

**Major components:**
1. `rt2_v33_domain_events` — Append-only event log, source of truth
2. `rt2.daily_wiki_projector` — Materializes daily wiki pages from events
3. `rt2.graphify_projector` — Projects knowledge graph with confidence tags
4. `rt2CoinLedger` + `rt2PersonalPnL` — Append-only ledger with consistency validation

---

### Critical Pitfalls

1. **EXTRACTED/INFERRED confidence leakage** — `upsertEdge` defaults all edges to EXTRACTED. Import/resolution paths that handle operator-supplied content must pass AMBIGUOUS. Add unit test: imported edges = AMBIGUOUS.

2. **Coin ledger `balanceAfter` race condition** — Read-then-write pattern in `recordCoinTransaction`. Fix: compute `balanceAfter` via single atomic SQL expression at insert time. Never read balance before insert.

3. **Graph full-scan per event** — `refreshGraphReport` called in `projectGraphEvent` causes O(n²) latency. Fix: remove from per-event path, compute on read (lazy) or on schedule (batch).

4. **Double materialization of P&L entries** — `materializeApprovedDeliverablePnL` and `ensureSettlementRows` use non-atomic check-then-insert. Fix: unique constraint on `(companyId, workProductId)` + `ON CONFLICT DO NOTHING`.

5. **PersonalPnL vs CoinLedger divergence** — `recordIncome` and `recordCoinTransaction` are separate awaits, not wrapped in transaction. Fix: wrap each income/expense pair in `db.transaction([...])`.

---

## Implications for Roadmap

Based on research, suggested phase structure for v2.4:

### Phase 1: Daily Wiki Projector (M1.4)
**Rationale:** M1.5 Graphify projector reads from daily wiki pages — this must come first. The daily projector establishes the event → wiki materialization pattern that Graphify depends on.
**Delivers:** Board events → `rt2_v33_daily_wiki_pages` materialization. Per-user daily pages, index.md, log.md. Replay-safe, idempotent projector.
**Addresses:** Replay-safe wiki materialization (P1 from FEATURES.md)
**Avoids:** Pitfall 5 (sourceEventIds bloat) by setting practical limit on event ID accumulation

### Phase 2: Graphify Projector (M1.5)
**Rationale:** Reads from M1.4 output. Conditional execution (only when daily wiki changes) prevents the full-scan pitfall. Uses existing `rt2_v33_graph_nodes/edges` schema from migrations 0059/0064.
**Delivers:** Knowledge graph projection with EXTRACTED/INFERRED/AMBIGUOUS confidence tags. Graph tab + GRAPH_REPORT.md. Incremental refresh via `graph_cache` input hash.
**Addresses:** Persisted provenance graph (P1)
**Avoids:** Pitfall 3 (full graph scan per event) — conditional execution + hash check

### Phase 3: Coin Ledger Atomicity Fix
**Rationale:** The coin ledger race condition (Pitfall 2) and P&L divergence (Pitfall 7) are data-integrity critical. These must be fixed before settlement governance can be considered reliable.
**Delivers:** Atomic `balanceAfter` computation via SQL subquery. Transaction wrapping on income/expense pairs. Cross-table P&L reconciliation query.
**Addresses:** ACID settlement ledger (P1)
**Avoids:** Pitfalls 2 and 7

### Phase 4: Settlement Governance Hardening
**Rationale:** With ledger atomicity fixed, settlement double-materialization (Pitfall 4) and anti-gaming signals can be properly implemented. Governance depends on ledger integrity.
**Delivers:** Unique constraints on settlement reference IDs. Anti-gaming signal generation (decision-support only). Settlement approval UI with ledger entry tracking.
**Addresses:** Anti-gaming signal display (P1)
**Avoids:** Pitfall 4 (double materialization via unique constraint + ON CONFLICT DO NOTHING)

### Phase 5: Consistency Linting (Batch)
**Rationale:** Linting requires LLM infrastructure and is expensive — runs on schedule, not on write path. Deferred until core ingest + ledger are stable.
**Delivers:** Nightly batch LLM scan for wiki page contradictions. Flag issues with evidence, don't auto-fix. Extend existing `rt2_wiki_lint_service` stubs.
**Addresses:** Consistency linting (P2)
**Avoids:** Anti-pattern of real-time wiki re-linting on every change (FEATURES.md anti-features)

### Phase Ordering Rationale
- **M1.4 → M1.5** because graphify reads from daily wiki output (hard dependency)
- **Coin atomicity (Phase 3) before settlement hardening (Phase 4)** because governance assumes ledger consistency
- **Linting last (Phase 5)** because it requires stable core ingest + LLM infrastructure
- Vector embeddings deferred entirely to v2+ — not in scope for this milestone

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Graphify):** Drizzle schema exports for graph tables (0059/0064) — Phase 5 flagged this gap. Verify before building projector code.
- **Phase 3 (Ledger Atomicity):** Drizzle transaction rollback correctness — verify Drizzle's transaction API fully rolls back on error.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Daily Wiki):** Existing `rt2-knowledge-projector.ts` (1139 lines) provides complete projector pattern. Append-only event → read model projection is established.
- **Phase 4 (Settlement):** Phase 22 already implemented governance. This phase extends with atomicity fixes and unique constraints.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Context7-verified for openai SDK, pgvector, pdf-parse. RT2 already has LLM adapter patterns. |
| Features | HIGH | Based on Phase 5 + Phase 22 research with established RT2 infrastructure. |
| Architecture | HIGH | Append-only event stream + projector chain pattern fully proven in RT2 codebase. |
| Pitfalls | MEDIUM-HIGH | Identified from code analysis of existing implementation. Some race conditions require stress testing to confirm. |

**Overall confidence:** HIGH

### Gaps to Address

- **Drizzle schema exports for graph tables:** Phase 5 flagged that migrations 0059/0064 lack Drizzle exports. Verify `packages/db/src/schema/` has graph table exports before Phase 2.
- **Drizzle transaction rollback correctness:** Verify that concurrent settlement approvals don't create balance drift. Postgres.js `sql.begin` is the reference for true ACID.
- **`balanceAfter` consistency check:** Is `balanceAfter` verified against computed sum during reconciliation? If not, what is the drift detection mechanism?

---

## Sources

### Primary (HIGH confidence)
- `context7:///openai/openai-node` — Embeddings API, v5 client usage
- `context7:///pgvector/pgvector-node` — HNSW index creation, vector query syntax
- `context7:///mehmet-kozan/pdf-parse` — PDF text extraction, page ranges, TypeScript types
- `packages/db/src/schema/rt2_v33_wiki_pages.ts` — Existing wiki schema
- `packages/db/src/schema/rt2_personal_pnl.ts` — `rt2CoinLedger` + `rt2PersonalPnL` schema
- `server/src/services/rt2-wiki-lint.ts` — Existing linting patterns (empty stubs)
- `server/src/services/rt2-hybrid-search.ts` — Existing hybrid search (keyword-only)
- `doc/superpowers/specs/2026-04-17-m1-4-wikillm-daily-report-design.md` — M1.4 design spec
- `doc/superpowers/specs/2026-04-17-m1-5-graphify-project-graph-design.md` — M1.5 design spec

### Secondary (HIGH confidence)
- Phase 5 research (`.planning/phases/05-wikillm-and-graphify-knowledge-core/05-RESEARCH.md`) — Domain event source, projector contract, provenance rules
- Phase 22 research (`.planning/phases/22-settlement-governance-and-anti-gaming/22-CONTEXT.md`) — Settlement flow, anti-gaming signals
- `server/src/services/rt2-knowledge-projector.ts` — 1139-line knowledge projector (existing implementation)
- `llm-wiki-mcp` (PyPI) — Ingest/normalize/extract/integrate/lint cycle pattern
- Postgres.js `sql.begin` documentation — ACID transactions, savepoints

### Tertiary (MEDIUM confidence)
- Phase 5 threat model — EXTRACTED/INFERRED edge discipline (implementation-level verification needed)
- Graphify patterns (Medium Apr 2026) — INFERRED/EXTRACTED confidence scoring (algorithm details need phase planning)

---

*Research completed: 2026-04-27*
*Ready for roadmap: yes*
