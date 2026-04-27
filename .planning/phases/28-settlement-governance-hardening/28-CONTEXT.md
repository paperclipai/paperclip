# Phase 28: Settlement Governance Hardening - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 28 hardens the existing settlement approval flow. It enforces one settlement governance row per company/work product, exposes the linked ledger entry and `balanceAfter` on approved settlements, keeps anti-gaming signals visible in the approval UI, and adds company-scoped configurable thresholds for the three existing signal types. Automatic penalties, reputation demotion, payroll export, and fraud case workflow remain out of scope.

</domain>

<decisions>
## Implementation Decisions

### Double Materialization Guard
- **D-01:** `rt2_settlement_governance` must enforce a database-level unique constraint/index on `(company_id, work_product_id)`.
- **D-02:** `ensureSettlementRows()` must treat the unique constraint as the source of truth and use conflict-safe insert/upsert behavior instead of relying only on pre-insert existence checks.
- **D-03:** If the same approved deliverable is discovered twice, the service should return/update the existing settlement row rather than producing a second approval artifact.

### Ledger Evidence on Approval
- **D-04:** Approved settlement responses must include linked ledger evidence: `ledgerEntryId`, amount, `balanceAfter`, period, and transaction type.
- **D-05:** Pending/proposed settlements should explicitly show that ledger evidence is created only after approval; rejected settlements must not create a ledger entry.
- **D-06:** The approval UI should show ledger evidence inline on the settlement card, not in a separate route.

### Anti-Gaming Signals
- **D-07:** The three Phase 22 signal types remain the required set: `repeated_self_review`, `abnormal_gold_farming`, and `quality_score_bias`.
- **D-08:** Signals are decision support only. They must affect approval gate/risk display, but this phase must not add automatic penalty or reputation demotion behavior.
- **D-09:** Signal cards in the settlement UI should show label, severity, evidence, and the configured threshold basis so approvers understand why a signal fired.

### Company Threshold Settings
- **D-10:** Add company-scoped threshold persistence for settlement governance settings, defaulting to the current hardcoded behavior.
- **D-11:** Thresholds should be edited from the existing P&L settlement governance section, because approvers already review settlements there.
- **D-12:** Threshold inputs should cover trigger values and score windows: self-review critical count, gold-farming earned count, gold-farming warning/critical totals or multipliers, high-value settlement gold, quality-bias auto score, and evaluation lookback window.
- **D-13:** Threshold reads should be used by settlement row generation and signal detection, so changing settings affects newly refreshed settlement signals without requiring a code deploy.

### Agent Discretion
- Exact constraint name, migration number, and field names can follow the repo's Drizzle/migration conventions.
- The threshold UI can be compact and utilitarian; it should prioritize clear numeric inputs and save feedback over a separate settings page.

</decisions>

<specifics>
## Specific Ideas

- Use current Phase 22 defaults as initial settings: high-value settlement at `1000G`, gold farming warning at `5` earned entries or `max(1500G, revenue * 3)`, gold farming critical at `max(2500G, revenue * 5)`, self-review critical at `2`, quality-bias score at `98`.
- If an approved settlement has a ledger row, show `Ledger <short id>`, transaction type, amount, period, and `Balance after <value>`.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` — RT2-first identity, economy governance principles, and v2.4 milestone context.
- `.planning/REQUIREMENTS.md` — `SETTLE-01` through `SETTLE-04` acceptance requirements.
- `.planning/ROADMAP.md` — Phase 28 goal, dependency on Phase 27, and success criteria.

### Prior Decisions
- `.planning/phases/22-settlement-governance-and-anti-gaming/22-CONTEXT.md` — existing settlement flow and anti-gaming intent.
- `.planning/phases/27-coin-ledger-atomicity/27-CONTEXT.md` — ledger atomicity decisions and approved-settlement dependency.

### Existing Code
- `packages/db/src/schema/rt2_settlement_governance.ts` — settlement governance and anti-gaming signal schemas.
- `packages/db/src/schema/rt2_personal_pnl.ts` — coin ledger schema, `balanceAfter`, and ledger constraints.
- `packages/db/src/migrations/0076_rt2_phase22_settlement_governance.sql` — existing settlement table migration.
- `packages/db/src/migrations/0078_rt2_ledger_atomicity.sql` — Phase 27 ledger constraints.
- `server/src/services/rt2-personal-pnl.ts` — settlement generation, signal detection, approval/rejection, and ledger write path.
- `server/src/routes/rt2-personal-pnl.ts` — settlement API endpoints and audit logging.
- `ui/src/api/rt2-economy.ts` — frontend settlement API types/client.
- `ui/src/pages/rt2/PnlPage.tsx` — existing P&L and settlement governance UI.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` — embedded Postgres coverage for P&L, settlement, ledger, and route behavior.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2PersonalPnLService.ensureSettlementRows()` already materializes settlement rows from approved deliverables and is the right place to apply unique/upsert behavior and threshold-backed signal generation.
- `detectSettlementSignals()` already computes the three required anti-gaming signals; replace hardcoded thresholds with company settings.
- `approveSettlement()` already writes a ledger row and stores `ledgerEntryId`; extend returned settlement data with ledger evidence.
- `PnlPage` already renders settlement cards, anti-gaming signals, approve/reject/comment controls, and P&L evidence.

### Established Patterns
- Company-scoped settings already exist as dedicated tables with `company_id` unique constraints in nearby RT2 features.
- Important RT2 mutations go through company-scoped routes and activity log entries.
- UI data uses React Query invalidation after settlement mutations.

### Integration Points
- `GET /companies/:companyId/rt2/pnl/settlements` should return thresholds and ledger evidence along with settlements.
- Add threshold read/write endpoints under the existing settlement/P&L route group to avoid introducing a separate governance surface.
- Database migration must alter the existing settlement table and add threshold persistence without rewriting prior migrations.

</code_context>

<deferred>
## Deferred Ideas

- Automatic penalty execution, reputation demotion, and appeal workflow — future governance/legal phase.
- External HR/payroll settlement export — future integration phase.
- Full fraud case management workflow — future governance operations phase.

</deferred>

---

*Phase: 28-settlement-governance-hardening*
*Context gathered: 2026-04-28*
