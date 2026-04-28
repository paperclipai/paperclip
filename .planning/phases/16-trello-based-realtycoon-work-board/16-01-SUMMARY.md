# Phase 16 Summary: Trello-Based RealTycoon Work Board

**완료일:** 2026-04-25
**상태:** Complete

## 완료한 것

- `/issues` 메인 진입을 `realtycoon2:work-board` storage key의 board-first 경험으로 전환했다.
- breadcrumb와 empty state를 `업무 보드`/RealTycoon2 작업 경험으로 변경했다.
- `KanbanBoard`를 RealTycoon2 업무 보드 카드로 고도화했다.
- 카드에 Task/To-Do 구분, identifier, 담당자, 우선순위, 산출물 count, 가격 badge, OKR badge, primary deliverable, To-Do count를 표시한다.
- 기존 `@dnd-kit` drag/drop status 이동을 유지했다.
- 카드 내 lane/status select와 priority select로 빠른 편집을 추가했다.
- board header와 각 lane에서 새 작업 생성이 가능하며 lane status default를 create dialog에 전달한다.
- `IssuesList`는 list mode를 유지하되, Phase 16 메인 surface에서는 board를 기본값으로 사용한다.
- One-Liner inbound draft source contract를 `slack`, `teams`, `webhook`, `mobile`, `native`로 확장했다.
- One-Liner 화면에 Slack/Teams/Mobile/Native capture entrypoint와 검수 가능한 `POST /api/companies/:companyId/rt2/one-liner/inbound-draft` route를 표시했다.

## 검증

- `pnpm exec vitest run src/components/KanbanBoard.test.tsx src/components/IssuesList.test.tsx`
  - 2 files passed, 15 tests passed
- `pnpm --filter @paperclipai/ui typecheck`
  - passed
- `pnpm exec vitest run packages/shared/src/rt2-task.test.ts`
  - 1 file passed, 7 tests passed
- `pnpm --filter @paperclipai/shared typecheck`
  - passed
- `pnpm --filter @paperclipai/server typecheck`
  - passed

## 요구사항 결과

- `TRELLO-01`: 완료
- `TRELLO-02`: 완료
- `CAPTURE-01`: 완료

## 남은 위험

- 내부 route/type/API는 여전히 `Issue`/`/issues` compatibility layer를 사용한다. 사용자 표면은 감쌌지만 완전한 domain rename migration은 별도 phase가 필요하다.
- 가격 badge는 현재 `workProducts.metadata`의 알려진 가격 key를 읽는 방식이다. 장기적으로 deliverable price read model과 직접 연결하는 것이 더 정확하다.
- Mobile/Native capture는 contract와 route 검수 표면까지 완료했다. 실제 native app distribution은 별도 배포 phase가 필요하다.
