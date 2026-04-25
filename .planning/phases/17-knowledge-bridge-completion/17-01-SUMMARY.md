# Phase 17 Summary: Knowledge Bridge Completion

## Status

Complete.

## What Changed

- `Knowledge` page에 `Bridge` tab을 추가했다.
- 운영자는 같은 화면에서 knowledge projection 실행, Obsidian-compatible vault export 확인, vault import preview 실행, graph report confidence, evidence status를 확인할 수 있다.
- `POST /api/companies/:companyId/rt2/knowledge/vault-import-preview` route를 추가했다.
- Shared contract에 vault import preview input/result와 `ready | missing | stale | ambiguous` evidence status를 추가했다.

## Requirement

- `KNOW-01`: 완료.

## Verification

- `pnpm exec vitest run packages/shared/src/rt2-knowledge.test.ts` - pass, 4 tests.
- `pnpm exec vitest run server/src/__tests__/rt2-knowledge-routes.test.ts` - collected, skipped by embedded Postgres host init issue.
- `pnpm --filter @paperclipai/ui typecheck` - pass.
- `pnpm --filter @paperclipai/shared typecheck` - pass.
- `pnpm --filter @paperclipai/server typecheck` - pass.

## Remaining Risk

- Import는 preview다. 실제 Obsidian local writer와 bidirectional sync는 storage/approval policy가 필요한 후속 범위다.
- Graph report는 기존 project-scoped report를 사용한다.
