# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

## 시작 지시

1. 세션 시작 즉시 `AGENTS.md`의 `Golden Rule 1 — Korean-First Communication`을 확인한다.
2. 사용자에게 설명하거나 질문할 때 영어로 답하지 않는다.
3. 진행 중 남길 인계, 체크포인트, 다음 단계도 한국어로 작성한다.
4. 직전 작업 맥락은 v2.6 `운영 커넥터 및 자율성 하드닝` milestone planning 완료 상태다.

## 현재 상태

- v2.5 Semantic Knowledge Intelligence는 Phase 33-38까지 완료 및 archive되었다.
- v2.6 운영 커넥터 및 자율성 하드닝 milestone이 시작되었고 requirements/roadmap이 작성되었다.
- Archive:
  - `.planning/milestones/v2.5-ROADMAP.md`
  - `.planning/milestones/v2.5-REQUIREMENTS.md`
  - `.planning/milestones/v2.5-MILESTONE-AUDIT.md`
  - `.planning/milestones/v2.5-MILESTONE-REAUDIT.md`
- `.planning/PROJECT.md`, `.planning/STATE.md`, `.planning/MILESTONES.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`는 v2.6 planned 상태로 갱신되었다.
- v2.6은 Phase 39-43, 요구사항 12개로 구성되어 있다.

## 다음 업무 지시어

다음 세션의 기본 목표는 v2.6 첫 phase를 시작하는 것이다.

권장 시작 명령:

```sh
$gsd-discuss-phase 39
```

v2.6 phase 구조:

1. Phase 39: Enterprise Connector Apply Loop - EXT-01, EXT-02
2. Phase 40: Trusted Local Knowledge Bridge - EXT-03
3. Phase 41: Native and Mobile Capture Hardening - CAP-01, CAP-02, CAP-03
4. Phase 42: Jarvis Autonomy Eval Guardrails - AUTO-01, AUTO-02, AUTO-03
5. Phase 43: Validation Debt and Milestone Gate Closure - VAL-01, VAL-02, VAL-03

## 남겨진 로컬 주의사항

PR에 포함하지 않은 임시 파일들이 untracked로 남아 있다. 필요 없으면 별도 확인 후 정리한다. 무조건 삭제하지 말고, 사용자가 임시 디버그 산출물을 보존하려는지 먼저 판단한다.

- `.tmp-operations-rollout-dev.*.log`
- `_refs/`
- 루트의 `debug-*.cjs`, `find-*.cjs`, `test-*.cjs`
- `packages/db` 아래의 일회성 migration/debug 분석 스크립트들

---
*상태 업데이트: 2026-04-29, v2.6 milestone planning complete*
