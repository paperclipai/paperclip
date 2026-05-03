---
title: Execution Policy
summary: Review와 approval workflow 강제 실행 정책
---

# Execution Policy

Execution policy는 task가 적절한 review/approval 단계를 거쳐 완료되도록 runtime이 강제하는 시스템입니다. agent가 기억해서 handoff하는 방식이 아니라, issue 상태 전환 자체를 Paperclip runtime이 가로채고 다음 stage로 보냅니다.

## 개요

execution policy는 issue의 optional structured object입니다. executor가 작업을 끝낸 뒤 어떤 oversight가 필요한지 정의합니다.

| Layer | 목적 | Scope |
| --- | --- | --- |
| Comment required | 모든 agent run이 issue에 comment를 남기도록 강제 | 항상 켜진 runtime invariant |
| Review stage | reviewer가 품질/정확성을 확인 | issue별 optional |
| Approval stage | manager/stakeholder가 final sign-off | issue별 optional |

review만, approval만, 둘 다 순차적으로, 또는 둘 다 없이 comment-required만 사용할 수 있습니다.

## 핵심 데이터

`executionPolicy`는 mode, commentRequired, stages를 가집니다. stage는 `review` 또는 `approval` type이고 participant는 agent 또는 user입니다.

`executionState`는 현재 stage, current participant, return assignee, completed stage, last decision을 추적합니다.

`issue_execution_decisions` table은 모든 review/approval action의 audit trail입니다.

## Happy path

1. issue가 review stage와 approval stage를 가진 상태로 생성됩니다.
2. executor가 `in_progress`에서 작업합니다.
3. executor가 `done`으로 전환하려고 하면 runtime이 가로챕니다.
4. status는 실제 `done`이 아니라 `in_review`가 되고 reviewer에게 재할당됩니다.
5. reviewer가 approve하면 다음 approval stage participant에게 넘어갑니다.
6. approver가 approve하면 최종적으로 `done`이 됩니다.

## Changes requested

reviewer가 변경을 요청하면 issue는 executor에게 돌아가고 `in_progress`가 됩니다. 변경 요청 comment는 decision record로 남습니다. executor는 수정 후 다시 review로 제출합니다.

## 운영 기준

- review/approval이 필요한 작업은 policy에 stage를 명시합니다.
- reviewer와 approver는 original executor와 분리하는 것이 좋습니다.
- decision에는 반드시 이유가 담긴 comment를 남깁니다.
- runtime이 상태 전환을 강제하므로 agent prompt에만 의존하지 않습니다.
