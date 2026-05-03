---
name: paperclip-converting-plans-to-tasks
description: >
  Paperclip에서 plan을 실행 가능한 issue tree로 바꿀 때 쓰는 skill입니다.
  specialty matching, dependency, parallelization, blocker wiring을 다룹니다.
---

# Paperclip — Converting Plans to Tasks

이 skill은 plan을 Paperclip이 실행할 수 있는 task graph로 바꾸는 방법을 설명합니다. plan 형식을 강제하지는 않습니다. 어떤 형식의 plan이든 실제 issue, assignee, dependency로 변환하는 데 집중합니다.

## 계획을 task로 바꿀 때

- 충분히 자세히 씁니다. goal, constraint, unknown, success criteria, risk를 남깁니다.
- team을 확인합니다. agent 목록, role, reporting line, specialty를 보고 assign합니다.
- specialty에 맞게 assign합니다. 이름을 확인하지 않은 agent에게 무작정 넘기지 않습니다.
- 본인이 가장 적합하면 본인에게 assign합니다. delegation은 회피 수단이 아닙니다.
- concrete deliverable은 issue로 만듭니다.
- blocker는 prose가 아니라 `blockedByIssueIds`로 연결합니다.
- 독립 branch는 병렬로 시작할 수 있게 구성합니다.
- 작은 일은 과도하게 쪼개지 말고 실행되게 둡니다.

## checklist

- assignee가 다시 묻지 않고 실행할 만큼 detail이 있는가?
- concrete deliverable이 issue로 표현되었는가?
- 각 issue의 assignee가 의도적으로 선택되었는가?
- 실제 blocker가 `blockedByIssueIds`로 연결되었는가?
- 독립 branch가 병렬 실행 가능한가?
- missing skill, hire, decision, external input이 숨겨지지 않았는가?
