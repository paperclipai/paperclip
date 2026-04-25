# 로드맵: RealTycoon2

## 마일스톤

- [shipped] **v2.0 RT2 Refoundation** - Phase 1-7 완료, 2026-04-25 ([archive](milestones/v2.0-ROADMAP.md))
- [shipped] **v2.1 개발기획서 반영 및 운영자 채택** - Phase 8-13 완료, 2026-04-25 ([archive](milestones/v2.1-ROADMAP.md))
- [shipped] **v2.2 개발기획서 완전 정합성 고도화** - Phase 14-18 완료, 2026-04-25 ([archive](milestones/v2.2-ROADMAP.md))
- [active] **v2.3 운영 검증 및 외부 연동 실체화** - Phase 19-23 진행 예정

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

## 현재 위치

v2.3 운영 검증 및 외부 연동 실체화 마일스톤을 시작했다. 다음 실행 항목은 Phase 19 discussion이다.

<details>
<summary>v2.2 개발기획서 완전 정합성 고도화 (Phase 14-18) - 2026-04-25 완료</summary>

- [x] Phase 14: Daily Kanban Trello Parity - 1/1 plan complete
- [x] Phase 15: Identity Shell Hardening - 1/1 plan complete
- [x] Phase 16: Trello-Based RealTycoon Work Board - 1/1 plan complete
- [x] Phase 17: Knowledge Bridge Completion - 1/1 plan complete
- [x] Phase 18: Economy and Rollout Depth - 1/1 plan complete

Audit status: `tech_debt` because Phase 14-18 `VALIDATION.md` artifacts are missing, but requirements 11/11 and integration flows 5/5 passed.

</details>

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
| 19. Validation and Route Test Hardening | v2.3 | 0/1 | Not Started | - |
| 20. Enterprise Rollout Connectors | v2.3 | 0/1 | Not Started | - |
| 21. Obsidian Bidirectional Knowledge Sync | v2.3 | 0/1 | Not Started | - |
| 22. Settlement Governance and Anti-Gaming | v2.3 | 0/1 | Not Started | - |
| 23. Advanced Work Board and Native Capture | v2.3 | 0/1 | Not Started | - |

## v2.3 운영 검증 및 외부 연동 실체화

**Goal:** v2.2에서 `tech_debt`로 남긴 검증 산출물과 개발기획서 remaining 6% gap을 실제 운영 가능한 외부 연동, 지식 동기화, settlement governance, advanced board/capture 흐름으로 닫는다.

| Phase | Name | Goal | Requirements | Success Criteria |
|-------|------|------|--------------|------------------|
| 19 | Validation and Route Test Hardening | Phase 14-18 검증 부채와 skipped route suite를 닫는다 | VALID-01, VALID-02, VALID-03 | 3 |
| 20 | Enterprise Rollout Connectors | SSO/SCIM/provider validation을 검수 가능한 rollout flow로 만든다 | ENT-02, ENT-03, ENT-04 | 4 |
| 21 | Obsidian Bidirectional Knowledge Sync | Knowledge Bridge를 preview-only에서 승인 가능한 양방향 sync로 고도화한다 | KNOW-02, KNOW-03, KNOW-04 | 4 |
| 22 | Settlement Governance and Anti-Gaming | 가격 협상, settlement approval, anti-gaming signal을 gold/P&L/audit과 연결한다 | ECON-02, ECON-03, ECON-04 | 4 |
| 23 | Advanced Work Board and Native Capture | Trello advanced parity와 mobile/native capture queue를 완성한다 | TRELLO-03, TRELLO-04, TRELLO-05, CAPTURE-02, CAPTURE-03 | 5 |

### Phase 19: Validation and Route Test Hardening

**Goal:** v2.2의 기능 완료 상태를 strict validation artifact와 실행 가능한 route test evidence로 보강한다.

**Requirements:** VALID-01, VALID-02, VALID-03

**Success criteria:**
1. Phase 14-18 각각에 `VALIDATION.md`가 생성되고 requirement/evidence/verification/risk가 연결된다.
2. Phase 17-18 route suites가 embedded Postgres 제약을 우회하는 fixture 또는 fallback으로 실행된다.
3. alignment scorecard가 validation 상태를 `tech_debt`, `validated`, `deferred`로 실제 산출물과 동기화한다.

### Phase 20: Enterprise Rollout Connectors

**Goal:** enterprise rollout 화면을 saved setting preview에서 실제 SSO/SCIM/provider 검증 흐름으로 확장한다.

**Requirements:** ENT-02, ENT-03, ENT-04

**Success criteria:**
1. SSO provider metadata 입력/업로드에 issuer, URL, certificate, callback 검증 결과가 표시된다.
2. SCIM sync preview가 user/group create/update/deactivate 후보와 위험 경고를 제공한다.
3. rollout readiness 화면이 SSO, SCIM, binding, policy 검증 상태를 한 화면에서 보여준다.
4. 중요한 rollout 검증과 적용 시도가 audit log에 남는다.

### Phase 21: Obsidian Bidirectional Knowledge Sync

**Goal:** Knowledge Bridge를 export/import preview에서 승인 가능한 local vault write와 bidirectional conflict resolution으로 확장한다.

**Requirements:** KNOW-02, KNOW-03, KNOW-04

**Success criteria:**
1. vault writer 설정과 dry-run 결과가 저장되고 operator UI에서 확인된다.
2. import preview 후보가 wiki page, graph node, graph edge 변경으로 분리된다.
3. 승인된 import 후보만 RT2-controlled knowledge store에 반영된다.
4. sync conflict는 `RT2 wins`, `Vault wins`, `manual merge` 결정과 감사 근거를 남긴다.

### Phase 22: Settlement Governance and Anti-Gaming

**Goal:** 경제 시스템을 evidence display에서 승인 가능한 settlement governance로 확장한다.

**Requirements:** ECON-02, ECON-03, ECON-04

**Success criteria:**
1. 산출물 가격 제안, 근거, 협상 코멘트, 승인 상태가 하나의 flow로 보인다.
2. 승인/반려가 gold ledger, P&L, audit log에 일관되게 반영된다.
3. 고가 또는 위험 settlement는 approval gate를 요구한다.
4. anti-gaming signal이 settlement 검토에 노출되고 결정 근거로 기록된다.

### Phase 23: Advanced Work Board and Native Capture

**Goal:** Trello 기반 RealTycoon2 업무 보드를 실제 반복 업무에 필요한 checklist/due/attachment/filter 기능과 native capture queue로 완성한다.

**Requirements:** TRELLO-03, TRELLO-04, TRELLO-05, CAPTURE-02, CAPTURE-03

**Success criteria:**
1. 카드 checklist 추가/완료/재정렬과 진행률 표시가 동작한다.
2. due date, priority, assignee, attachment preview가 카드와 상세 패널에 반영된다.
3. board filter/sort가 lane, 담당자, OKR, due date, 가격, 품질 상태를 지원한다.
4. mobile/native inbound draft queue에서 entry를 review하고 Task/To-Do/Deliverable로 승격할 수 있다.
5. capture source별 실패, 중복, 권한 문제가 감사 가능한 상태로 추적된다.

## Archive

- [v2.0 roadmap archive](milestones/v2.0-ROADMAP.md)
- [v2.0 requirements archive](milestones/v2.0-REQUIREMENTS.md)
- [v2.1 roadmap archive](milestones/v2.1-ROADMAP.md)
- [v2.1 requirements archive](milestones/v2.1-REQUIREMENTS.md)
- [v2.1 development-plan alignment](DEVPLAN-ALIGNMENT.md)
- [v2.2 roadmap archive](milestones/v2.2-ROADMAP.md)
- [v2.2 requirements archive](milestones/v2.2-REQUIREMENTS.md)
- [v2.2 milestone audit](milestones/v2.2-MILESTONE-AUDIT.md)

---
*마지막 업데이트: 2026-04-25, v2.3 운영 검증 및 외부 연동 실체화 시작*
