---
name: diagnose-why-work-stopped
description: >
  작업이 왜 멈췄는지, 왜 loop에 빠졌는지, 왜 복구가 과하게 반복됐는지 조사할 때 쓰는 skill입니다.
  먼저 issue tree를 forensic하게 조사하고, 정확한 stop point를 찾은 뒤, product rule 관점의 계획을 작성합니다.
---

# Diagnose Why Work Stopped

이 skill은 stalled / looping / over-recovered issue tree를 진단하기 위한 절차입니다. engineering 구현 skill이 아니라 **진단 + product design** skill입니다. 결과물은 root cause와 board/CTO approval을 받을 수 있는 plan입니다.

## 사용할 때

- “왜 멈췄나”, “왜 loop 도나”, “왜 너무 깊게 들어갔나” 같은 요청
- 특정 issue tree가 멈췄거나 계속 recovery되는 상황
- code change 전에 root cause write-up이 필요한 상황

## 사용하지 않을 때

- 직접 code change를 ship하라는 요청
- 일반 feature bug report
- 본인이 방금 만든 bug를 바로 고치는 상황

## 지켜야 할 세 가지 불변식

1. **productive work는 계속되어야 합니다.** 명확한 next action이 있는 agent는 user가 다시 깨우지 않아도 계속 진행해야 합니다.
2. **진짜 blocker만 작업을 멈춥니다.** missing approval, dependency, human owner 같은 실제 blocker가 아닌 pseudo-stop은 감지하고 route해야 합니다.
3. **infinite loop는 없어야 합니다.** recovery와 continuation은 bounded되어야 하고, 실제 생산적인 continuation과 구분되어야 합니다.

## 절차

1. `doc/execution-semantics.md`를 읽고 현재 execution contract를 기준으로 삼습니다.
2. linked issue와 blocker chain, parent, recovery sibling, recent run을 확인합니다.
3. tree 안에서 실제로 멈춘 issue + state 조합을 찾습니다.
4. 최근 liveness/recovery 관련 변경과 done issue를 훑어 기존 rule과 충돌하지 않는지 확인합니다.
5. 진행되지 않는 issue를 human intervention, agent-actionable but unrouted, already covered로 분류합니다.
6. 발견한 gap을 general product rule로 정리합니다.
7. code change 없이 plan으로 마무리하고 approval gate를 둡니다.
