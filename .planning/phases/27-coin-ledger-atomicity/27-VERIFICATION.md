---
phase: 27
phase_name: Coin Ledger Atomicity
status: passed
verified: "2026-04-28"
requirements:
  - LEDGER-01
  - LEDGER-02
  - LEDGER-03
  - LEDGER-04
  - LEDGER-05
closure_phase: 31
---

# Phase 27 Verification: Coin Ledger Atomicity

## Result

Phase 27 is verified as `passed`.

The missing audit artifact has been reconstructed from Phase 27 summaries, UAT, security audit evidence, implementation files, migration files, and focused economy tests. LEDGER-01 through LEDGER-05 are accepted with the evidence below.

## Requirement Coverage

| Requirement | Status | Evidence | Tests |
|-------------|--------|----------|-------|
| `LEDGER-01` | passed | `server/src/services/rt2-personal-pnl.ts` computes `balanceAfter` in ledger INSERT paths through SQL subqueries and serializes same-actor writes with `lockActorLedgerScope()` / `pg_advisory_xact_lock(hashtextextended(...))`. | `27-UAT.md` checks atomic balance write and concurrent serialization; `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` verifies 10 concurrent same-actor writes produce balances 1..10. |
| `LEDGER-02` | passed | `recordIncome()`, `recordExpense()`, and `transferCoins()` wrap P&L updates plus ledger inserts in `db.transaction()`, preventing partial P&L/ledger application. | `27-UAT.md` checks transaction-wrapped income, expense, and transfer behavior. |
| `LEDGER-03` | passed | `reconcileActorPnL()` computes P&L net, ledger sum, diff, and `isReconciled` for actor/period comparison. | `27-UAT.md` checks P&L reconciliation returns diff 0 / reconciled true for matching data. |
| `LEDGER-04` | passed | `packages/db/src/schema/rt2_personal_pnl.ts` defines `leg`; `packages/db/src/migrations/0078_rt2_ledger_atomicity.sql` adds/backfills the column and enforces credit/debit values. | `27-UAT.md` checks earned credit and spent debit behavior; focused economy tests assert `leg: "debit"` for spent rows. |
| `LEDGER-05` | passed | `packages/db/src/schema/rt2_personal_pnl.ts` defines `rt2_coin_ledger_balance_non_neg_check`; migration `0078` adds `balance_after >= 0`. | `27-UAT.md` checks non-negative constraint behavior. |

## Verification Checks

- `packages/db/src/schema/rt2_personal_pnl.ts` contains `leg` and `balanceAfter` schema constraints.
- `packages/db/src/migrations/0078_rt2_ledger_atomicity.sql` contains the ledger atomicity migration.
- `server/src/services/rt2-personal-pnl.ts` contains atomic balance computation, transaction wrappers, actor-scope advisory locks, transfers, and reconciliation.
- `server/src/routes/rt2-personal-pnl.ts` keeps P&L and ledger routes company-scoped and validates positive amounts.
- `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` contains focused embedded Postgres economy coverage.
- `.planning/phases/27-coin-ledger-atomicity/27-UAT.md` records 7/7 passing ledger checks.
- `.planning/phases/27-coin-ledger-atomicity/27-SECURITY.md` records all Phase 27 threats closed or accepted with rationale.

## Command Evidence

- `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true pnpm --filter @paperclipai/server exec vitest run src/__tests__/rt2-phase7-economy-marketplace.test.ts` - passed during Phase 31 with 6 tests.
- `pnpm --filter @paperclipai/server typecheck` - passed.
- `pnpm typecheck` - passed.
- `pnpm test` - passed; full run reported 265 files passed, 23 skipped.

## Residual Risk

Embedded Postgres execution remains host-dependent. Static evidence, UAT evidence, and checked-in focused tests are sufficient for audit closure, but future hosts should keep `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true` for concurrency regression execution.
