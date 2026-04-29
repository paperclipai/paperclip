# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.

## 현재 상태

- v2.7 `릴리즈 호스트 검증 및 런타임 신뢰도` milestone은 완료됐다.
- Phase 44, 45, 46, 47은 모두 완료됐고 archive가 생성됐다.
- 다음 업무는 새 milestone 요구사항 정의다.

## 핵심 변경

- v2.7 milestone close를 완료했다.
- `.planning/REQUIREMENTS.md`는 archive 후 제거됐다. 다음 milestone에서 새로 생성해야 한다.
- Phase 47 `Runtime Confidence Operations Surface`를 완료했다.
- 운영자가 release confidence, accepted debt, blocker/deferred scope, latest verification evidence를 한 곳에서 볼 수 있도록 generated report command를 추가했다.
- 새 command:
  - `pnpm rt2:runtime-confidence`
  - `pnpm test:runtime-confidence`
- Phase 47 산출물과 v2.7 상태 문서를 완료 상태로 갱신했다.
- 자세한 구현 내역은 다음 파일에서 확인한다.
  - `scripts/rt2-runtime-confidence.mjs`
  - `scripts/rt2-runtime-confidence.test.mjs`
  - `doc/RELEASE-HOST-VERIFICATION.md`
  - `.planning/phases/47-runtime-confidence-operations-surface/47-VERIFICATION.md`
  - `.planning/milestones/v2.7-REQUIREMENTS.md`
  - `.planning/milestones/v2.7-ROADMAP.md`
  - `.planning/milestones/v2.7-MILESTONE-AUDIT.md`

## 검증

통과:

```sh
pnpm test:runtime-confidence
node scripts/rt2-release-host-verify.mjs --only __no_such_slice__ --json
pnpm rt2:runtime-confidence -- --json
pnpm rt2:milestone-gate -- --json
pnpm typecheck
```

결과:

- `pnpm test:runtime-confidence` 통과.
- `node scripts/rt2-release-host-verify.mjs --only __no_such_slice__ --json` 통과. Windows embedded Postgres default skip을 `accepted_debt` release-host evidence로 생성했다.
- `pnpm rt2:runtime-confidence -- --json` 통과. 최신 generated report는 `.planning/runtime-confidence/2026-04-29T23-37-34-146Z/`에 있다.
- `pnpm rt2:milestone-gate -- --json` 통과, `issueCount: 0`.
- `pnpm typecheck` 통과.

주의:

- `pnpm test`는 Phase 47에서 184초 후 timeout됐고, milestone close verification에서도 304초 제한에서 timeout됐다.
- Focused Phase 47 checks, milestone gate, typecheck, runtime confidence report는 통과했다.
- 최신 sample runtime confidence report의 overall status는 `accepted_debt`다. 이유는 Windows embedded Postgres default skip이며 closure command는 `pnpm run rt2:embedded-postgres-host-ready`다.
- v2.7 audit은 requirements 11/11, phases 4/4, integration 4/4, flows 4/4이고 blocker 없이 `tech_debt`다.

## 남겨진 로컬 주의사항

- 기존 debug/temp 산출물은 임의 삭제하지 않는다.
  - `.tmp-operations-rollout-dev.*.log`
  - `_refs/`
  - 루트의 `debug-*.cjs`, `find-*.cjs`, `test-*.cjs`, `raw-stmt3.cjs`
  - `packages/db` 아래 일회성 migration/debug 분석 스크립트들
- Phase 44-47 `.planning/phases/*` 산출물은 v2.7 milestone evidence로 유지한다.
- 현재 런타임의 `gsd-sdk`는 workflow 문서의 `gsd-sdk query ...` 서브커맨드를 지원하지 않는다. 필요하면 `C:\Users\고상진\.codex\get-shit-done\bin\gsd-tools.cjs`를 사용한다.
- `pnpm-lock.yaml` 변경은 PR에 포함하지 않는다.

## 다음 업무 지시어

다음 세션은 새 milestone을 시작한다.

권장 시작 명령:

```sh
$gsd-new-milestone
```

중요:

- 이 지시어는 “다음 한 단계”만 지정한다.
- 새 milestone 시작 전 `.planning/milestones/v2.7-*` archive와 `STATE.md` deferred items를 확인한다.
- 새 `.planning/REQUIREMENTS.md`를 만들 때 v2.7 accepted debt를 먼저 닫을지, product expansion으로 넘어갈지 결정한다.
- 즉, 현재 작업이 완료될 때마다 `NEXT-SESSION.md`는 최신 결과 기준으로 다시 갱신한다.

시작 전 반드시 읽을 파일:

- `.planning/PROJECT.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/MILESTONES.md`
- `.planning/milestones/v2.7-REQUIREMENTS.md`
- `.planning/milestones/v2.7-ROADMAP.md`
- `.planning/milestones/v2.7-MILESTONE-AUDIT.md`
- `.planning/phases/47-runtime-confidence-operations-surface/47-VERIFICATION.md`
- `scripts/rt2-runtime-confidence.mjs`
- `doc/RELEASE-HOST-VERIFICATION.md`
