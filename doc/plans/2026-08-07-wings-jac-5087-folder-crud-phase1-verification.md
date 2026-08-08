# JAC-5087 — Folder CRUD Service + REST API Phase 1 (verification close)

**Date:** 2026-08-07T18:02Z
**Actor:** Wings (80284e06) via run bf4e95e7-72e6-4105-8eae-83a2000f98f1
**Dispatch:** JAC-5087 (child of JAC-5083) → source JAC-4909 / plan JAC-4748 / epic JAC-4746
**Host:** Aegis · Paperclip API v2026.722.0 · deploymentMode=local_trusted

## Disposition

**Already implemented.** Phase 1 (JAC-4748) is `done` on the board and the code is present on `master` and the current checkout. This wake was a velocity re-dispatch after Hermes Mistral pause rejection; no new implementation was required.

## Acceptance (JAC-4748 Phase 1)

| Criterion | Evidence |
|---|---|
| Folder CRUD service (create/read/update/delete/move/tree/cycle detection) | `server/src/services/agent-folders.ts` on master @ c433ae7d9 (ancestor of HEAD 0b4422826) |
| REST API | `server/src/routes/agent-folders.ts` mounted via `server/src/app.ts` + `routes/index.ts` |
| Shared types + validators | `packages/shared/src/types/agent-folders.ts`, `packages/shared/src/validators/agent-folders.ts` |
| Schema | `packages/db/src/schema/agent_folders.ts` + `agents.folderId` FK |
| Unit tests | `pnpm exec vitest run server/src/__tests__/agent-folders.test.ts` → **3/3 pass** |
| Route integration tests | `pnpm exec vitest run server/src/__tests__/agent-folders-routes-integration.test.ts` → **36/36 pass** |
| Live API | `GET /api/companies/87c32b8e…/agent-folders` → **HTTP 200**, 2 folders (`Engineering`, `Backend`) |

## Live probe (2026-08-07)

```
GET /api/health → ok (v2026.722.0)
GET /api/companies/87c32b8e-f131-4df8-ad8e-963d01b458e7/agent-folders → 200
  totalCount=2
  folders: Engineering (slug=engineering), Backend (slug=backend, agentCount=1)
```

## Prior done dispatches (idempotent history)

- JAC-4748 done (source phase)
- JAC-4746 done (epic)
- JAC-4815 / JAC-4829 / JAC-4851 / JAC-4864 / JAC-4884 / JAC-4904 done (prior Phase 1 dispatches)

## Constraints honored

- No credential writes
- No external messages
- No lane transport mutations
- Self-origin: Wings JWT (derived company key) used only for JAC-5087 mutation

## Caveats

1. Live Paperclip server package is npm `paperclipai` v2026.722.0; local repo checkout is ahead on branch `fix/jac-5046-detach-recovery` but agent-folders Phase 1 is already merged to master and served live (API 200).
2. Source JAC-4909 remains a stale backlog re-dispatch of completed JAC-4748 work — closed/cancelled as superseded in the same run if authority allows.
3. Identifier-query list route remains unreliable for exact JAC-id lookup; UUID detail endpoints used for authority.

## Commits / paths

- Service: `/Users/hermes/Projects/paperclip/server/src/services/agent-folders.ts`
- Routes: `/Users/hermes/Projects/paperclip/server/src/routes/agent-folders.ts`
- Tests: `server/src/__tests__/agent-folders*.ts` (39 targeted tests green this run)
- Plan: `doc/plans/2026-08-04-hierarchical-agent-folder-structure.md` (status: implementation_complete)
