# GSD 형식 과잉 금지

Mechanical cleanup 작업은 GSD 풀 사이클로 키우지 않는다.

## 규칙

- 타입 오류, lint 오류, schema export 누락, migration numbering, 단순 테스트 fixture 보정은 inline으로 직접 수정한다.
- 이런 작업에 `$gsd-plan-phase`, `$gsd-discuss-phase`, 별도 REVIEW/PLAN 문서, 다중 wave를 기본 적용하지 않는다.
- 필요한 확인만 짧게 수행하고 결과를 보고한다.
- 사용자가 명시적으로 GSD phase 실행을 요청한 경우에만 GSD 문서/상태 갱신을 포함한다.

## 보고 방식

- 무엇을 고쳤는지, 어떤 검증을 했는지, 남은 리스크가 있는지만 간결히 쓴다.
- 다음 행동이 필요하면 구체적인 `/gsd-*` 명령어를 마지막에 제시한다.
