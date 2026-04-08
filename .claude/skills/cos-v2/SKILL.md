---
name: cos-v2
description: COS v2 빌더 — 계획 기반 연속 실행. 현재 상태 파악 → 다음 유닛 진행 → 리뷰/QA → 반복. Paperclip fork 위에 Linear+Slack 스타일 팀/이슈/룸/문서 기능을 점진적으로 추가한다.
---

# COS v2 Builder

Paperclip fork 기반 COS v2를 Phase 계획에 따라 연속 구현하는 빌더.
`/cos-v2` 실행할 때마다 현재 진행 상태를 파악하고, 다음 작업을 진행한다.

## 매 실행 시 가장 먼저 할 일 (순서 고정)

1. `docs/cos-v2/CONTEXT.md` 읽기 — 모든 결정사항, 금지사항, Codex 이슈 백로그
2. `docs/cos-v2/progress.md` 읽기 — 어디까지 됐는지, 다음 유닛이 뭔지
3. `docs/cos-v2/phase1-breakdown.md` / design-spec.md — 계획 참조
4. 서버 상태 확인 (`curl -s http://127.0.0.1:3101/api/health`)
5. 위 3개를 다 읽은 **후에만** 실제 작업 시작

중간 세션에서 context 날아가도 이 4단계만 지키면 복구 가능.

## 핵심 원칙 (절대 위반 금지)

1. **기존 Paperclip 코드/UI에 추가하는 방식** — 재구현 아님, 확장만
2. **새 route 추가 시 `ui/src/lib/company-routes.ts`의 `BOARD_ROUTE_ROOTS`에 등록 필수** — 안 하면 `UnprefixedBoardRedirect` 2-hop 발생해서 전체 화면 flicker
3. **페이지 컴포넌트에 `max-w-*`, `mx-auto`, `p-8` 같은 자체 wrapper 금지** — Layout `<main className="flex-1 p-4 md:p-6">` 이미 padding 제공
4. **쿼리키 기반 useQuery는 `keepPreviousData` + sidebar cache initialData 조합** — flicker 없는 route param 전환
5. **issues.status는 text 유지** — FK 전환 안 함, 서비스에서 team workflow_statuses.slug 검증만
6. **식별자 regex는 `/^[A-Z][A-Z0-9]*-\d+$/i`** — ENG2, PLT3 같은 숫자 포함 팀 prefix 지원
7. **Cross-tenant 검증은 서비스 transaction 안에서 하드하게** — `assertAgentInCompany`, `assertUserInCompany`, `assertEntityInCompany`, `assertRoomParticipant` 헬퍼 재사용
8. **Action/transition 종단 상태는 단방향** — `pending → executed|failed`만 허용, 터미널 회귀 금지

## 핵심 작업 패턴

새 기능 추가 시 항상:

1. **스키마** — `packages/db/src/schema/*.ts` + `packages/db/src/schema/index.ts`에 export
2. **마이그레이션** — `packages/db/src/migrations/00NN_cos_*.sql` + `meta/_journal.json` entry
3. **Validator** — `packages/shared/src/validators/*.ts` + `validators/index.ts` + `src/index.ts` 삼중 export
4. **Service** — `server/src/services/*.ts` (반드시 `db.transaction` + cross-tenant 검증) + `services/index.ts` export
5. **Route** — `server/src/routes/*.ts` + `server/src/app.ts`에 mount (import **둘 다** 필요 — 빠뜨리면 runtime error)
6. **UI API 클라이언트** — `ui/src/api/*.ts`
7. **UI 페이지/컴포넌트** — `@/lib/router`의 NavLink/Link/Navigate만 사용 (raw react-router-dom 금지)
8. **App.tsx 라우트** — `boardRoutes()` 안에 실제 element, Layout 바깥에는 `UnprefixedBoardRedirect` 등록
9. **BOARD_ROUTE_ROOTS 등록** — 새 top-level path segment라면 반드시
10. **빌드** — `pnpm --filter @paperclipai/shared build && pnpm --filter @paperclipai/db build && pnpm --filter @paperclipai/ui build`
11. **서버 재시작** — `pkill -9 -f "tsx.*src/index.ts"; pnpm dev:once`
12. **API QA** — curl로 CRUD 확인
13. **브라우저 E2E** — `browse` skill의 `$B goto/click/type/press Enter`로 실제 클릭 플로우 검증
14. **DB spot check** — 저장된 row 확인 (API 200 ≠ UI 동작)
15. **코드 리뷰 + Codex challenge** — `feature-dev:code-reviewer` + `/codex` 병렬 실행
16. **P0/P1 fix + 재검증** — 재검증 후 커밋
17. **progress.md 업데이트** — 완료된 unit 기록

## 리뷰 프로세스 (유닛 완료 시)

1. **`feature-dev:code-reviewer` 에이전트** — HIGH confidence 이슈만 보고
2. **`/codex` skill (challenge mode, `gpt-5-codex`)** — 적대적 관점, 공격 시나리오
3. **두 결과 비교** — 둘 다 언급한 이슈는 P0, 한쪽만 언급하면 confidence 확인
4. **fix + 재검증** — 모든 P0/P1 해결
5. **commit 본문에 찾은 이슈 + fix 상세 기록**

## 브라우저 검증 절대 원칙

"CRUD 테스트 완료"는 다음 모두가 참일 때만 말한다:

- ✅ API curl 200
- ✅ 헤드 브라우저에서 실제 click → type → Enter로 form submit
- ✅ 네트워크 탭에서 1-hop navigation 확인 (replace 이벤트 0건)
- ✅ 콘솔 에러 0 (vite HMR 제외)
- ✅ DB select로 실제 row 확인 (식별자 + content)
- ✅ 다른 탭/세션에서도 보이는지 확인 (polling or refetch)

API 200만으로 "verified" 라고 말하지 않는다. 거짓말이 된다.

## 참조 문서

- 전체 컨텍스트: `docs/cos-v2/CONTEXT.md` (결정사항 + Codex 이슈 백로그)
- 설계 스펙: `docs/cos-v2/design-spec.md` (Phase 별 기능 정의)
- Paperclip 분석: `docs/cos-v2/paperclip-analysis.md`
- Phase 1 분해: `docs/cos-v2/phase1-breakdown.md`
- 진행 상태: `docs/cos-v2/progress.md` ← **모든 세션 시작 시 먼저 읽기**
- Memory (사용자 feedback): `~/.claude/projects/-Users-bright-Projects-company-os-v2/memory/MEMORY.md`

## 환경 정보

- Repo: `/Users/bright/Projects/company-os-v2` (Paperclip fork, master branch)
- DB: Embedded Postgres (`~/.paperclip/instances/default/db` 또는 worktree별)
- 서버: `pnpm dev:once`, port **3101** (worktree config), UI+API 같은 포트
- 회사 prefix: `BBR` (BBrightcode Corp)
- 회사 ID: `d97193bc-976f-401d-bdb6-9741319359d9` (세션마다 재확인)
