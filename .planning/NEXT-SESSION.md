# 다음 세션 지시어

## 제1 황금룰

질문, 답변, 설명, 진행상황 보고, 최종 보고는 반드시 한국어로 한다.
코드, 명령어, 파일 경로, 식별자, 로그 원문, 외부 고유명사는 필요한 경우 원문 그대로 둔다.

## 현재 상태

- v3.1 `DevPlan Core Convergence` milestone이 진행 중이다.
- Phase 65-69는 완료됐다.
- Phase 69 `Graphify v3 Corpus Graph Sidecar`는 RT2 product graph와 분리된 corpus graph sidecar를 구현하고 검증했다.
- 다음 업무는 Phase 70 `Economy, Marketplace, P&L, and CareerMate Loop` 논의/계획/실행이다.

## Phase 69 핵심 변경

- `rt2_v33_corpus_graph_*` source/node/edge/community/report 테이블과 migration `0106_rt2_corpus_graph_sidecar.sql`을 추가했다.
- repo/docs/wiki source ingest는 SHA256 cache, source location metadata, source별 증분 skip을 제공한다.
- deterministic code/docs extractor가 heading/symbol/import/high-signal term을 graph node/edge로 만들고 confidence score, evidence, provenance를 저장한다.
- query API는 stats, node, neighbors, community, shortest path, god nodes, report를 제공한다.
- report는 product graph와 corpus graph count를 분리하고 knowledge gap, surprising connection, suggested question을 노출한다.
- DevPlan alignment gate에서 `graphify-v3-sidecar`가 `complete`로 전환됐고 current score는 91%다.

## 검증

통과:

```sh
pnpm typecheck
pnpm test
$env:PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS='true'; pnpm exec vitest run packages/shared/src/rt2-graph.test.ts server/src/__tests__/rt2-corpus-graph.test.ts --reporter=default
pnpm test:devplan-alignment-gate
pnpm rt2:devplan-alignment-gate -- --json
```

주의:

- 기본 `pnpm test`에서는 Windows 기본 정책 때문에 embedded Postgres 테스트 일부가 skip된다.
- Phase 69 focused test는 `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`로 실제 embedded Postgres/migration/route까지 통과했다.
- 기존 untracked debug/temp 산출물은 임의 삭제하지 않는다.
- `pnpm-lock.yaml` 변경은 PR에 포함하지 않는다.

## 다음 업무 지시어

권장 시작 명령:

```sh
$gsd-discuss-phase 70 --auto --chain
```

시작 전 반드시 읽을 파일:

- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/PROJECT.md`
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-SUMMARY.md`
- `.planning/phases/69-graphify-v3-corpus-graph-sidecar/69-VERIFICATION.md`
- `.planning/research/ENGINE-REFERENCE-AUDIT.md`
