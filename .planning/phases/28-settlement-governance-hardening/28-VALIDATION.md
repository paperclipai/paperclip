---
phase: 28
phase_name: Settlement Governance Hardening
status: passed
validated: "2026-04-28"
requirements:
  - SETTLE-01
  - SETTLE-02
  - SETTLE-03
  - SETTLE-04
closure_phase: 31
---

# Phase 28 Validation: Settlement Governance Hardening

## Validation Architecture

Phase 28 is validated with schema/migration inspection, service and route evidence, frontend/API evidence, and focused economy tests. The validation focuses on governance integrity and the economic feedback path from approval to ledger evidence.

## Scenarios

| Scenario | Requirements | Evidence | Result |
|----------|--------------|----------|--------|
| Duplicate settlement materialization guard | SETTLE-01 | Unique `(company_id, work_product_id)` governance constraint plus conflict-safe `ensureSettlementRows()` behavior. | accepted |
| Signal visibility without automatic punishment | SETTLE-02 | Existing three signal types remain decision support and render with evidence/severity in the settlement UI. | accepted |
| Approval creates linked ledger evidence | SETTLE-03 | Approved settlements store `ledgerEntryId`, expose ledger amount/type/period/`balanceAfter`, and display it inline. | accepted |
| Rejection does not create ledger entry | SETTLE-03 | Rejected settlements stay governance-only and do not materialize ledger evidence. | accepted |
| Company threshold persistence | SETTLE-04 | `rt2SettlementThresholds` persists company settings and routes/UI read and update them. | accepted |
| Threshold-backed signal regeneration | SETTLE-02, SETTLE-04 | Signal detection reads persisted threshold settings when settlement rows are refreshed. | accepted |

## Commands

- `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true pnpm --filter @paperclipai/server exec vitest run src/__tests__/rt2-phase7-economy-marketplace.test.ts` - passed after Phase 31 fixed settlement approval ledger evidence.
- `pnpm --filter @paperclipai/server test -- rt2-v23-route-fallback.test.ts` - passed.
- `pnpm typecheck` - passed.
- `pnpm test` - passed; full run reported 265 files passed, 23 skipped.

## Acceptance

SETTLE-01 through SETTLE-04 are accepted for milestone audit closure.

## Residual Risk

Approval and threshold behavior should continue to be covered by embedded Postgres tests in CI. Automatic penalties, demotion, payroll export, and fraud case workflow are intentionally out of scope.
