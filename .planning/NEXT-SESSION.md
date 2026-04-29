# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

## 현재 상태

- v2.6 `운영 커넥터 및 자율성 하드닝` milestone이 archive/tag 준비까지 완료되었다.
- `.planning/REQUIREMENTS.md`는 archive 후 삭제되었으므로 다음 milestone에서 fresh requirements를 만들어야 한다.
- 최근 커밋:
  - `e982f9e2` — `chore: archive v2.6 milestone files`
  - `91259e98` — `chore: remove REQUIREMENTS.md for v2.6 milestone`

## v2.6 완료 요약

- Phase 39-43 완료.
- Requirements 12/12, phases 5/5, integration 5/5, flows 5/5.
- Audit은 `tech_debt`로 archive되었다.
- Archive files:
  - `.planning/milestones/v2.6-ROADMAP.md`
  - `.planning/milestones/v2.6-REQUIREMENTS.md`
  - `.planning/milestones/v2.6-MILESTONE-AUDIT.md`
- Living docs updated:
  - `.planning/ROADMAP.md`
  - `.planning/MILESTONES.md`
  - `.planning/PROJECT.md`
  - `.planning/STATE.md`
  - `.planning/RETROSPECTIVE.md`

## 검증 상태

통과:

```sh
pnpm run rt2:milestone-gate
```

주의:

- v2.6 audit은 Phase 40-43 full `pnpm test` timeout과 Windows embedded Postgres skip을 accepted tech debt로 기록했다.
- Pre-close artifact audit은 legacy UAT 관련 3개 unknown item을 보고했다. Phase 43 closure evidence와 0 pending scenarios를 근거로 acknowledged/deferred 처리했다.

## 다음 업무 지시어

다음 세션의 기본 목표는 새 milestone 정의다.

권장 시작 명령:

```sh
$gsd-new-milestone
```

시작 전 확인할 파일:

- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/PROJECT.md`
- `.planning/MILESTONES.md`
- `.planning/milestones/v2.6-MILESTONE-AUDIT.md`

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
*상태 업데이트: 2026-04-29, v2.6 milestone complete; next new milestone planning*
