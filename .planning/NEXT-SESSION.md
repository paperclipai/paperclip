# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.

## 시작 지시

1. 세션 시작 즉시 `AGENTS.md`의 `Golden Rule 1 — Korean-First Communication`을 확인한다.
2. 사용자에게 설명하거나 질문할 때 영어로 답하지 않는다.
3. 진행 중 남길 인계, 체크포인트, 다음 단계도 한국어로 작성한다.
4. 직전 작업 맥락은 v2.5 Phase 33 `Semantic Index Foundation` 자동 체인 완료 상태다. 먼저 `.planning/phases/33-semantic-index-foundation/33-CONTEXT.md`, `33-01-PLAN.md`, `33-01-SUMMARY.md`, `33-VERIFICATION.md`를 확인한다.

## 다음 업무 지시어

Phase 33은 구현과 기본 검증까지 완료했다. 다음 세션은 Phase 34 `Semantic Knowledge Search`로 넘어간다.

권장 시작 명령:

```sh
$gsd-discuss-phase 34 --auto --chain
```

Phase 34를 시작하기 전에 반드시 확인할 것:

1. Phase 33 변경 파일을 기준으로 semantic index API와 service 계약을 이해한다.
   - `packages/db/src/schema/rt2_v33_semantic_index.ts`
   - `server/src/services/rt2-semantic-index.ts`
   - `server/src/routes/rt2-semantic-index.ts`
   - `server/src/__tests__/rt2-semantic-index.test.ts`
2. Phase 34는 semantic search surface를 만드는 단계다. Phase 33에서 만든 index layer를 소비하되, source storage를 교체하거나 cross-company federation을 추가하지 않는다.
3. 요구사항은 `.planning/REQUIREMENTS.md`의 `SEARCH-01`부터 `SEARCH-04`까지다.
4. Phase 33 검증 결과:
   - `pnpm test -- rt2-semantic-index` 통과
   - `pnpm typecheck` 통과
   - `pnpm test` 통과
   - Windows 기본 설정 때문에 embedded Postgres semantic-index tests 2개는 skipped다. 필요하면 `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`로 별도 실행한다.
5. 현재 런타임의 `gsd-sdk`는 `query` 서브커맨드를 제공하지 않았다. GSD workflow의 state/roadmap 자동 mutation이 실패할 수 있으므로, 필요한 산출물은 로컬 `.planning/phases/...` 파일을 직접 확인하고 한국어로 인계한다.
