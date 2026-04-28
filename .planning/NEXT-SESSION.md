# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.
다음 세션에 이어서 해야 할 일이 있으면 반드시 한국어 지시어로 인계 문서를 남긴다.

## 시작 지시

1. 세션 시작 즉시 `AGENTS.md`의 `Golden Rule 1 — Korean-First Communication`을 확인한다.
2. 사용자에게 설명하거나 질문할 때 영어로 답하지 않는다.
3. 진행 중 남길 인계, 체크포인트, 다음 단계도 한국어로 작성한다.
4. 직전 작업 맥락은 v2.5 Phase 37 `Knowledge Intelligence Operations` ship 완료 상태다.

## 현재 상태

- PR: https://github.com/paperclipai/paperclip/pull/4650
- Branch: `maritza7110:m1-7-basic-ai-jarvis` -> `paperclipai:master`
- 최신 로컬 커밋:
  - `d4bc9114 feat(rt2): ship semantic knowledge intelligence`
  - `160ed2d9 docs(37): record phase ship status`
  - `5f4db7db docs: update next session ship handoff`
- 검증:
  - `pnpm typecheck` 통과
  - `pnpm test` 통과: 266 files passed, 24 skipped / 1461 tests passed, 126 skipped
  - Snyk PR check 성공
- 주의:
  - `upstream` 직접 push는 GitHub 권한 403으로 실패했다.
  - fork `maritza7110/paperclip`를 `origin`으로 추가했고, 해당 fork branch에서 PR을 열었다.
  - PR은 `mergeStateStatus: DIRTY` 상태다.
  - `git merge upstream/master` 시 실제 conflict가 다수 발생해 `git merge --abort`로 되돌렸다.

## 다음 업무 지시어

다음 세션의 기본 목표는 PR #4650의 base conflict를 해결하고, 검증을 다시 돌린 뒤 PR branch를 업데이트하는 것이다.

권장 시작 명령:

```sh
$gsd-quick "PR #4650 ship 후속 처리: upstream/master merge conflict를 해결하고 pnpm typecheck && pnpm test 통과 후 origin/m1-7-basic-ai-jarvis에 push한다"
```

주의: `$gsd-ship 37 --auto`는 이미 실행 완료했고 PR #4650이 생성되어 있다. 다음 세션에서 ship workflow를 반복하지 말고, GSD quick task로 ship 후속 conflict 해결만 진행한다:

1. `git status --short --branch`로 작업트리가 merge 중이 아닌지 확인한다.
2. `git fetch upstream master`로 최신 base를 가져온다.
3. `git merge upstream/master` 또는 더 깔끔하면 별도 conflict-resolution branch에서 merge한다.
4. conflict 파일을 하나씩 해결한다. 마지막 확인된 주요 conflict는 다음 범위였다:
   - `AGENTS.md`
   - `cli/src/__tests__/company-import-export-e2e.test.ts`
   - `cli/src/__tests__/worktree.test.ts`
   - `packages/adapter-utils/src/server-utils.test.ts`
   - `packages/db/src/migrations/meta/*`
   - `packages/db/src/schema/index.ts`
   - `packages/shared/src/index.ts`
   - `scripts/provision-worktree.sh`
   - `server/src/app.ts`
   - `server/vitest.config.ts`
   - `ui/src/App.tsx`
   - 여러 `ui/src/components/*`, `ui/src/pages/*`
5. conflict 해결 후 반드시 실행한다:

```sh
pnpm typecheck
pnpm test
```

6. 통과하면 commit 후 `git push`로 PR #4650을 업데이트한다.
7. PR 상태를 확인한다:

```sh
gh pr view 4650 --repo paperclipai/paperclip --json mergeStateStatus,statusCheckRollup,url
```

## 남겨진 로컬 주의사항

PR에 포함하지 않은 임시 파일들이 untracked로 남아 있다. 필요 없으면 별도 확인 후 정리한다. 무조건 삭제하지 말고, 사용자가 임시 디버그 산출물을 보존하려는지 먼저 판단한다.

- `.tmp-operations-rollout-dev.*.log`
- `_refs/`
- 루트의 `debug-*.cjs`, `find-*.cjs`, `test-*.cjs`
- `packages/db` 아래의 일회성 migration/debug 분석 스크립트들

---
*상태 업데이트: 2026-04-28, Phase 37 shipped, PR #4650 conflict resolution pending*
