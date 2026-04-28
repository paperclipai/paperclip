# Requirements: RealTycoon2 v2.4

**Defined:** 2026-04-27
**Core Value:** 회사 범위 work signal은 disconnected tool이나 manual workflow를 강요하지 않고 logging → execution → knowledge accumulation → approval → economic feedback으로 이어져야 한다.
**Audit Closure:** v2.4 milestone audit on 2026-04-28 reset accepted coverage to 0/24 until Phase 30-32 gap closure artifacts restored traceability. Phase 32 restored accepted coverage for all 24 v2.4 requirements.

## v1 Requirements

### Phase 1: Daily Wiki Projector

- [x] **WIKI-01**: User can view daily wiki page auto-generated from board events (todo.created, todo.updated, todo.moved, etc.) — accepted via Phase 30 closure
- [x] **WIKI-02**: Daily wiki projector is replay-safe — re-running from event start produces same output — accepted via Phase 30 closure
- [x] **WIKI-03**: Daily wiki projector is idempotent — running twice doesn't duplicate content — accepted via Phase 30 closure
- [x] **WIKI-04**: User can view index.md (date-catalog of daily pages), log.md (chronological activity), per-user daily pages — accepted via Phase 30 closure
- [x] **WIKI-05**: Projector appends to existing knowledge_core chain via `appendAndProject()` — accepted via Phase 30 closure

### Phase 2: Graphify Projector

- [x] **GRAPH-01**: User can view knowledge graph projected from daily wiki pages and task metadata — accepted via Phase 30 closure
- [x] **GRAPH-02**: Graph edges carry EXTRACTED/INFERRED/AMBIGUOUS confidence tags from provenance — accepted via Phase 30 closure
- [x] **GRAPH-03**: Graph projector uses `graph_cache` hash for incremental refresh — only runs when daily wiki changes — accepted via Phase 30 closure
- [x] **GRAPH-04**: User can view graph tab with node/edge visualization — accepted via Phase 30 closure
- [x] **GRAPH-05**: User can view GRAPH_REPORT.md summarizing graph communities and edge distribution — accepted via Phase 30 closure
- [x] **GRAPH-06**: Community detection via Leiden algorithm clusters graph edges into topic groups — accepted via Phase 30 closure

### Phase 3: Coin Ledger Atomicity

- [x] **LEDGER-01**: `balanceAfter` computed atomically via SQL subquery — no read-then-write pattern
- [x] **LEDGER-02**: Income/expense pairs wrapped in `db.transaction([...])` — atomic rollback on any failure
- [x] **LEDGER-03**: Cross-table P&L reconciliation query compares `rt2CoinLedger` sum vs `rt2PersonalPnL` aggregate
- [x] **LEDGER-04**: Transaction grouping with `leg` column ('debit'/'credit') added to `rt2CoinLedger`
- [x] **LEDGER-05**: Balance non-negativity check constraint added (`balance_after >= 0`)

### Phase 4: Settlement Governance Hardening

- [x] **SETTLE-01**: Unique constraint on `(companyId, workProductId)` prevents double materialization of P&L entries
- [x] **SETTLE-02**: Anti-gaming signals (repeated_self_review, abnormal_gold_farming, quality_score_bias) displayed in settlement approval UI
- [x] **SETTLE-03**: Settlement approval shows linked ledger entry and balanceAfter
- [x] **SETTLE-04**: Configurable anti-gaming threshold UI per company (signal triggers, score windows)

### Phase 5: Consistency Linting (Batch)

- [x] **LINT-01**: Nightly batch LLM scan compares wiki pages for contradictions and inconsistencies
- [x] **LINT-02**: Lint issues flagged with evidence, not auto-fixed
- [x] **LINT-03**: `rt2WikiLintService` extended with `embedding_consistency` check
- [x] **LINT-04**: Lint runner executes on schedule, not on every wiki write

## v2 Requirements

### Knowledge

- **WIKI-V2-01**: Vector embedding + semantic search (deferred to v2+ when pgvector is ready)
- **WIKI-V2-02**: Obsidian bidirectional sync daemon (deferred, Phase 21 started this)

### Economy

- **LEDGER-V2-01**: Automated penalty execution with appeal workflow (deferred, governance policy needed)
- **LEDGER-V2-02**: Cross-company knowledge federation (outside trusted ecosystem scope)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time wiki re-linting on every change | Token cost unpredictable, blocks writes; batch is correct pattern |
| Standalone vector DB (ChromaDB, Milvus) | Contradicts embedded Postgres strategy |
| Langchain/LlamaIndex | Heavy abstraction, bundle overhead >200KB |
| Cross-company knowledge federation | Outside trusted ecosystem boundary |
| Automated penalty execution | Requires legal review and appeal workflow |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| WIKI-01 | Phase 30 | Accepted |
| WIKI-02 | Phase 30 | Accepted |
| WIKI-03 | Phase 30 | Accepted |
| WIKI-04 | Phase 30 | Accepted |
| WIKI-05 | Phase 30 | Accepted |
| GRAPH-01 | Phase 30 | Accepted |
| GRAPH-02 | Phase 30 | Accepted |
| GRAPH-03 | Phase 30 | Accepted |
| GRAPH-04 | Phase 30 | Accepted |
| GRAPH-05 | Phase 30 | Accepted |
| GRAPH-06 | Phase 30 | Accepted |
| LEDGER-01 | Phase 31 | Complete |
| LEDGER-02 | Phase 31 | Complete |
| LEDGER-03 | Phase 31 | Complete |
| LEDGER-04 | Phase 31 | Complete |
| LEDGER-05 | Phase 31 | Complete |
| SETTLE-01 | Phase 31 | Complete |
| SETTLE-02 | Phase 31 | Complete |
| SETTLE-03 | Phase 31 | Complete |
| SETTLE-04 | Phase 31 | Complete |
| LINT-01 | Phase 32 | Complete |
| LINT-02 | Phase 32 | Complete |
| LINT-03 | Phase 32 | Complete |
| LINT-04 | Phase 32 | Complete |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Accepted complete after audit: 24
- Pending gap closure: 0
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-27*
*Last updated: 2026-04-28 after Phase 32 milestone acceptance closure*
