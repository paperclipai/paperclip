# 로드맵: RealTycoon2

## 마일스톤

- [shipped] **v2.0 RT2 Refoundation** - Phase 1-7 완료, 2026-04-25 ([archive](milestones/v2.0-ROADMAP.md))
- [shipped] **v2.1 개발기획서 반영 및 운영자 채택** - Phase 8-13 완료, 2026-04-25 ([archive](milestones/v2.1-ROADMAP.md))
- [shipped] **v2.2 개발기획서 완전 정합성 고도화** - Phase 14-18 완료, 2026-04-25 ([archive](milestones/v2.2-ROADMAP.md))
- [shipped] **v2.3 운영 검증 및 외부 연동 실체화** - Phase 19-24 완료, 2026-04-27 ([archive](milestones/v2.3-ROADMAP.md), [requirements](milestones/v2.3-REQUIREMENTS.md), [audit](milestones/v2.3-MILESTONE-AUDIT.md))
- [shipped] **v2.4 Knowledge+Economy 심화** - Phase 25-32 완료, 2026-04-28 ([archive](milestones/v2.4-ROADMAP.md), [requirements](milestones/v2.4-REQUIREMENTS.md), [audit](milestones/v2.4-MILESTONE-AUDIT.md), [re-audit](milestones/v2.4-MILESTONE-REAUDIT.md))
- [active] **v2.5 Semantic Knowledge Intelligence** - Phase 33-38 진행 중, Phase 38 audit gap closure planned ([requirements](REQUIREMENTS.md), [audit](v2.5-MILESTONE-AUDIT.md))

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

<details>
<summary>v2.4 Knowledge+Economy 심화 (Phase 25-32) - 2026-04-28 완료</summary>

- [x] Phase 25: Daily Wiki Projector - 1/1 plan complete
- [x] Phase 26: Graphify Projector - 1/1 plan complete
- [x] Phase 27: Coin Ledger Atomicity - 3/3 plans complete
- [x] Phase 28: Settlement Governance Hardening - 1/1 plan complete
- [x] Phase 29: Consistency Linting (Batch) - 1/1 plan complete
- [x] Phase 30: Knowledge Artifact and Verification Closure - 1/1 plan complete
- [x] Phase 31: Economy Artifact and Verification Closure - 1/1 plan complete
- [x] Phase 32: Lint Traceability and Milestone Acceptance Closure - 1/1 plan complete

Initial audit status: `gaps_found`. Phase 30-32 closed missing summary, verification, validation, and requirement frontmatter gaps. Final re-audit status: `passed` with requirements 24/24, phases 5/5, integration 5/5, flows 5/5.

</details>

## 현재 위치

v2.5 Semantic Knowledge Intelligence의 Phase 33-37 구현은 완료되었고, milestone audit에서 확인된 verification/validation artifact gap을 Phase 38에서 닫는다.

## 진행 예정

### v2.5 Semantic Knowledge Intelligence (Phase 33-38)

**Goal:** Daily wiki/graph knowledge를 embedding-backed semantic retrieval, contradiction review, Jarvis answer grounding, operator-facing knowledge health로 고도화하고 milestone close 전에 verification/validation traceability를 완결한다.

| Phase | Name | Goal | Requirements | Success Criteria |
|-------|------|------|--------------|------------------|
| 33 | Semantic Index Foundation | Existing wiki/graph/work evidence를 company-scoped semantic index에 안전하게 적재한다 | SEM-01, SEM-02, SEM-03, SEM-04 | 4 |
| 34 | Semantic Knowledge Search | Operator가 RT2 knowledge를 semantic + lexical fallback으로 탐색한다 | SEARCH-01, SEARCH-02, SEARCH-03, SEARCH-04 | 4 |
| 35 | Contradiction Review Workflow | 새 evidence와 기존 knowledge 사이의 충돌 후보를 review/audit loop로 만든다 | CONTRA-01, CONTRA-02, CONTRA-03, CONTRA-04 | 4 |
| 36 | Jarvis Grounded Answers | Jarvis 답변이 semantic context, citation, contradiction warning을 노출한다 | JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04 | 4 |
| 37 | Knowledge Intelligence Operations | 운영자가 semantic/contradiction/Jarvis knowledge health를 검증하고 gate로 관리한다 | OPS-01, OPS-02, OPS-03 | 4 |
| 38 | Semantic Knowledge Artifact Closure | v2.5 milestone audit에서 발견된 verification, validation, requirements traceability gap을 닫는다 | JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04 | 4 |

#### Phase 33: Semantic Index Foundation

Goal: Existing daily wiki, graph, work artifact source를 교체하지 않고 embedding-ready semantic index layer를 추가한다.

Requirements: SEM-01, SEM-02, SEM-03, SEM-04

Success criteria:
1. Company-scoped semantic index schema/service/API가 source ID, source type, freshness, provenance를 보존한다.
2. Daily wiki page, graph node, work artifact가 incremental reindex 대상이 된다.
3. Provider가 없어도 deterministic local embedding fallback으로 tests가 통과한다.
4. Operator가 reindex run 상태와 changed-source refresh 결과를 확인할 수 있다.

#### Phase 34: Semantic Knowledge Search

Goal: Operator가 wiki/graph/work evidence를 한 surface에서 semantic ranking과 lexical fallback으로 찾는다.

Requirements: SEARCH-01, SEARCH-02, SEARCH-03, SEARCH-04

Success criteria:
1. Search API가 company boundary 안에서 semantic result와 lexical fallback result를 결합한다.
2. 결과는 source type, date, confidence, evidence snippet, freshness indicator를 보여준다.
3. UI는 project/work object, date range, source type, confidence, contradiction status filter를 제공한다.
4. pgvector가 없는 local dev에서도 deterministic ranking으로 route/component tests가 통과한다.

#### Phase 35: Contradiction Review Workflow

Goal: Knowledge conflict를 silent failure가 아니라 review 가능한 후보와 audit trail로 만든다.

Requirements: CONTRA-01, CONTRA-02, CONTRA-03, CONTRA-04

Success criteria:
1. New wiki/graph facts가 prior evidence와 deterministic lint result를 기준으로 contradiction candidate를 만든다.
2. Provider-backed explanation은 optional이고 raw evidence, deterministic reason code가 항상 남는다.
3. Operator는 false positive, newer evidence, older evidence, follow-up work 중 하나로 resolution할 수 있다.
4. Resolution event가 audit/event trail, wiki/graph/search freshness indicator에 반영된다.

#### Phase 36: Jarvis Grounded Answers

Goal: Jarvis가 RT2 semantic knowledge를 사용하되, citation과 contradiction warning으로 운영자가 검증 가능하게 답한다.

Requirements: JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04

Success criteria:
1. Jarvis answer flow가 semantic retrieval context를 받아 cited evidence를 표시한다.
2. Unresolved contradiction이나 stale evidence가 있으면 answer surface에 warning이 표시된다.
3. Operator는 answer citation에서 work object, wiki page, graph node, contradiction item으로 이동할 수 있다.
4. Retrieval과 answer context는 company boundary와 existing permission assumptions를 유지한다.

#### Phase 37: Knowledge Intelligence Operations

Goal: Semantic knowledge 기능을 운영자가 health gate와 verification artifact로 신뢰할 수 있게 만든다.

Requirements: OPS-01, OPS-02, OPS-03

Success criteria:
1. Operator dashboard가 index health, queue status, stale source count, provider/fallback mode, last successful run을 보여준다.
2. Batch health check가 semantic index, contradiction review, Jarvis grounding traceability 손실을 명확히 실패로 보고한다.
3. Phase verification artifacts가 요구사항 19개 전체의 tests, route evidence, user-facing flow note를 포함한다.
4. Milestone close 전에 requirements traceability, phase summaries, validation artifacts가 누락 없이 갱신된다.

#### Phase 38: Semantic Knowledge Artifact Closure

Goal: v2.5 milestone audit의 `gaps_found`를 닫기 위해 누락된 phase verification, Nyquist validation, requirements checkbox/frontmatter 정합성을 완결한다.

Requirements: JARVIS-01, JARVIS-02, JARVIS-03, JARVIS-04

Gap Closure: `.planning/v2.5-MILESTONE-AUDIT.md`

Success criteria:
1. Phase 34, 35, 36의 `*-VERIFICATION.md`가 생성되고 각 requirement evidence를 phase-local로 검증한다.
2. Phase 36 `36-01-SUMMARY.md`가 YAML frontmatter와 `requirements-completed` 목록을 갖는다.
3. Phase 33-37의 `*-VALIDATION.md`가 생성되거나 명시적으로 waiver되어 Nyquist coverage가 audit 가능한 상태가 된다.
4. `.planning/REQUIREMENTS.md`의 v2.5 checkbox와 traceability가 milestone close 기준으로 정합성을 갖고, 재감사에서 `passed`가 가능하다.

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
| 25. Daily Wiki Projector | v2.4 | 1/1 | Complete | 2026-04-28 |
| 26. Graphify Projector | v2.4 | 1/1 | Complete | 2026-04-28 |
| 27. Coin Ledger Atomicity | v2.4 | 3/3 | Complete | 2026-04-28 |
| 28. Settlement Governance Hardening | v2.4 | 1/1 | Complete | 2026-04-28 |
| 29. Consistency Linting (Batch) | v2.4 | 1/1 | Complete | 2026-04-28 |
| 30. Knowledge Artifact and Verification Closure | v2.4 | 1/1 | Complete | 2026-04-28 |
| 31. Economy Artifact and Verification Closure | v2.4 | 1/1 | Complete | 2026-04-28 |
| 32. Lint Traceability and Milestone Acceptance Closure | v2.4 | 1/1 | Complete | 2026-04-28 |
| 33. Semantic Index Foundation | v2.5 | 1/1 | Complete | 2026-04-28 |
| 34. Semantic Knowledge Search | v2.5 | 1/1 | Complete with verification gap | 2026-04-28 |
| 35. Contradiction Review Workflow | v2.5 | 1/1 | Complete with verification gap | 2026-04-28 |
| 36. Jarvis Grounded Answers | v2.5 | 1/1 | Complete with artifact gap | 2026-04-28 |
| 37. Knowledge Intelligence Operations | v2.5 | 1/1 | Complete | 2026-04-28 |
| 38. Semantic Knowledge Artifact Closure | v2.5 | 0/1 | Planned | - |

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
- [v2.4 roadmap archive](milestones/v2.4-ROADMAP.md)
- [v2.4 requirements archive](milestones/v2.4-REQUIREMENTS.md)
- [v2.4 milestone audit](milestones/v2.4-MILESTONE-AUDIT.md)
- [v2.4 milestone re-audit](milestones/v2.4-MILESTONE-REAUDIT.md)
- [v2.5 milestone audit](v2.5-MILESTONE-AUDIT.md)

---
*마지막 업데이트: 2026-04-29, v2.5 gap closure phase planned*
