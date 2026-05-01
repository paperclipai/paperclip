# Phase 70: Economy, Marketplace, P&L, and CareerMate Loop - Context

**Gathered:** 2026-05-01T15:08:12+09:00
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 70 connects the existing RealTycoon2 economy surfaces into the primary product loop: Marketplace, P&L, amoeba economy rollups, and CareerMate/avatar/reputation progression must all be backed by deliverable, quality, settlement, anti-gaming, and ledger evidence.

This phase must build on the shipped Phase 7 economy baseline, Phase 22 settlement governance, Phase 27 ledger atomicity, Phase 66 daily cockpit, and current P&L/Marketplace/Career/Gamification services. It must not create a public/open marketplace, real billing/payroll export, autonomous penalty system, or a greenfield economy schema. The goal is to make the existing pieces coherent, navigable, and evidence-backed enough for `ECON-01`, `ECON-02`, and `ECON-03`.

</domain>

<decisions>
## Implementation Decisions

### Primary Navigation And Daily Cockpit Entry
- **D-01:** Keep existing first-class product routes for P&L and Marketplace (`/pnl`, `/marketplace`) and make them reachable from the primary navigation loop without hiding them behind maintenance-only pages.
- **D-02:** The Phase 66 daily cockpit remains the first operating surface. Add or strengthen compact economy evidence in the right-side evidence area so operators can move from a work card/deliverable to P&L, settlement, marketplace, and CareerMate evidence.
- **D-03:** Do not create a separate "economy dashboard" parallel to `DailyWorkPage`, `PnlPage`, and `MarketplacePage`. Planning should connect and enrich the existing surfaces.
- **D-04:** Product-facing labels remain Korean-first and RealTycoon2/Jarvis/work oriented. `P&L`, `Marketplace`, `gold`, `CareerMate`, and `amoeba` may appear as product concepts, but Paperclip/legacy marketplace language must not leak into operator copy.

### Economy Source Of Truth And Rollups
- **D-05:** P&L source of truth is approved settlement plus atomic coin ledger evidence, not manual income/expense shell rows. Manual endpoints may remain compatibility tools, but completion claims must prove settlement/ledger-derived rows.
- **D-06:** Approved deliverables contribute to revenue only when quality evidence is finalized/active and manager-approved or explicitly auto-approved according to the existing quality contract.
- **D-07:** Amoeba rollups should be visible at actor, user/agent, project, and company levels. Project-level rollup can reuse existing task/project/deliverable relationships; do not introduce a new amoeba hierarchy schema unless existing project/company scopes cannot express the DevPlan evidence.
- **D-08:** Price negotiation and settlement outcomes must flow into the same rollup contract: proposed amount, final amount, approval/rejection, decision reason, ledger entry, P&L period, and anti-gaming signals.
- **D-09:** Rejected settlements must not create ledger entries or positive CareerMate progress. They should remain visible as negative/neutral governance evidence with decision reason.
- **D-10:** Anti-gaming outcomes influence rollup interpretation but do not automatically impose penalties in this phase. Automatic demotion, penalty, fraud case workflow, and payroll export remain future scope.

### Marketplace Evidence And Pricing Boundary
- **D-11:** Marketplace listings stay company-scoped/trusted-company ecosystem evidence for this phase. Public/open marketplace launch and real payment settlement are out of scope.
- **D-12:** Listing quality must be derived from live RT2 evidence: approved deliverable count, average quality, base price/gold basis, settlement/gold earned, reputation, collaboration multiplier, subscription/usage demand, and latest approved deliverables.
- **D-13:** Marketplace ranking/explanation should prefer evidence-ready listings over empty catalog rows. If a listing has no approved deliverable/quality/settlement evidence, the UI must label it as missing/partial rather than presenting it as proven capability.
- **D-14:** Pricing display may keep current cents-based listing fields for subscription/per-task compatibility, but Phase 70 completion needs visible gold/deliverable basis so the marketplace connects to the RT2 economy loop.

### CareerMate, Avatar, And Reputation Progression
- **D-15:** CareerMate progression must be computed from ledger, settlement, quality, and gamification evidence. Do not rely on manually edited profile stats or placeholder quality values for `ECON-03` completion.
- **D-16:** Use existing `rt2CareerProfiles`, portfolio, milestones, `rt2CollaborationRewards`, gamification XP/level, and coin ledger records as the integration substrate. Planning may add a derived progression/read-model service if needed, but it should not replace existing tables.
- **D-17:** Progression inputs should include completed/approved deliverables, finalized quality score, earned gold/ledger balance, settlement approval/rejection, anti-gaming flags, collaboration/reputation index, XP level, achievements, and portfolio evidence.
- **D-18:** Avatar/CareerMate UI should show current level/tier, reputation band, gold/quality basis, milestone progress, and evidence links back to settlements, deliverables, and quality rows. It must be clear whether a number is derived from evidence or missing.
- **D-19:** High-risk or rejected settlement evidence should suppress or flag progression credit rather than silently counting toward reputation/level.

### Governance, DevPlan Gate, And Verification
- **D-20:** Update `scripts/rt2-devplan-alignment-gate.mjs` so `Economy, marketplace, P&L, CareerMate loop` becomes `complete` only after primary navigation/cockpit access, settlement-ledger rollups, marketplace evidence, CareerMate progression, and focused tests are all anchored.
- **D-21:** Verification should include focused service/route/UI tests for P&L rollups, settlement approval/rejection, marketplace listing evidence, CareerMate progression, gamification/ledger integration, and the DevPlan alignment gate.
- **D-22:** Default verification remains `pnpm typecheck && pnpm test`. Do not run `pnpm test:e2e` as the default Phase 70 gate.

### the agent's Discretion
- Exact route additions and response field names, provided shared/server/UI contracts are typed and evidence-backed.
- Exact visual layout for economy evidence inside the daily cockpit, provided it links naturally to P&L, Marketplace, settlement, and CareerMate surfaces.
- Exact formula for CareerMate level/tier/reputation derivation, provided it is deterministic, documented in tests, and based on ledger/quality/settlement evidence rather than placeholder stats.
- Whether project-level amoeba rollup is implemented inside `rt2PersonalPnLService` or a small dedicated economy loop service, provided existing P&L APIs remain backward-compatible.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `AGENTS.md` - Korean-first workflow, RealTycoon2 terminology, verification command policy, lockfile policy, and no-overplanning guidance.
- `.planning/PROJECT.md` - v3.1 DevPlan Core Convergence goal, RealTycoon2-first identity, economy loop target, and brownfield constraints.
- `.planning/REQUIREMENTS.md` - `ECON-01`, `ECON-02`, and `ECON-03`.
- `.planning/ROADMAP.md` - Phase 70 goal, success criteria, and dependency on Phase 66.
- `.planning/STATE.md` - Current position and v3.1 cumulative context.
- `.planning/devplan-alignment-runs/2026-05-01T04-54-40-916Z/report.md` - Latest alignment report marking economy/marketplace/P&L/CareerMate as Phase 70 partial.
- `.planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md` - Evidence-backed completion and product identity rules.
- `.planning/phases/66-daily-work-and-okr-cockpit-convergence/66-CONTEXT.md` - Daily cockpit placement and right-side evidence surface decisions.

### Prior Economy Decisions
- `.planning/phases/07-amoeba-economy-collaboration-and-marketplace/07-CONTEXT.md` - Ledger/evidence-backed P&L, marketplace evidence, and collaboration reward baseline.
- `.planning/phases/18-economy-and-rollout-depth/18-CONTEXT.md` - Economy evidence and P&L depth decisions from v2.2.
- `.planning/phases/22-settlement-governance-and-anti-gaming/22-CONTEXT.md` - Settlement negotiation, approval/rejection, anti-gaming signal, and ledger/P&L flow decisions.
- `.planning/phases/27-coin-ledger-atomicity/27-CONTEXT.md` - Atomic ledger, `leg`, non-negative balance, transaction, and reconciliation decisions.
- `.planning/phases/28-settlement-governance-hardening/28-CONTEXT.md` - Settlement hardening and duplicate materialization boundary if planning touches settlement idempotency.
- `.planning/RETROSPECTIVE.md` - Economy lesson that settlement decision, gold ledger, P&L, and anti-gaming signal must close together.

### Existing Economy Code And Tests
- `packages/db/src/schema/rt2_personal_pnl.ts` - P&L and coin ledger schema.
- `packages/db/src/schema/rt2_settlement_governance.ts` - Settlement governance and anti-gaming persistence.
- `packages/db/src/schema/rt2_agent_marketplace.ts` - Marketplace listing, BYOA, and subscription schema.
- `packages/db/src/schema/rt2_career_mate.ts` - Career profile, portfolio, skill transfer, and milestone schema.
- `packages/db/src/schema/rt2_reputation_expansion.ts` - Promotion, performance review, credit conversion, and reputation constants.
- `packages/db/src/schema/rt2_gamification_agent_balances.ts` - Existing gamification gold balance table that must be reconciled or bridged with ledger evidence.
- `packages/shared/src/types/rt2-gamification.ts` - XP, level, achievement, leaderboard, and token balance contracts.
- `server/src/services/rt2-personal-pnl.ts` - Settlement, ledger, P&L summary/drilldown, thresholds, and anti-gaming signal service.
- `server/src/routes/rt2-personal-pnl.ts` - Company-scoped P&L, settlement, coin, and budget routes.
- `server/src/services/rt2-agent-marketplace.ts` - Marketplace listing evidence from deliverables, quality, rewards, and subscriptions.
- `server/src/routes/rt2-agent-marketplace.ts` - Company-scoped marketplace listing and subscription routes.
- `server/src/services/rt2-career-mate.ts` - Existing CareerMate profile, portfolio, skill transfer, and milestone behavior.
- `server/src/routes/rt2-career-mate.ts` - CareerMate routes to harden if progression evidence is exposed.
- `server/src/services/rt2-gamification.ts` - XP/level/achievement/gold balance and token economy service.
- `server/src/routes/rt2-gamification.ts` - Gamification and economy routes.
- `server/src/services/rt2-reputation-expansion.ts` - Reputation tier, promotion trigger, credit conversion, and performance review service.
- `server/src/routes/rt2-reputation-expansion.ts` - Reputation/promotion/credit conversion routes.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` - Existing economy/marketplace baseline tests.
- `scripts/rt2-devplan-alignment-gate.mjs` - v3.1 completion truth gate to update after implementation.
- `scripts/rt2-devplan-alignment-gate.test.mjs` - Focused alignment gate tests.

### Existing UI Surfaces
- `ui/src/pages/rt2/DailyWorkPage.tsx` - First operating screen and daily cockpit query orchestration.
- `ui/src/components/Rt2DailyBoard.tsx` - Three-panel cockpit and right-side evidence surface to extend with economy loop links.
- `ui/src/pages/rt2/PnlPage.tsx` - P&L summary, settlement governance, actor drilldown, and ledger evidence UI.
- `ui/src/pages/rt2/MarketplacePage.tsx` - Marketplace listing evidence UI.
- `ui/src/components/Rt2GamificationPanel.tsx` - Current leaderboard/achievement/economy panel that needs evidence-backed CareerMate/gold integration.
- `ui/src/api/rt2-economy.ts` - P&L, settlement, and marketplace client API.
- `ui/src/api/rt2-gamification.ts` - Gamification and economy client API.
- `ui/src/App.tsx` - Route and navigation integration for Marketplace/P&L primary-loop access.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2PersonalPnLService` already materializes approved deliverable P&L, records atomic ledger-backed income/expense/transfer entries, exposes settlement overview, thresholds, comments, approve/reject actions, actor drilldown, and company summary evidence.
- `rt2SettlementGovernance` and `rt2AntiGamingSignals` already preserve proposed/final price, rationale, negotiation comments, approval status, risk level, decision reason, ledger linkage, and signal use.
- `rt2AgentMarketplaceService` already enriches listings with deliverable count, approved deliverable count, average quality score, base price gold, earned gold estimate, reputation index, collaboration multiplier, subscriptions, and evidence status.
- `rt2CareerMateService` already owns profile, portfolio, skill transfer, milestone, and portable export primitives, but its stats are not yet strongly derived from ledger/quality/settlement evidence.
- `rt2GamificationService` already has XP, level history, achievements, leaderboard, and a separate gold balance table. Phase 70 should bridge this with `rt2CoinLedger` rather than leaving two unrelated gold stories.
- `Rt2DailyBoard`, `PnlPage`, `MarketplacePage`, and `Rt2GamificationPanel` are the existing UI surfaces to connect instead of creating a new parallel dashboard.

### Established Patterns
- Company-scoped RT2 routes use `assertCompanyAccess` and focused Vitest route/service tests.
- Important economy mutations should log activity and preserve audit evidence.
- Completion claims require code/schema/route/UI/test anchors; DevPlan rows must stay `partial` until evidence exists.
- Product-facing UI copy is Korean-first; internal route/type names may remain English for compatibility.
- Focused service/route/component/script tests are accepted evidence on this Windows host. Playwright e2e is not default.

### Integration Points
- Extend or add shared economy/CareerMate/gamification contracts before changing server responses and UI consumers.
- Add an economy loop/read-model service or extend `rt2PersonalPnLService` to produce actor/user/project/company amoeba rollups from settlements, ledger entries, deliverables, quality rows, and task participants.
- Extend marketplace evidence to include settlement outcome/gold ledger basis and clearer missing/partial/ready status.
- Add CareerMate progression derivation that reads quality rows, approved/rejected settlements, ledger entries, gamification XP/achievement state, and reputation rows.
- Surface economy links/evidence in `Rt2DailyBoard` and route users to `PnlPage`, `MarketplacePage`, and CareerMate/gamification details.
- Update `scripts/rt2-devplan-alignment-gate.mjs` only after implementation and tests prove `ECON-01..03`.

</code_context>

<specifics>
## Specific Ideas

- Recommended economy loop shape: `{ rollups, settlementSummary, marketplaceSummary, careerProgression, evidenceStatus, warnings }`.
- Recommended rollup dimensions: `company`, `project`, `actor`, `user`, and `agent`.
- Recommended rollup evidence fields: approved deliverables, proposed gold, approved gold, rejected gold, ledger income, ledger expense, net P&L, average quality, anti-gaming signal count, high-risk settlement count, and source row counts.
- Recommended CareerMate progression fields: level, tier, reputationBand, avatarState, qualityAverage, earnedGold, approvedSettlementCount, rejectedSettlementCount, flaggedSettlementCount, portfolioCount, achievements, nextMilestone, and evidence links.
- Recommended UI behavior: the daily cockpit shows compact economy status and deep links; detailed negotiation remains on `PnlPage`; listing quality remains on `MarketplacePage`; CareerMate/gamification progression appears where actor/Jarvis evidence is already shown.

</specifics>

<deferred>
## Deferred Ideas

- Public/open company marketplace launch remains future public rollout scope.
- Real billing, payroll export, HR compensation export, and external payment settlement remain out of scope.
- Automatic penalty, reputation demotion, fraud case workflow, and autonomous anti-gaming enforcement remain future governance hardening.
- Native/mobile-specific economy surfaces remain out of scope unless needed as a regression-safe link to existing web surfaces.
- Cross-company federation marketplace behavior remains outside the trusted company ecosystem boundary for v3.1.

</deferred>

---

*Phase: 70-economy-marketplace-p-l-and-careermate-loop*
*Context gathered: 2026-05-01T15:08:12+09:00*
