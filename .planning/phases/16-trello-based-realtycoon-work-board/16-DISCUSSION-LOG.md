# Phase 16: Trello-Based RealTycoon Work Board - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-25
**Phase:** 16-Trello-Based RealTycoon Work Board
**Areas discussed:** 메인 업무 표면, 카드 정보 구조, Trello형 조작, scope control

---

## 메인 업무 표면

| Option | Description | Selected |
|--------|-------------|----------|
| `/issues` 기본 board 전환 | 기존 route/API는 유지하고 사용자가 보는 기본 경험을 RealTycoon2 업무 보드로 변경 | ✓ |
| 별도 신규 route 생성 | `/tasks`를 새로 만들고 기존 issue 화면을 유지 | |
| 내부 type/route까지 rename | compatibility layer까지 즉시 변경 | |

**User's choice:** `--auto`에 따라 Phase 15 결정과 user feedback에 맞는 기본 board 전환을 선택.
**Notes:** route/type rename은 후속 migration으로 미룸.

---

## 카드 정보 구조

| Option | Description | Selected |
|--------|-------------|----------|
| 산출물/가격/OKR badge 중심 | 개발기획서의 deliverable-first, OKR traceability를 카드에 직접 노출 | ✓ |
| 기존 status/priority 카드 유지 | 기존 Paperclip board와 차이가 작음 | |
| 상세 패널 중심 | 카드가 가벼워지지만 Trello형 업무 보드 정합성이 낮음 | |

**User's choice:** 자동 선택.
**Notes:** `workProducts`, `goal`, `parentId`를 우선 재사용한다.

---

## Trello형 조작

| Option | Description | Selected |
|--------|-------------|----------|
| drag/drop + 카드 quick edit | Trello 조작감과 빠른 업무 처리 사이 균형 | ✓ |
| drag/drop only | Phase 14와 차이가 작음 | |
| modal 중심 편집 | Trello형 즉시성 부족 | |

**User's choice:** 자동 선택.
**Notes:** 카드 내 lane/status select와 priority select를 quick edit로 제공한다.

---

## Scope Control

| Option | Description | Selected |
|--------|-------------|----------|
| product-facing board 전환 | 작은 blast radius로 Phase 16 목표 달성 | ✓ |
| DB/API rename 포함 | 위험과 범위가 큼 | |
| capture channel까지 대형 구현 | Phase 16을 과도하게 확장 | |

**User's choice:** 자동 선택.
**Notes:** `CAPTURE-01`은 이번 phase에서 경로/contract gap을 문서화하고 후속으로 넘길 수 있다.

---

## the agent's Discretion

- 카드 세부 스타일, badge 색상, density는 기존 UI 패턴을 따라 구현.

## Deferred Ideas

- `/tasks` route와 `Task` type rename migration.
- Slack/Teams/native/mobile capture의 실제 배포형 entrypoint.
