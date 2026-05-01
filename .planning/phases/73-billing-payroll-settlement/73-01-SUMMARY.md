# Phase 73: Billing, Payroll, and Settlement - Summary

**Completed:** 2026-05-01
**Status:** complete

## What Was Built

### Schema (`packages/db/src/schema/rt2_payroll_settlement.ts`)
- `rt2PayrollRuns` — Monthly payroll batch run record
  - period, status, totalGrossGold, totalNetGold, totalDeductions, actorCount, completedAt, errorMessage
- `rt2PayrollRunEntries` — Per-actor payroll breakdown
  - grossGold, platformFeeGold (10%), operationalFeeGold (5%), netGold, ledgerEntryId
- `rt2PaymentReceipts` — External payment provider receipts (BILL-03)
  - providerReference, amount, currency, status, paidAt, reconciledAt, settlementId
- `rt2SettlementReconciliation` — Reconciliation linking receipts to settlements
  - discrepancyGold, reconciliationStatus (matched/discrepancy/unresolved)

### Schema Extension (`packages/db/src/schema/rt2_settlement_governance.ts`)
- Added `processedAt` (timestamp), `autoProcessed` (integer default 0), `processedIdx` (index) to `rt2SettlementGovernance`

### Migration (`packages/db/src/migrations/0110_rt2_payroll_settlement_tables.sql`)
- Creates 4 new tables: `rt2_payroll_runs`, `rt2_payroll_run_entries`, `rt2_payment_receipts`, `rt2_settlement_reconciliation`
- Adds `processed_at`, `auto_processed` to `rt2_settlement_governance`
- All indexes created

### Service (`server/src/services/rt2-payroll-settlement.ts`)
- `processMonthlyPayroll(companyId, period?)` — BILL-02 monthly batch processing
  - Computes 10% platform fee + 5% operational fee = 15% total deductions
  - Creates ledger entries for net pay (85% of gross)
  - Idempotent: returns existing run if period already processed
- `getPayrollRun(companyId, period)` — Retrieve specific period run
- `listPayrollRuns(companyId, limit?)` — List recent payroll runs
- `addPaymentReceipt(companyId, data)` — BILL-03 Add external payment receipt
- `confirmPaymentReceipt(receiptId, companyId)` — Confirm receipt
- `getPaymentReceipts(companyId, options?)` — List receipts with filters
- `reconcileSettlementWithReceipt(companyId, settlementId, receiptId)` — BILL-03 Reconcile
- `getReconciliationReport(companyId, period?)` — Reconciliation summary

### Service Extension (`server/src/services/rt2-personal-pnl.ts`)
- `triggerAutomaticSettlement(companyId, period?)` — BILL-01 Auto-trigger: called when quality score approved, creates settlement rows for new approved deliverables
- `materializeAndAutoApproveLowRisk(companyId, period?, approverId?)` — BILL-01 Auto-approve low-risk settlements (riskLevel=low), marks as processedAt + autoProcessed

### Routes (`server/src/routes/rt2-payroll-settlement.ts`)
- `POST /companies/:companyId/rt2/payroll/run` — Process monthly payroll
- `GET /companies/:companyId/rt2/payroll/runs/:period` — Get specific period
- `GET /companies/:companyId/rt2/payroll/runs` — List runs
- `POST /companies/:companyId/rt2/payroll/receipts` — Add receipt
- `POST /companies/:companyId/rt2/payroll/receipts/:receiptId/confirm` — Confirm
- `GET /companies/:companyId/rt2/payroll/receipts` — List receipts
- `POST /companies/:companyId/rt2/payroll/reconcile` — Reconcile
- `GET /companies/:companyId/rt2/payroll/reconciliation-report` — Report

### App Registration (`server/src/app.ts`)
- Added `rt2PayrollSettlementRoutes` import and registration

### DevPlan Alignment (`scripts/rt2-devplan-alignment-gate.mjs`)
- Added `billing-payroll-settlement` row: BILL-01/02/03 requirements, 6 evidence files

### Tests (`server/src/__tests__/rt2-phase73-payroll-settlement.test.ts`)
- 9 tests covering: payroll run creation, listing, receipts, confirmation, reconciliation, idempotency, fee calculation
- Skipped on Windows (embedded Postgres disabled by default — verify file is valid)

## Decisions Applied
- **D-BILL-01:** `triggerAutomaticSettlement` creates settlement rows; `materializeAndAutoApproveLowRisk` auto-approves riskLevel=low
- **D-BILL-02:** Payroll runs monthly per company; 10% platform + 5% operational = 15% total deductions
- **D-BILL-03:** `rt2PaymentReceipts` stores provider_reference/amount/paid_at, links to ledger entries
