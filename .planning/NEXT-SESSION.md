# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

## 현재 상태

- v2.6 `운영 커넥터 및 자율성 하드닝` milestone의 Phase 39-43이 완료되었다.
- Phase 43 `Validation Debt and Milestone Gate Closure` 완료.
- 최근 커밋:
  - `e8a0b0dc` — `docs(43): capture phase context`
  - `6e5f0167` — `docs(43): create phase plan`
  - `326277f2` — `feat(43): close validation debt and add milestone gate`

## Phase 43 완료 요약

- Phase 19-24 strict `*-VALIDATION.md` historical debt를 closure했다.
- Phase 40-42 `*-VALIDATION.md`도 추가해 현재 v2.6 artifact gate가 검증 가능한 상태가 되었다.
- Legacy UAT unknown을 `43-LEGACY-UAT-CLOSURE.md`에서 재분류했다.
  - `01-UAT.md`: reverified/closed.
  - `m1-6-UAT.md`: superseded/obsolete/reverified via replacement evidence.
- Deterministic milestone artifact gate를 추가했다.
  - `scripts/rt2-milestone-artifact-gate.mjs`
  - `scripts/rt2-milestone-artifact-gate.test.mjs`
  - `pnpm run rt2:milestone-gate`
  - `pnpm run test:milestone-gate`
- `.planning/REQUIREMENTS.md`는 v2.6 12/12 complete로 동기화되었다.

## 검증 상태

통과:

```sh
pnpm run test:milestone-gate
pnpm run rt2:milestone-gate
pnpm typecheck
node C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs verify references .planning\phases\43-validation-debt-and-milestone-gate-closure\43-CONTEXT.md --raw
node C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs verify plan-structure .planning\phases\43-validation-debt-and-milestone-gate-closure\43-01-PLAN.md
```

주의:

- `pnpm test`는 10분 제한에서 timeout되었다. 실패 summary는 캡처되지 않았다.
- Phase 40-42에서도 full suite timeout이 반복되었으므로, milestone close 전 가능하면 더 긴 timeout 또는 CI 환경에서 `pnpm test` completion을 확인한다.

## 다음 업무 지시어

다음 세션의 기본 목표는 v2.6 milestone close/audit이다.

권장 시작 명령:

```sh
$gsd-complete-milestone v2.6
```

시작 전 확인할 파일:

- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-VERIFICATION.md`
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-MILESTONE-GATE.md`
- `scripts/rt2-milestone-artifact-gate.mjs`

## 남겨진 로컬 주의사항

다음 untracked 파일/디렉터리는 이번 세션 이전부터 존재하던 debug/temp 산출물이다. 임의로 삭제하지 말고, 정리가 필요하면 사용자 확인 후 별도 처리한다.

- `.tmp-operations-rollout-dev.*.log`
- `_refs/`
- 루트의 `debug-*.cjs`, `find-*.cjs`, `test-*.cjs`, `raw-stmt3.cjs`
- `packages/db` 아래의 일회성 migration/debug 분석 스크립트들

## 주의할 점

- 현재 런타임의 `gsd-sdk`는 workflow 문서에 있는 `gsd-sdk query ...` 서브커맨드를 지원하지 않는다. 필요하면 `C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs`를 사용하되, `STATE.md` 직접 mutation은 조심한다.
- `pnpm-lock.yaml` 변경은 PR에 포함하지 않는다.

---
*상태 업데이트: 2026-04-29, Phase 43 complete; next v2.6 milestone close*
