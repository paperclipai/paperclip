# Feature Research — wikiLLM/Graphify Ingest Cycle + Coin Ledger

**Domain:** Knowledge accumulation + Economic consistency for RealTycoon2
**Researched:** 2026-04-27
**Confidence:** HIGH (based on Phase 5 research, Phase 22 settlement governance, and established RT2 infrastructure)

---

## Feature Landscape

### Table Stakes (Users Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Document ingestion (parsing + chunking)** | Users create content in various formats; system must capture it systematically | MEDIUM | RT2 already has domain event stream — ingestion maps to `appendEvent` path. Phase 5 used `processEvent` for idempotent projection. |
| **Wiki page materialization (index/log/topic)** | Cumulative knowledge must be queryable, not just stored as raw events | MEDIUM | Phase 5 already added `rt2_v33_wiki_pages` with `EXTRACTED`/`INFERRED`/`AMBIGUOUS` confidence. `rt2-knowledge-projector.ts` exists with 1139 lines. |
| **Graph node/edge persistence** | Ephemeral graph computation (old `rt2-task-mesh.ts`) doesn't survive reprojector runs | MEDIUM | Migrations `0059` and `0064` define graph tables. Drizzle schema exports were missing at Phase 5 planning time — verify current state. |
| **ACID coin ledger transactions** | Users trust gold amounts; non-atomic writes create phantom balances | HIGH | `rt2_coin_ledger` table exists with `balanceAfter` tracking. Current implementation uses Drizzle transactions, NOT raw SQL transactions. Postgres.js `sql.begin` provides full ACID but Drizzle's transaction handling must be verified for rollback correctness. |
| **Audit trail for gold movements** | Every settlement approval must be traceable; gaps create disputes | LOW | `rt2_personal_pnl`, `rt2_coin_ledger`, and `rt2SettlementGovernance` tables already have `createdAt`, `period` tracking. Activity log patterns established in Phase 21. |
| **Reimbursement/expense ledger entries** | Spending gold must be recorded and reconcilable | LOW | `transactionType` enum includes `earned`, `spent`, `transferred`, `reward`, `penalty`. Period-based indexing exists via `companyPeriodIdx`. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Provenance-aware graph edges (EXTRACTED vs INFERRED vs AMBIGUOUS)** | Distinguishes facts from AI-inferred relationships — critical for trust in AI-generated knowledge | MEDIUM | `Rt2GraphConfidence` already implements `EXTRACTED`/`INFERRED`/`AMBIGUOUS`. Evidence and rationale fields are in the contract. Phase 5 tightened these semantics. |
| **Consistency linting across wiki pages** | Catches contradictions before they compound; wiki compounding errors are hard to fix later | MEDIUM | `llm-wiki-mcp` pattern shows `lint.py` with `--deep` LLM-assisted contradiction detection. This pattern is implementable on top of existing wiki page structure. |
| **Settlement governance with anti-gaming signals** | Not just approval flow — actual game-integrity enforcement that prevents gold farming and quality score manipulation | HIGH | Phase 22 already implemented this. Signal keys include `repeated_self_review`, `abnormal_gold_farming`, `quality_score_bias`. Signals are decision-support, not automated penalty (deferred). |
| **Double-entry bookkeeping in coin ledger** | Every gold movement has source and destination; prevents unilateral "creative accounting" | MEDIUM | `rt2_coin_ledger` uses `fromActorId`/`toActorId` with `fromActorType`/`toActorType`. Balance after each transaction is tracked. True double-entry would require balanced sums — verify `balanceAfter` consistency check on reconciliation. |
| **Replay-safe knowledge projection** | Event stream replay must produce identical wiki/graph state; without this, historical reconstruction is impossible | MEDIUM | Phase 5 established `rt2DomainEventService.processEvent(projectorName, eventId)` for idempotent replay. Verify this contract is maintained in current codebase. |
| **Cumulative wiki vs daily wiki distinction** | `index.md`, `log.md`, topic pages accumulate over time; daily pages are one read model | LOW | Phase 5 decision: cumulative wiki storage added alongside existing `rt2_v33_daily_wiki_pages`. Two read models, single write path from domain events. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Real-time continuous wiki re-linting on every change** | "Keep wiki perfect at all times" | LLM linting per change is expensive, slow, and creates write storms. Contradictions are detectable at read time or batch intervals. | Scheduled deep-lint job (nightly/weekly), or lint-on-read with background refresh. |
| **Automated penalty execution from anti-gaming signals** | "Catch bad actors immediately" | Premature penalty automation without appeal process creates injustice and legal exposure. Phase 22 deferred this by design. | Human-in-the-loop decision support; penalty automation as separate future phase with appeal workflow. |
| **Public/open marketplace outside trusted company ecosystem** | "Let anyone trade with anyone" | Liability, fraud, compliance, and moderation complexity explode outside company boundary. Paperclip/RT2 scope explicitly excludes this. | Company-scoped internal marketplace with approval gates (already in Phase 7). |
| **Semantic/vector search as primary retrieval for all knowledge** | "LLM understands what I mean" | Embedding drift, hallucination in retrieval, cold-start vector population problem. BM25 + graph traversal hybrid is more deterministic. | Hybrid search: BM25 for precision, graph traversal for relationship queries, vector for semantic expansion. Phase 6 covers this. |
| **Full graph rebuild on every event** | "Keep graph always fresh" | Expensive, blocks event append, creates projector lag. Phase 5 explicitly deferred this with "rebuild should exist as recovery/admin path." | Incremental projection + explicit rebuild endpoint for recovery only. |

---

## Feature Dependencies

```
[wikiLLM/Graphify ingest cycle]
    └──requires──> [RT2 domain event stream] (Phase 4 — COMPLETED)
                        └──requires──> [append-only event append] (Phase 4 — COMPLETED)

[rt2-knowledge-projector.ts]
    └──uses──> [rt2DomainEventService.processEvent] (idempotent replay)

[Graph nodes/edges]
    └──persisted in──> [rt2_v33_graph_nodes / rt2_v33_graph_edges] (migrations 0059, 0064)
    └──requires schema──> [Drizzle schema exports] (Phase 5 flagged gap — verify)

[Coin ledger ACID transactions]
    └──requires──> [Postgres transaction support] (via Drizzle — verify rollback correctness)
    └──writes──> [rt2_coin_ledger] + [rt2_personal_pnl] (atomic pair)

[Settlement governance]
    └──depends on──> [coin ledger integrity] (prerequisite for approval flow)
    └──reads──> [anti-gaming signals] (computed from ledger history)

[Consistency linting]
    └──runs on──> [cumulative wiki pages] (materialized from domain events)
    └──triggers──> [wiki page revision] (with evidence of contradiction)

[Provenance tracking]
    └──uses──> [EXTRACTED/INFERRED/AMBIGUOUS confidence enum]
    └──stores in──> [graph edge confidence + rationale + evidence fields]

[Anti-gaming signals]
    └──reads──> [rt2_coin_ledger period aggregates]
    └──reads──> [rt2_quality_scores auto-approval rate]
    └──reads──> [rt2_settlement_governance self-review patterns]
```

### Dependency Notes

- **wikiLLM/Graphify ingest requires RT2 domain events:** Phase 4 event stream is the canonical input source, not `activity_log` or ad hoc file writes. This is established in Phase 5 decisions (D-01, D-02).
- **Graph persistence requires Drizzle schema exports:** Migrations `0059` and `0064` exist but Phase 5 flagged that schema definitions weren't exported. Verify `packages/db/src/schema/` has graph table exports before building new projector code.
- **Coin ledger ACID requires verified Drizzle transaction behavior:** Current `rt2-personal-pnl.ts` uses Drizzle API. Verify that concurrent settlement approvals don't create balance drift. Postgres.js `sql.begin` is the reference for true ACID.
- **Settlement governance depends on ledger integrity:** Phase 22 approval flow assumes ledger entries are consistent. If `balanceAfter` can diverge from computed sum, governance decisions will be based on wrong data.
- **Linting does NOT require real-time LLM calls:** Batch/scheduled lint is the pattern. Real-time would block wiki page writes and create token cost unpredictability.
- **Anti-gaming signals must NOT auto-execute penalties:** Phase 22 explicitly deferred automation. Signals are decision-support only.

---

## MVP Definition

### Launch With (v1)

- [ ] **Full ingest cycle (domain event → wiki page materialization)** — Replay-safe, idempotent projector using `processEvent`. `index.md`, `log.md`, topic pages from RT2 events. No LLM calls in write path (deterministic extraction from event payload).
- [ ] **Persisted graph nodes/edges with provenance tags** — `EXTRACTED`/`INFERRED`/`AMBIGUOUS` with evidence/rationale fields. Nodes/edges survive projector restart. Graph report read models from persisted data (not ad hoc computation).
- [ ] **ACID-compliant settlement approval ledger** — Atomic write to `rt2_coin_ledger` + `rt2_personal_pnl` on deliverable approval. Rollback on any failure. `balanceAfter` consistent with computed sum. Audit trail for all gold movements.
- [ ] **Anti-gaming signal generation** — Read ledger/quality score history, emit `repeated_self_review`, `abnormal_gold_farming`, `quality_score_bias` signals. Display in settlement approval UI. Do NOT auto-execute penalties.

### Add After Validation (v1.x)

- [ ] **Consistency linting with LLM deep scan** — Batch job comparing wiki pages for contradictions. `lint.py --deep` pattern. Trigger nightly or on-demand. Flag issues, don't auto-fix.
- [ ] **Incremental graph community detection** — Leiden algorithm clustering on persisted edges. Report communities as read model. Phase 5 deferred to admin/recovery path; this makes it an operational feature.
- [ ] **Configurable anti-gaming threshold UI** — Phase 22 deferred this. Per-company threshold configuration after operational baseline is established.

### Future Consideration (v2+)

- [ ] **Vector embedding + semantic search** — Phase 6 covers hybrid lexical/semantic retrieval. Chunks, embeddings, vector DB. Not v1 scope.
- [ ] **Obsidian bidirectional sync** — `KNOW-03` requirement. Requires vault export/import flow with conflict resolution. Phase 21 started this.
- [ ] **Automated penalty execution** — Requires appeal workflow, legal review, and governance policy. Explicitly deferred from Phase 22.
- [ ] **Cross-company knowledge federation** — Outside scope (trusted ecosystem only).

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Replay-safe wiki materialization | HIGH | MEDIUM | P1 |
| Persisted provenance graph | HIGH | MEDIUM | P1 |
| ACID settlement ledger | HIGH | HIGH | P1 |
| Anti-gaming signal display | MEDIUM | MEDIUM | P1 |
| Consistency linting (batch LLM) | MEDIUM | MEDIUM | P2 |
| Graph community detection | MEDIUM | LOW | P2 |
| Configurable thresholds UI | LOW | MEDIUM | P3 |
| Vector semantic search | MEDIUM | HIGH | P3 |
| Automated penalty execution | LOW | HIGH | P3 |
| Cross-company federation | LOW | VERY HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

| Feature | Notion / Obsidian | Linear / Jira | Our Approach |
|---------|-------------------|----------------|--------------|
| Cumulative wiki | Flat page structure, no event-driven projection | Ticket-based, no wiki layer | RT2 domain events → materialized wiki pages. Replay-safe. Provenance tracked. |
| Knowledge graph | No native graph (plugins add partial) | No graph | Persisted nodes/edges with `EXTRACTED`/`INFERRED`/`AMBIGUOUS`. Graph report read models. Incremental rebuild. |
| Provenance tracking | Source link only, no confidence tiering | No provenance on AI-generated | EXTRACTED = direct evidence. INFERRED = confidence-scored with rationale. AMBIGUOUS = flagged, not hidden. |
| Coin ledger | N/A | N/A | Company-scoped gold ledger with ACID transactions, `balanceAfter` tracking, period aggregation. Settlement governance with anti-gaming. |
| Consistency linting | No LLM-based contradiction detection | No wiki linting | Batch LLM scan with `--deep` flag. Flag contradictions, don't auto-fix. |
| Anti-gaming | N/A | N/A | Signal generation from ledger patterns. Human decision-support. Not automated punishment. |

---

## Sources

- Phase 5 research (`.planning/phases/05-wikillm-and-graphify-knowledge-core/05-RESEARCH.md`) — Domain event source, projector contract, provenance rules
- Phase 5 context (`.planning/phases/05-wikillm-and-graphify-knowledge-core/05-CONTEXT.md`) — Decisions D-01 through D-19, established patterns
- Phase 22 context (`.planning/phases/22-settlement-governance-and-anti-gaming/22-CONTEXT.md`) — Settlement flow, anti-gaming signals, ledger integration
- Phase 22 summary (`.planning/phases/22-settlement-governance-and-anti-gaming/22-01-SUMMARY.md`) — Completed implementation details
- `server/src/services/rt2-knowledge-projector.ts` — 1139-line knowledge projector (existing implementation)
- `server/src/services/rt2-personal-pnl.ts` — Settlement flow, coin ledger types, anti-gaming signal types
- `packages/db/src/schema/rt2_personal_pnl.ts` — `rt2CoinLedger` and `rt2PersonalPnL` schema
- `llm-wiki-mcp` (PyPI) — Ingest/normalize/extract/integrate/lint cycle, atomic writes with etag CAS, append-only log integrity
- Graphify patterns (Medium articles Apr 2026) — INFERRED/EXTRACTED confidence scoring, Leiden community detection, incremental graph rebuild
- Knowledges.cloud content provenance layer — artifact_id, retrieval_context, vector index snapshot, immutability patterns
- Postgres.js `sql.begin` documentation — ACID transactions, savepoints, pipelined transactions

---

## Open Questions / Research Gaps

1. **Drizzle transaction rollback correctness** — Does Drizzle's transaction API fully rollback on error, or are partial writes possible under certain failure modes? Need verification against current implementation.
2. **Drizzle schema exports for graph tables** — Phase 5 flagged that `0059` and `0064` migration tables lack Drizzle schema exports. Verify current schema directory state.
3. **balanceAfter consistency check** — Is `balanceAfter` in `rt2_coin_ledger` verified against computed sum during reconciliation? If not, what is the drift detection mechanism?
4. **LLM linting infrastructure** — Is there an LLM provider available in the RT2 server context, or would linting require a new integration?
5. **Graph community detection algorithm** — Phase 5 said "exact graph community algorithm for first pass" is agent's discretion. Leiden is the standard. Confirm algorithm choice in phase plan.

---

*Feature research for: wikiLLM/Graphify ingest cycle + coin_ledger*
*Researched: 2026-04-27*