# Phase 73 — Billing, Payroll, and Settlement: CONTEXT

## Phase
- **Number**: 73
- **Name**: Billing, Payroll, and Settlement
- **Milestone**: v3.2 Future Scope
- **Requirements**: BILL-01, BILL-02, BILL-03

## Domain Overview

The existing settlement and P&L system handles:
- Settlement governance: `rt2SettlementGovernance` with anti-gaming signals, approval workflows
- Coin ledger: `rt2CoinLedger` with atomic `balanceAfter` via SQL subqueries
- Personal P&L: `rt2PersonalPnL` with income/expense tracking per actor per period
- Quality score → deliverable approval → ledger entry flow via `materializeApprovedDeliverablePnL`

## Existing Implementation

### Automatic P&L Materialization (`rt2-personal-pnl.ts`)
- `materializeApprovedDeliverablePnL(companyId, period)` — scans approved quality scores, creates ledger entries if not already created
- `ensureSettlementRows(companyId, period)` — creates `rt2SettlementGovernance` rows with anti-gaming signals
- `approveSettlement(companyId, settlementId, input)` — creates ledger entry via `recordIncomeWithLedger`, links via `ledgerEntryId`
- Called lazily when settlement overview is accessed — not triggered automatically on quality approval

### Settlement Anti-Gaming (`rt2_settlement_governance.ts`)
- `rt2SettlementGovernance`: work_product_id → proposed_price → approved/rejected with risk level
- `rt2SettlementThresholds`: high_value_gold, self_review_critical_count, gold_farming thresholds
- `rt2AntiGamingSignals`: signals attached to settlements

### Personal P&L (`rt2_personal_pnl.ts`)
- `rt2PersonalPnL`: per-actor per-period income/expense/net
- `rt2CoinLedger`: transaction log with leg (credit/debit), balanceAfter
- `recordIncomeWithLedger`: atomic P&L + ledger in single transaction
- `transferCoins`: atomic actor-to-actor transfer
- `reconcileActorPnL`: cross-table reconciliation (P&L vs ledger sums)

### Payroll (CareerMate — `rt2-career-mate.ts`)
- Career profiles, portfolio, milestones
- No dedicated monthly payroll processing loop yet

## Gaps Identified

### BILL-01 Gap: Automatic Settlement Processing
`materializeApprovedDeliverablePnL` creates ledger entries lazily (on P&L read). Settlement governance rows are also created lazily. No mechanism to:
1. Trigger settlement creation immediately when quality score is approved
2. Track which settlements have been auto-processed vs need manual approval

**Phase 73 resolution**: Add `processedAt` timestamp to track settlement auto-processing, add service method `triggerAutomaticSettlement(companyId)` called from quality score approval event.

### BILL-02 Gap: Monthly Payroll Processing
No dedicated payroll processing:
- No monthly payroll run mechanism
- No payroll deduction/credit loop
- No payroll summary with net pay calculations

**Phase 73 resolution**: Add `rt2PayrollRun` schema + `processMonthlyPayroll(companyId, period)` method that deducts from agent balances and credits operators.

### BILL-03 Gap: Payment Receipt Evidence
No external payment provider integration:
- No way to store payment receipts (bank transfers, payment provider confirmations)
- No reconciliation between internal ledger and external evidence
- Settlement ledger entries are traceable but not linked to external receipts

**Phase 73 resolution**: Add `rt2PaymentReceipts` schema + `reconcileSettlementWithReceipt(settlementId, receiptId)` method + reconciliation evidence in `SettlementFlow`.

## Decisions

### D-BILL-01: Settlement auto-processing trigger
Settlement rows will be auto-created when quality score is approved, via a new `onQualityScoreApproved` hook in the quality scoring service. Settlements requiring manual approval will still go through `/approve` route; low-risk settlements can be auto-approved.

### D-BILL-02: Payroll processing model
Monthly payroll run is a company-scoped batch operation that:
1. Computes each agent's net pay (income - deductions)
2. Creates payroll ledger entries: `company → agent` for net pay
3. Records payroll run evidence for audit

### D-BILL-03: Payment receipt reconciliation
`rt2PaymentReceipts` stores: provider_reference, amount, currency, paid_at, settlement_id. Reconciliation links receipts to settlement ledger entries and produces a reconciliation report.

## Canonical References

- Schema: `packages/db/src/schema/rt2_settlement_governance.ts`, `rt2_personal_pnl.ts`
- Service: `server/src/services/rt2-personal-pnl.ts`
- Routes: `server/src/routes/rt2-personal-pnl.ts`
- Tests: `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts`

## Deferred
- Real payment provider webhook integration (BANK-EXT-01 in Future Requirements)
- Mandatory provider-only eval path for autonomous Jarvis (FUTURE-01)
