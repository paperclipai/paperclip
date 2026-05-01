# Phase 70 인계 지시어

다음 세션에서는 먼저 Phase 69 미커밋 변경과 Phase 70 변경을 분리한다.

1. `git status --short`로 현재 dirty worktree를 확인한다.
2. Phase 70 파일만 선별 stage한다:
   - `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-RESEARCH.md`
   - `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-01-PLAN.md`
   - `.planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-HANDOFF.md`
   - `packages/shared/src/types/rt2-gamification.ts`
   - `packages/shared/src/rt2-gamification.test.ts`
   - `server/src/services/rt2-career-mate.ts`
   - `server/src/routes/rt2-career-mate.ts`
   - `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts`
   - `ui/src/api/rt2-gamification.ts`
   - `ui/src/components/Sidebar.tsx`
   - `ui/src/components/MobileBottomNav.tsx`
   - `ui/src/components/Rt2DailyBoard.tsx`
   - `ui/src/components/Rt2DailyBoard.test.tsx`
   - `ui/src/components/Rt2GamificationPanel.tsx`
3. `packages/shared/src/index.ts`, `packages/shared/src/types/index.ts`, `scripts/rt2-devplan-alignment-gate.mjs`, `scripts/rt2-devplan-alignment-gate.test.mjs`는 Phase 69 변경과 같은 파일에 섞여 있으므로 diff를 확인한 뒤 Phase 70 hunks만 포함되도록 조심해서 stage한다.
4. 검증은 이미 통과했다:
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm exec vitest run packages/shared/src/rt2-gamification.test.ts`
   - `pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx`
   - `node scripts/rt2-devplan-alignment-gate.test.mjs`
5. 선별 stage 후 커밋한다:
   - `git commit -m "feat(70): connect economy loop and CareerMate evidence"`

주의: `pnpm-lock.yaml`은 stage하지 않는다. Phase 69 graph/corpus 변경, debug script, DB migration 0106 등은 Phase 70 커밋에 포함하지 않는다.
