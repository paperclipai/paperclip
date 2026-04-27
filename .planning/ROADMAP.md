# 로드맵: RealTycoon2

## 마일스톤

- [shipped] **v2.0 RT2 Refoundation** - Phase 1-7 완료, 2026-04-25 ([archive](milestones/v2.0-ROADMAP.md))
- [shipped] **v2.1 개발기획서 반영 및 운영자 채택** - Phase 8-13 완료, 2026-04-25 ([archive](milestones/v2.1-ROADMAP.md))
- [shipped] **v2.2 개발기획서 완전 정합성 고도화** - Phase 14-18 완료, 2026-04-25 ([archive](milestones/v2.2-ROADMAP.md))
- [shipped] **v2.3 운영 검증 및 외부 연동 실체화** - Phase 19-24 완료, 2026-04-27 ([archive](milestones/v2.3-ROADMAP.md), [requirements](milestones/v2.3-REQUIREMENTS.md), [audit](milestones/v2.3-MILESTONE-AUDIT.md))
- [active] **v2.4 Knowledge+Economy 심화** - Phase 25-29 진행 중

## 완료됨

<details>
<summary>v2.0 RT2 Refoundation (Phase 1-7) - 2026-04-25 완료</summary>

- [x] Phase 1: RT2 Shell and Product Truth - 2/2 plans complete
- [x] Phase 2: One-Liner and Deliverable Capture - 6/6 plans complete
- [x] Phase 3: Multica Execution Backbone - 1/1 plan complete
- [x] Phase 4: CQRS Event Stream and Projections - 1/1 plan complete
- [x] Phase 5: wikiLLM and Graphify Knowledge Core - 1/1 plan complete
- [x] Phase 6: Jarvis, Quality, and Hybrid Search - 1/1 plan complete
- [x] Phase 7: Amoeba Economy, Collaboration, and Marketplace - 1/1 plan complete

</details>

<details>
<summary>v2.1 개발기획서 반영 및 운영자 채택 (Phase 8-13) - 2026-04-25 완료</summary>

- [x] Phase 8: 개발기획서 반영 기준선 - 1/1 plan complete
- [x] Phase 9: Friction-Zero Capture Surfaces - 1/1 plan complete
- [x] Phase 10: Daily Report and OKR/KPI Cockpit - 1/1 plan complete
- [x] Phase 11: Task Mesh and Knowledge Workspace - 1/1 plan complete
- [x] Phase 12: Jarvis Runtime and Change Management - 1/1 plan complete
- [x] Phase 13: Enterprise Rollout and RT2 Terminology - 1/1 plan complete

</details>

<details>
<summary>v2.2 개발기획서 완전 정합성 고도화 (Phase 14-18) - 2026-04-25 완료</summary>

- [x] Phase 14: Daily Kanban Trello Parity - 1/1 plan complete
- [x] Phase 15: Identity Shell Hardening - 1/1 plan complete
- [x] Phase 16: Trello-Based RealTycoon Work Board - 1/1 plan complete
- [x] Phase 17: Knowledge Bridge Completion - 1/1 plan complete
- [x] Phase 18: Economy and Rollout Depth - 1/1 plan complete

Audit status: `tech_debt` because Phase 14-18 `VALIDATION.md` artifacts were missing at close, but requirements 11/11 and integration flows 5/5 passed.

</details>

<details>
<summary>v2.3 운영 검증 및 외부 연동 실체화 (Phase 19-24) - 2026-04-27 완료</summary>

- [x] Phase 19: Validation and Route Test Hardening - 1/1 plan complete
- [x] Phase 20: Enterprise Rollout Connectors - 1/1 plan complete
- [x] Phase 21: Obsidian Bidirectional Knowledge Sync - 1/1 plan complete
- [x] Phase 22: Settlement Governance and Anti-Gaming - 1/1 plan complete
- [x] Phase 23: Advanced Work Board and Native Capture - 1/1 plan complete
- [x] Phase 24: Phase 19 Verification Artifact Closure - 1/1 plan complete

Audit status: `tech_debt`. Requirements 17/17, phases 6/6, integration 5/5, flows 5/5 passed. 남은 부채는 Phase 19-24 strict Nyquist `*-VALIDATION.md`와 일부 운영 hardening 항목이다.

</details>

## 활성 마일스톤

### v2.4 Knowledge+Economy 심화

**상태:** 진행 중  
**시작:** 2026-04-27  
**Phase:** 25-29  
**Requirements:** 24 total (5+6+5+4+4)

## Phase Details

### Phase 25: Daily Wiki Projector

**Goal**: Users can view auto-generated daily wiki pages derived from board events, organized by date and user

**Depends on**: Nothing (first phase of milestone)

**Requirements**: WIKI-01, WIKI-02, WIKI-03, WIKI-04, WIKI-05

**Success Criteria** (what must be TRUE):
1. User can view a daily wiki page listing all board events (todo.created, todo.updated, todo.moved, task.completed, etc.) for a selected date
2. User can navigate to index.md showing a date-catalog of all daily pages and log.md showing chronological activity across dates
3. User can view per-user daily pages showing activity filtered to a specific user
4. Re-running the daily wiki projector from event start produces bit-identical output (replay-safe)
5. Running the projector twice does not duplicate content in wiki pages (idempotent)
6. Daily wiki projector appends to existing knowledge_core chain via `appendAndProject()`

**Plans**: TBD

### Phase 26: Graphify Projector

**Goal**: Users can view a knowledge graph with confidence-tagged edges, incremental refresh, and community detection

**Depends on**: Phase 25 (daily wiki projector must complete first — graph reads wiki output)

**Requirements**: GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04, GRAPH-05, GRAPH-06

**Success Criteria** (what must be TRUE):
1. User can view a knowledge graph visualization showing nodes and edges from daily wiki pages and task metadata
2. Graph edges display EXTRACTED/INFERRED/AMBIGUOUS confidence tags based on provenance
3. Graph projector re-runs only when daily wiki content changed (graph_cache hash comparison)
4. User can view graph tab with interactive node/edge visualization
5. User can view GRAPH_REPORT.md summarizing graph communities and edge distribution
6. Leiden algorithm detects communities and clusters edges into topic groups

**Plans**: TBD
**UI hint**: yes

### Phase 27: Coin Ledger Atomicity

**Goal**: Ledger balance operations are atomic and consistent — no read-then-write race conditions

**Depends on**: Nothing (ledger foundation, independent of wiki/graph)

**Requirements**: LEDGER-01, LEDGER-02, LEDGER-03, LEDGER-04, LEDGER-05

**Success Criteria** (what must be TRUE):
1. `balanceAfter` is computed via SQL subquery in a single atomic write — no application-level read-then-write
2. Income/expense ledger pairs are wrapped in `db.transaction([...])` and roll back together on any failure
3. Cross-table P&L query shows `rt2CoinLedger` sum equals `rt2PersonalPnL` aggregate (reconciliation pass)
4. `rt2CoinLedger` has a `leg` column ('debit'/'credit') for transaction grouping
5. `balance_after >= 0` check constraint prevents negative balance entries

**Plans**: TBD

### Phase 28: Settlement Governance Hardening

**Goal**: Settlement approval flow is protected by unique constraints and displays anti-gaming signals with configurable thresholds

**Depends on**: Phase 27 (ledger integrity must be established before governance hardening)

**Requirements**: SETTLE-01, SETTLE-02, SETTLE-03, SETTLE-04

**Success Criteria** (what must be TRUE):
1. Database enforces unique constraint on (companyId, workProductId) — attempting to create duplicate settlement returns an error
2. Settlement approval UI displays anti-gaming signals: repeated_self_review, abnormal_gold_farming, quality_score_bias
3. Settlement approval screen shows linked ledger entry and balanceAfter value
4. User can configure anti-gaming signal thresholds per company (trigger values, score windows)

**Plans**: TBD
**UI hint**: yes

### Phase 29: Consistency Linting (Batch)

**Goal**: Wiki consistency is audited nightly by LLM — issues are flagged with evidence, not auto-fixed

**Depends on**: Phase 26 (graph projector stabilizes wiki content before linting runs)

**Requirements**: LINT-01, LINT-02, LINT-03, LINT-04

**Success Criteria** (what must be TRUE):
1. Nightly batch job runs LLM scan comparing wiki pages for contradictions and inconsistencies
2. Lint issues are flagged with evidence snippets — system does not auto-modify wiki content
3. `rt2WikiLintService` includes an `embedding_consistency` check comparing semantic similarity
4. Lint runner executes on a schedule (cron/timer), not triggered on every wiki write

**Plans**: TBD

## 진행상황

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. RT2 Shell and Product Truth | v2.0 | 2/2 | Complete | 2026-04-24 |
| 2. One-Liner and Deliverable Capture | v2.0 | 6/6 | Complete | 2026-04-24 |
| 3. Multica Execution Backbone | v2.0 | 1/1 | Complete | 2026-04-24 |
| 4. CQRS Event Stream and Projections | v2.0 | 1/1 | Complete | 2026-04-24 |
| 5. wikiLLM and Graphify Knowledge Core | v2.0 | 1/1 | Complete | 2026-04-25 |
| 6. Jarvis, Quality, and Hybrid Search | v2.0 | 1/1 | Complete | 2026-04-25 |
| 7. Amoeba Economy, Collaboration, and Marketplace | v2.0 | 1/1 | Complete | 2026-04-25 |
| 8. Dev Plan Alignment Baseline | v2.1 | 1/1 | Complete | 2026-04-25 |
| 9. Friction-Zero Capture Surfaces | v2.1 | 1/1 | Complete | 2026-04-25 |
| 10. Daily Report and OKR/KPI Cockpit | v2.1 | 1/1 | Complete | 2026-04-25 |
| 11. Task Mesh and Knowledge Workspace | v2.1 | 1/1 | Complete | 2026-04-25 |
| 12. Jarvis Runtime and Change Management | v2.1 | 1/1 | Complete | 2026-04-25 |
| 13. Enterprise Rollout and RT2 Terminology | v2.1 | 1/1 | Complete | 2026-04-25 |
| 14. Daily Kanban Trello Parity | v2.2 | 1/1 | Complete | 2026-04-25 |
| 15. Identity Shell Hardening | v2.2 | 1/1 | Complete | 2026-04-25 |
| 16. Trello-Based RealTycoon Work Board | v2.2 | 1/1 | Complete | 2026-04-25 |
| 17. Knowledge Bridge Completion | v2.2 | 1/1 | Complete | 2026-04-25 |
| 18. Economy and Rollout Depth | v2.2 | 1/1 | Complete | 2026-04-25 |
| 19. Validation and Route Test Hardening | v2.3 | 1/1 | Complete | 2026-04-25 |
| 20. Enterprise Rollout Connectors | v2.3 | 1/1 | Complete | 2026-04-25 |
| 21. Obsidian Bidirectional Knowledge Sync | v2.3 | 1/1 | Complete | 2026-04-25 |
| 22. Settlement Governance and Anti-Gaming | v2.3 | 1/1 | Complete | 2026-04-25 |
| 23. Advanced Work Board and Native Capture | v2.3 | 1/1 | Complete | 2026-04-25 |
| 24. Phase 19 Verification Artifact Closure | v2.3 | 1/1 | Complete | 2026-04-27 |
| 25. Daily Wiki Projector | v2.4 | 0/1 | Not started | - |
| 26. Graphify Projector | v2.4 | 0/1 | Not started | - |
| 27. Coin Ledger Atomicity | v2.4 | 0/1 | Not started | - |
| 28. Settlement Governance Hardening | v2.4 | 0/1 | Not started | - |
| 29. Consistency Linting (Batch) | v2.4 | 0/1 | Not started | - |

## Archive

- [v2.0 roadmap archive](milestones/v2.0-ROADMAP.md)
- [v2.0 requirements archive](milestones/v2.0-REQUIREMENTS.md)
- [v2.1 roadmap archive](milestones/v2.1-ROADMAP.md)
- [v2.1 requirements archive](milestones/v2.1-REQUIREMENTS.md)
- [v2.1 development-plan alignment](DEVPLAN-ALIGNMENT.md)
- [v2.2 roadmap archive](milestones/v2.2-ROADMAP.md)
- [v2.2 requirements archive](milestones/v2.2-REQUIREMENTS.md)
- [v2.2 milestone audit](milestones/v2.2-MILESTONE-AUDIT.md)
- [v2.3 roadmap archive](milestones/v2.3-ROADMAP.md)
- [v2.3 requirements archive](milestones/v2.3-REQUIREMENTS.md)
- [v2.3 milestone audit](milestones/v2.3-MILESTONE-AUDIT.md)

---
*마지막 업데이트: 2026-04-27, v2.4 milestone started*