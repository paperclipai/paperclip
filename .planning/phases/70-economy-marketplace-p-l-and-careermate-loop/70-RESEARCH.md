# Phase 70 Research - Economy, Marketplace, P&L, and CareerMate Loop

**Generated:** 2026-05-01T15:13:39+09:00
**Mode:** auto chain

## Current Assets

- `PnlPage`, `rt2PersonalPnLService`, and `rt2SettlementGovernance` already expose settlement proposal, approval/rejection, ledger evidence, P&L period, anti-gaming signals, and approved-deliverable revenue.
- `MarketplacePage` and `rt2AgentMarketplaceService` already enrich listings with approved deliverables, average quality, base price gold, earned gold estimate, reputation, collaboration multiplier, subscription count, and evidence status.
- `Rt2DailyBoard` already has a right-side "경제 근거" panel, but it only summarizes Gold/XP/deliverable/quality counts and does not route operators to P&L, settlements, marketplace, or CareerMate evidence.
- `Sidebar` does not expose `/pnl` or `/marketplace` in the company navigation, although routes exist in `App.tsx`. Mobile bottom nav already exposes `/pnl`.
- `Rt2GamificationPanel` shows leaderboard, achievements, and finance-style economy data, but CareerMate progression is not derived from settlement, ledger, quality, and achievement evidence.
- `rt2CareerMateService` owns profile, portfolio, skill transfer, and milestone data. It does not yet provide a derived progression read-model.

## Smallest Safe Implementation

1. Add a typed CareerMate progression contract and deterministic helper in `packages/shared/src/types/rt2-gamification.ts`.
2. Extend `rt2CareerMateService` with a `getCareerProgression(companyId, agentId)` read-model that joins existing evidence tables:
   - `rt2CareerProfiles`
   - `rt2CareerPortfolio`
   - `rt2CareerMilestones`
   - `rt2SettlementGovernance`
   - `rt2CoinLedger`
   - `rt2QualityScores`
   - `rt2GamificationXpTransactions`
   - `rt2GamificationAchievements`
   - `rt2GamificationAgentBalances`
3. Expose the read-model at `GET /companies/:companyId/rt2/career/progression/:agentId`.
4. Add a typed API client and show compact CareerMate evidence in `Rt2GamificationPanel` when an `agentId` is available.
5. Add `/pnl` and `/marketplace` to primary company navigation and add daily cockpit deep links to P&L, settlements, Marketplace, and CareerMate/gamification.
6. Update DevPlan alignment row only after code/test anchors exist.

## Verification Targets

- Pure shared test for progression formula:
  - approved settlement/gold/quality evidence increases tier.
  - rejected/high-risk settlement evidence suppresses credit and marks review state.
  - missing evidence is explicitly partial/missing rather than presented as proven progress.
- UI component test for daily board economy links.
- DevPlan gate test verifies `economy-loop` becomes complete with Phase 70 evidence anchors.
- Final default verification: `pnpm typecheck && pnpm test`.

## Deferred

- No new public marketplace launch.
- No billing/payroll export.
- No automatic anti-gaming penalty or demotion.
- No new amoeba hierarchy schema.
