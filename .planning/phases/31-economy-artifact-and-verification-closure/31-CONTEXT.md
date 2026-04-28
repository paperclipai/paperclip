# Phase 31: Economy Artifact and Verification Closure - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 31 closes v2.4 audit gaps for the economy stack by turning Phase 27 ledger atomicity evidence and Phase 28 settlement governance evidence into accepted, traceable verification artifacts. It does not add new ledger or settlement capabilities unless verification finds a concrete execution gap that prevents LEDGER-01 through LEDGER-05 or SETTLE-01 through SETTLE-04 from being honestly accepted.

</domain>

<decisions>
## Implementation Decisions

### Closure Artifact Scope
- **D-01:** Create or repair Phase 27 artifacts needed for milestone acceptance: `27-VERIFICATION.md` and `27-VALIDATION.md`.
- **D-02:** Create or repair Phase 28 artifacts needed for milestone acceptance: `28-VERIFICATION.md` and `28-VALIDATION.md`.
- **D-03:** Update Phase 27 and Phase 28 summary frontmatter with `requirements-completed` only for requirements accepted by the new verification artifacts.
- **D-04:** Treat Phase 31 as audit closure first. Source changes are allowed only when verification proves an economy requirement is not implemented or not testable from the current code.

### Evidence Standard
- **D-05:** Every accepted LEDGER or SETTLE requirement must cite exact code and test evidence. The minimum evidence set is: implementing service file, schema/migration file when relevant, route/API or UI surface when relevant, and focused test or UAT evidence.
- **D-06:** Do not mark a requirement accepted from planning text alone. Phase 27 and 28 CONTEXT/PLAN files explain intent, but acceptance must come from repository evidence and command results.
- **D-07:** If a requirement has partial or missing implementation, record it as an explicit execution gap in `VERIFICATION.md` and `VALIDATION.md` rather than inflating completion.

### Phase 27 Ledger Closure
- **D-08:** LEDGER-01 through LEDGER-05 should be verified against atomic `balanceAfter` writes, transaction-wrapped income/expense, cross-table P&L reconciliation, `leg` debit/credit persistence, and `balance_after >= 0` enforcement.
- **D-09:** Phase 27 verification must include the Phase 27 concurrency hardening evidence: transaction-scoped PostgreSQL advisory locks and the embedded Postgres regression that verifies monotonic `balanceAfter` values for concurrent same-actor writes.
- **D-10:** Phase 27 validation should include Nyquist-style scenarios for atomic insert-time balance computation, transaction rollback, transfer atomicity, reconciliation accuracy, leg classification, non-negative balance enforcement, and concurrent same-actor serialization.

### Phase 28 Settlement Closure
- **D-11:** SETTLE-01 through SETTLE-04 should be verified against duplicate settlement prevention, anti-gaming signal visibility, linked ledger evidence on approval, and company-scoped threshold persistence/editing.
- **D-12:** Phase 28 verification must explicitly trace the economic feedback flow from settlement approval to linked ledger row to exposed `balanceAfter` evidence.
- **D-13:** Phase 28 validation should include Nyquist-style scenarios for conflict-safe settlement materialization, threshold-backed signal generation, approval ledger evidence, rejected settlement non-materialization, and threshold UI/API persistence.

### Verification Run Handling
- **D-14:** Prefer focused economy verification commands before full-suite commands. The repository has broad unrelated dirty state, and Windows embedded Postgres tests may skip unless explicitly enabled.
- **D-15:** Record exact command outcomes in the artifacts, including skipped embedded-Postgres tests and unrelated full-suite failures. Do not convert skips into pass/fail claims.
- **D-16:** If `pnpm typecheck` or `pnpm test` cannot be run cleanly because of pre-existing unrelated workspace changes, document the blocker separately from Phase 31 requirement evidence.

### the agent's Discretion
- Exact artifact section headings and frontmatter field ordering can follow the Phase 30 closure artifact pattern.
- The plan may split Phase 27 and Phase 28 closure into separate tasks, but the phase is not complete until both economy artifact sets exist and trace LEDGER and SETTLE requirements.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and Phase Scope
- `.planning/PROJECT.md` - RT2-first identity, economy principles, and current v2.4 context.
- `.planning/REQUIREMENTS.md` - LEDGER-01 through LEDGER-05 and SETTLE-01 through SETTLE-04 traceability targets.
- `.planning/ROADMAP.md` - Phase 31 goal, dependency, audit gap closure description, and success criteria.
- `.planning/STATE.md` - Current milestone state and Phase 31 next-step context.
- `.planning/v2.4-MILESTONE-AUDIT.md` - Audit reset and gap closure rationale for Phase 31.

### Prior Phase Decisions and Evidence
- `.planning/phases/27-coin-ledger-atomicity/27-CONTEXT.md` - Ledger atomicity decisions and evidence anchors.
- `.planning/phases/27-coin-ledger-atomicity/27-01-SUMMARY.md` - Ledger schema and atomic balance write summary.
- `.planning/phases/27-coin-ledger-atomicity/27-02-SUMMARY.md` - P&L transaction and reconciliation summary.
- `.planning/phases/27-coin-ledger-atomicity/27-03-SUMMARY.md` - Concurrency hardening summary and command evidence.
- `.planning/phases/27-coin-ledger-atomicity/27-UAT.md` - Seven passing UAT checks for ledger atomicity and concurrency.
- `.planning/phases/27-coin-ledger-atomicity/27-SECURITY.md` - Threat closure for ledger tampering, concurrency, and transfer atomicity.
- `.planning/phases/28-settlement-governance-hardening/28-CONTEXT.md` - Settlement governance hardening decisions and evidence anchors.
- `.planning/phases/28-settlement-governance-hardening/28-01-SUMMARY.md` - Settlement delivery summary and known command outcomes.
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-CONTEXT.md` - Artifact-closure pattern to mirror for economy.
- `.planning/phases/30-knowledge-artifact-and-verification-closure/30-VERIFICATION.md` - Phase-level closure verification pattern.

### Existing Code Evidence
- `packages/db/src/schema/rt2_personal_pnl.ts` - Coin ledger schema, `leg`, `balanceAfter`, and non-negative balance check.
- `packages/db/src/schema/rt2_settlement_governance.ts` - Settlement governance, anti-gaming signal, and threshold schemas.
- `packages/db/src/migrations/0078_rt2_ledger_atomicity.sql` - Phase 27 ledger atomicity migration.
- `packages/db/src/migrations/0080_rt2_settlement_governance_hardening.sql` - Phase 28 settlement governance hardening migration.
- `server/src/services/rt2-personal-pnl.ts` - Ledger writes, advisory locks, P&L reconciliation, settlement materialization, approval, thresholds, and linked ledger evidence.
- `server/src/routes/rt2-personal-pnl.ts` - Economy API routes for P&L, settlement approval, threshold reads/writes, and audit logging.
- `ui/src/api/rt2-economy.ts` - Frontend settlement and ledger evidence API types/client.
- `ui/src/pages/rt2/PnlPage.tsx` - P&L settlement governance UI, threshold controls, signal display, and balance-after evidence.

### Test Evidence
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` - Embedded Postgres coverage for ledger atomicity, settlement governance, concurrency, thresholds, and linked ledger evidence.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` - Route fallback coverage for settlement approval response shape and ledger evidence.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2PersonalPnLService.recordCoinTransaction()` already computes `balanceAfter` in SQL and locks the actor ledger scope before insert.
- `rt2PersonalPnLService.recordIncome()`, `recordExpense()`, and `transferCoins()` already wrap related P&L and ledger writes in `db.transaction()`.
- `rt2PersonalPnLService.reconcileActorPnL()` already computes P&L net, ledger sum, diff, and `isReconciled`.
- `rt2PersonalPnLService.ensureSettlementRows()` already materializes settlement rows with conflict-safe behavior.
- `rt2PersonalPnLService.approveSettlement()` already records linked ledger evidence and stores `ledgerEntryId`.
- `PnlPage` already renders settlement signals, threshold controls, approval actions, and `Balance after` evidence.

### Established Patterns
- Phase closure artifacts should be requirement-traceable and evidence-backed after the v2.4 audit reset.
- Earlier phase summaries need `requirements-completed` frontmatter for milestone audit acceptance.
- Verification artifacts should distinguish accepted requirements, explicit gaps, skipped tests, unrelated failures, and residual risk.
- Economy behavior is company-scoped, ledger-backed, and sensitive to transaction/concurrency evidence.

### Integration Points
- Phase 31 writes planning artifacts in `.planning/phases/27-coin-ledger-atomicity/`, `.planning/phases/28-settlement-governance-hardening/`, and `.planning/phases/31-economy-artifact-and-verification-closure/`.
- Requirement traceability flows back to `.planning/REQUIREMENTS.md` and later Phase 32 milestone acceptance closure.
- Any code fixes discovered during closure must stay limited to economy schema, P&L service/routes, economy UI/API, or focused economy tests.

</code_context>

<specifics>
## Specific Ideas

- Use traceability tables with columns: requirement, status, evidence, tests, residual risk.
- Include artifact-level statements such as "Accepted only if code/test evidence below passes; otherwise explicit gap."
- For Phase 27, likely evidence anchors include `lockActorLedgerScope()`, SQL `balanceAfter` subqueries, `db.transaction()` wrappers, `reconcileActorPnL()`, `leg` checks, and non-negative balance constraints.
- For Phase 28, likely evidence anchors include `(company_id, work_product_id)` uniqueness, `onConflictDoUpdate`, threshold schema/routes/UI, `detectSettlementSignals()`, `ledgerEntryId`, and `ledgerEvidence.balanceAfter`.

</specifics>

<deferred>
## Deferred Ideas

- Automatic penalty execution, reputation demotion, appeal workflow, and payroll export remain outside Phase 31.
- New economy features or UI surfaces remain outside Phase 31 unless required to close a verified implementation gap.
- Phase 32 owns remaining lint traceability and final milestone acceptance closure.

</deferred>

---

*Phase: 31-economy-artifact-and-verification-closure*
*Context gathered: 2026-04-28*
