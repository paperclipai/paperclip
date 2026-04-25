# Phase 1 Summary - RT2 Shell and Product Truth

## Status

Phase 1 shell work is implemented and the build/typecheck gates now pass. Phase completion is still blocked because `pnpm test:run` fails on Windows runtime/worktree coverage that is outside the RT2 shell work itself.

## What Changed

- Rewired company-scoped routing so the default landing is `/:companyPrefix/one-liner`
- Added first-class RT2 routes for `one-liner`, `knowledge`, `marketplace`, `pnl`, `org`, `governance`, and `control-plane`
- Replaced the Paperclip-first primary nav with an RT2-first nav on desktop and mobile
- Added company-level RT2 shell pages for One-Liner, Knowledge, Marketplace, P&L, Governance, and Control Plane
- Demoted legacy Paperclip surfaces behind a secondary `Control Plane` entry
- Updated company fallback behavior, breadcrumbs, import redirects, and not-found recovery to prefer `one-liner`
- Kept Marketplace, P&L, Governance, and Graph truthful as shell/placeholder surfaces where deeper RT2 projections are not yet stabilized

## Key Files

- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/MobileBottomNav.tsx`
- `ui/src/components/CommandPalette.tsx`
- `ui/src/components/CompanyRail.tsx`
- `ui/src/lib/company-routes.ts`
- `ui/src/lib/company-page-memory.ts`
- `ui/src/pages/rt2/OneLinerPage.tsx`
- `ui/src/pages/rt2/KnowledgePage.tsx`
- `ui/src/pages/rt2/MarketplacePage.tsx`
- `ui/src/pages/rt2/PnlPage.tsx`
- `ui/src/pages/rt2/GovernancePage.tsx`
- `ui/src/pages/rt2/ControlPlanePage.tsx`

## Verification

- `pnpm -r typecheck` passed
- `pnpm build` passed
- `pnpm test:run` failed
  - `server/src/__tests__/workspace-runtime.test.ts`
  - `server/src/__tests__/opencode-local-adapter-environment.test.ts`
  - `src/__tests__/worktree.test.ts`

## Remaining Work

- Close the remaining Windows runtime/worktree test failures before Phase 1 can be marked complete
- Run the phase gap-closure loop rather than moving to Phase 2 yet
- Decide whether the existing untracked RT2 graph/governance/marketplace/P&L implementation files should be promoted into a separate execution phase or discarded
