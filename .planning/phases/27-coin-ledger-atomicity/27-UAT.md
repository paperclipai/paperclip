---
status: complete
phase: 27-coin-ledger-atomicity
source:
  - .planning/ROADMAP.md
  - .planning/phases/27-coin-ledger-atomicity/27-01-PLAN.md
  - .planning/phases/27-coin-ledger-atomicity/27-02-PLAN.md
  - .planning/phases/27-coin-ledger-atomicity/27-03-PLAN.md
started: 2026-04-28T07:32:44.2903103+09:00
updated: 2026-04-28T08:01:00+09:00
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server/service. Start the application from scratch with embedded PostgreSQL/PGlite dev defaults. Pending migrations apply cleanly, including 0078_rt2_ledger_atomicity.sql, and the API/UI boot without migration or schema errors.
result: pass
evidence: pnpm db:migrate applied 30 pending migrations via embedded-postgres and completed successfully.

### 2. Atomic Balance Write
expected: Creating a coin ledger entry computes balanceAfter inside the INSERT using a SQL subquery. There is no application-level read-then-write balance calculation in the write path.
result: pass
evidence: server/src/services/rt2-personal-pnl.ts uses balanceAfter: sql<number>`(...)` in ledger INSERT paths; pnpm typecheck passed.

### 3. Ledger Leg and Non-Negative Constraint
expected: rt2_coin_ledger has a leg column with only credit/debit values, existing rows are backfilled from amount sign, and balance_after rejects negative values through a database CHECK constraint.
result: pass
evidence: Found and fixed recordExpense leg calculation so the inserted negative ledger amount maps to debit. Added API-level regression coverage for earned credit and spent debit rows; targeted embedded Postgres test passed.

### 4. Transaction-Wrapped Income and Expense
expected: Recording income or expense updates rt2PersonalPnL and inserts the corresponding rt2CoinLedger row in one db.transaction call, so a failure rolls back both changes.
result: pass
evidence: recordIncome and recordExpense each wrap P&L update plus ledger insert in db.transaction; pnpm typecheck passed.

### 5. Atomic Coin Transfer
expected: Transferring coins updates sender P&L, receiver P&L, and the transfer ledger entry in one transaction. The operation cannot leave only one side applied.
result: pass
evidence: transferCoins wraps sender update, receiver update, and ledger insert in db.transaction; targeted embedded Postgres economy tests passed with PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true.

### 6. P&L Reconciliation
expected: reconcileActorPnL compares rt2PersonalPnL against rt2CoinLedger for an actor/period and returns diff 0 with isReconciled true when the ledger and aggregate P&L match.
result: pass
evidence: reconcileActorPnL exists and computes pnlNet, ledgerSum, diff, and isReconciled; pnpm typecheck passed.

### 7. Concurrent Ledger Write Serialization
expected: Concurrent writes to the same actor ledger balance scope serialize before `balanceAfter` is computed, producing monotonic non-duplicated balances.
result: pass
evidence: Added `pg_advisory_xact_lock(hashtextextended(...))` before ledger inserts and added an embedded Postgres regression test that performs 10 concurrent same-actor writes and verifies balanceAfter values [1..10]. Targeted test passed.

## Summary

total: 7
passed: 7
issues: 0
pending: 0
skipped: 0

## Gaps

[none; the security gap T-27-02 was fixed and re-verified]
