# Requirements: RealTycoon2 v2.4

**Defined:** 2026-04-27
**Core Value:** 회사 범위 work signal은 disconnected tool이나 manual workflow를 강요하지 않고 logging → execution → knowledge accumulation → approval → economic feedback으로 이어져야 한다.

## v1 Requirements

### Phase 1: Daily Wiki Projector

- [ ] **WIKI-01**: User can view daily wiki page auto-generated from board events (todo.created, todo.updated, todo.moved, etc.)
- [ ] **WIKI-02**: Daily wiki projector is replay-safe — re-running from event start produces same output
- [ ] **WIKI-03**: Daily wiki projector is idempotent — running twice doesn't duplicate content
- [ ] **WIKI-04**: User can view index.md (date-catalog of daily pages), log.md (chronological activity), per-user daily pages
- [ ] **WIKI-05**: Projector appends to existing knowledge_core chain via `appendAndProject()`

### Phase 2: Graphify Projector

- [ ] **GRAPH-01**: User can view knowledge graph projected from daily wiki pages and task metadata
- [ ] **GRAPH-02**: Graph edges carry EXTRACTED/INFERRED/AMBIGUOUS confidence tags from provenance
- [ ] **GRAPH-03**: Graph projector uses `graph_cache` hash for incremental refresh — only runs when daily wiki changes
- [ ] **GRAPH-04**: User can view graph tab with node/edge visualization
- [ ] **GRAPH-05**: User can view GRAPH_REPORT.md summarizing graph communities and edge distribution
- [ ] **GRAPH-06**: Community detection via Leiden algorithm clusters graph edges into topic groups

### Phase 3: Coin Ledger Atomicity

- [ ] **LEDGER-01**: `balanceAfter` computed atomically via SQL subquery — no read-then-write pattern
- [ ] **LEDGER-02**: Income/expense pairs wrapped in `db.transaction([...])` — atomic rollback on any failure
- [ ] **LEDGER-03**: Cross-table P&L reconciliation query compares `rt2CoinLedger` sum vs `rt2PersonalPnL` aggregate
- [ ] **LEDGER-04**: Transaction grouping with `leg` column ('debit'/'credit') added to `rt2CoinLedger`
- [ ] **LEDGER-05**: Balance non-negativity check constraint added (`balance_after >= 0`)

### Phase 4: Settlement Governance Hardening

- [x] **SETTLE-01**: Unique constraint on `(companyId, workProductId)` prevents double materialization of P&L entries
- [x] **SETTLE-02**: Anti-gaming signals (repeated_self_review, abnormal_gold_farming, quality_score_bias) displayed in settlement approval UI
- [x] **SETTLE-03**: Settlement approval shows linked ledger entry and balanceAfter
- [x] **SETTLE-04**: Configurable anti-gaming threshold UI per company (signal triggers, score windows)

### Phase 5: Consistency Linting (Batch)

- [ ] **LINT-01**: Nightly batch LLM scan compares wiki pages for contradictions and inconsistencies
- [ ] **LINT-02**: Lint issues flagged with evidence, not auto-fixed
- [ ] **LINT-03**: `rt2WikiLintService` extended with `embedding_consistency` check
- [ ] **LINT-04**: Lint runner executes on schedule, not on every wiki write

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
| WIKI-01 | Phase 1 | Pending |
| WIKI-02 | Phase 1 | Pending |
| WIKI-03 | Phase 1 | Pending |
| WIKI-04 | Phase 1 | Pending |
| WIKI-05 | Phase 1 | Pending |
| GRAPH-01 | Phase 2 | Pending |
| GRAPH-02 | Phase 2 | Pending |
| GRAPH-03 | Phase 2 | Pending |
| GRAPH-04 | Phase 2 | Pending |
| GRAPH-05 | Phase 2 | Pending |
| GRAPH-06 | Phase 2 | Pending |
| LEDGER-01 | Phase 3 | Pending |
| LEDGER-02 | Phase 3 | Pending |
| LEDGER-03 | Phase 3 | Pending |
| LEDGER-04 | Phase 3 | Pending |
| LEDGER-05 | Phase 3 | Pending |
| SETTLE-01 | Phase 4 | Complete |
| SETTLE-02 | Phase 4 | Complete |
| SETTLE-03 | Phase 4 | Complete |
| SETTLE-04 | Phase 4 | Complete |
| LINT-01 | Phase 5 | Pending |
| LINT-02 | Phase 5 | Pending |
| LINT-03 | Phase 5 | Pending |
| LINT-04 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-27*
*Last updated: 2026-04-27 after initial definition*
