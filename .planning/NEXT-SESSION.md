# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

## 시작 지시

1. 세션 시작 즉시 `AGENTS.md`의 `Golden Rule 1 — Korean-First Communication`을 확인한다.
2. 사용자에게 설명하거나 질문할 때 영어로 답하지 않는다.
3. 진행 중 남길 인계, 체크포인트, 다음 단계도 한국어로 작성한다.
4. `git status --short`로 작업트리를 확인하되, 기존 untracked debug/temp 파일은 사용자 산출물일 수 있으므로 임의 삭제하지 않는다.

## 현재 상태

- v2.6 `운영 커넥터 및 자율성 하드닝` milestone 진행 중이다.
- Phase 39 `Enterprise Connector Apply Loop` 완료.
- Phase 40 `Trusted Local Knowledge Bridge` 완료.
- Phase 41 `Native and Mobile Capture Hardening` 완료.
- Phase 42 `Jarvis Autonomy Eval Guardrails` 완료.
- Phase 42 관련 커밋:
  - `c8981abe` — `docs(42): capture phase context`
  - `d48b6eb5` — `feat(42): add Jarvis autonomy guardrails`
  - `ff78bdd4` — `docs(42): record execution verification`

## Phase 42 완료 요약

- Jarvis knowledge rewrite는 direct apply 없이 proposal-only 흐름으로 제한했다.
- Provider-backed eval과 deterministic fallback eval이 같은 `Rt2JarvisRewriteEvalRubric` schema를 사용한다.
- Provider unavailable, provider/fallback disagreement, low confidence, fallback blocked 상태를 proposal/eval/operations health/UI에 노출한다.
- Approval request, approval/rejection, activity log, contradiction linkage를 저장한다.
- Knowledge Operations health에 Jarvis rewrite proposal risk summary와 reason code를 추가했다.
- `Rt2QualityPanel`에 rewrite proposal evidence 및 승인 요청 버튼을 추가했다.

## 검증 상태

통과:

```sh
pnpm typecheck
pnpm exec vitest run server/src/__tests__/rt2-v23-route-fallback.test.ts server/src/__tests__/rt2-phase6-intelligence.test.ts server/src/__tests__/rt2-knowledge-operations.test.ts
```

주의:

- `server/src/__tests__/rt2-phase6-intelligence.test.ts`와 `server/src/__tests__/rt2-knowledge-operations.test.ts`의 embedded Postgres suites는 Windows 기본 설정에서 skip된다.
- `pnpm test`는 5분 제한과 10분 제한에서 모두 timeout되어 전체 suite 완료를 확인하지 못했다.

## 다음 업무 지시어

다음 세션의 기본 목표는 Phase 43 `Validation Debt and Milestone Gate Closure`를 시작하는 것이다.

권장 시작 명령:

```sh
$gsd-discuss-phase 43 --auto --chain
```

Phase 43 목표:

- historical validation debt를 정리한다.
- 다음 milestone부터 verification/validation/summary/frontmatter 같은 artifact 누락이 늦게 발견되지 않도록 gate를 강화한다.
- 요구사항: `VAL-01`, `VAL-02`, `VAL-03`.

Phase 43 시작 전 확인할 파일:

- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/phases/42-jarvis-autonomy-eval-guardrails/42-CONTEXT.md`
- `.planning/phases/42-jarvis-autonomy-eval-guardrails/42-VERIFICATION.md`

## 남겨진 로컬 주의사항

다음 untracked 파일/디렉터리는 이번 세션 이전부터 존재하던 debug/temp 산출물이다. 임의로 삭제하지 말고, 정리가 필요하면 사용자 확인 후 별도 처리한다.

- `.tmp-operations-rollout-dev.*.log`
- `_refs/`
- 루트의 `debug-*.cjs`, `find-*.cjs`, `test-*.cjs`, `raw-stmt3.cjs`
- `packages/db` 아래의 일회성 migration/debug 분석 스크립트들

## 주의할 점

- 현재 런타임의 `gsd-sdk`는 workflow 문서에 있는 `gsd-sdk query ...` 서브커맨드를 지원하지 않는다. 필요하면 `C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs`를 사용하되, `STATE.md` 직접 mutation은 조심한다.
- 이전 세션에서 legacy state tool이 `.planning/STATE.md` frontmatter를 잘못 바꿨고, 그 변경은 되돌렸다. 다음 세션에서도 state update는 검증 가능한 도구 경로가 있을 때만 수행한다.
- `pnpm-lock.yaml` 변경은 PR에 포함하지 않는다.

---
*상태 업데이트: 2026-04-29, Phase 42 complete; next Phase 43*
