# Issue Documents Plan

Status: Draft
Owner: Backend + UI + Agent Protocol
Primary issue: `PAP-448`

## Summary

Paperclip issue에 first-class **documents**를 추가하는 계획입니다. document는 editable, revisioned, company-scoped text artifact이며 issue에 연결됩니다.

첫 필수 convention은 key가 `plan`인 document입니다.

이 계획이 해결하려는 문제:

- plan이 issue description 안의 `<plan>` block으로 살지 않게 합니다.
- agent와 board user가 issue document를 직접 create/update할 수 있게 합니다.
- `GET /api/issues/:id`가 full `plan` document와 다른 document summary를 반환하게 합니다.
- issue detail UI가 description 아래에 document를 렌더링하게 합니다.

## Product shape

### Documents vs attachments vs artifacts

- **Documents** — stable key와 revision history를 가진 editable text content
- **Attachments** — storage-backed opaque uploaded/generated files
- **Artifacts** — future umbrella/read-model. document, attachment, preview, workspace file을 통합할 수 있음

권장: issue documents를 먼저 구현하고, attachment는 그대로 두며, full artifact unification은 실제 두 번째 consumer가 나올 때까지 미룹니다.

## Goals

1. issue에 keyed documents를 제공합니다. 시작 key는 `plan`.
2. board user와 same-company agent가 document를 edit할 수 있게 합니다.
3. append-only revision history를 보존합니다.
4. normal issue fetch에서 `plan` document를 쉽게 사용할 수 있게 합니다.
5. `<plan>`-in-description convention을 대체합니다.
6. future artifact/deliverables layer와 호환되게 유지합니다.

## Non-goals

- full collaborative doc editing
- binary file version history
- browser IDE
- full artifact system
- 모든 entity type에 대한 generalized polymorphic relation

## Key decisions

- document key는 issue 안에서 unique하고 case-insensitive입니다.
- key는 lowercase slug form으로 normalize합니다.
- `plan` key는 Paperclip workflow/docs에서 예약된 convention입니다.
- update는 `baseRevisionId`를 받아 concurrency를 확인합니다.
- mismatch 시 `409 Conflict`를 반환합니다.
- `GET /api/issues/:id`는 full `planDocument`와 `documentSummaries`를 포함하되, 모든 document body를 inline하지 않습니다.
