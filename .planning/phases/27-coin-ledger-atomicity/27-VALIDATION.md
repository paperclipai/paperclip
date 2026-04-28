---
phase: 27
phase_name: Coin Ledger Atomicity
status: passed
validated: "2026-04-28"
requirements:
  - LEDGER-01
  - LEDGER-02
  - LEDGER-03
  - LEDGER-04
  - LEDGER-05
closure_phase: 31
---

# Phase 27 Validation: Coin Ledger Atomicity

## Validation Architecture

Phase 27 is validated with schema/migration inspection, service-level implementation evidence, security audit closure, UAT scenarios, and embedded Postgres economy tests. The concurrency behavior depends on PostgreSQL advisory locks and should be run on hosts where embedded Postgres is enabled.

## Scenarios

| Scenario | Requirements | Evidence | Result |
|----------|--------------|----------|--------|
| Insert-time balance computation | LEDGER-01 | Ledger insert paths use SQL subqueries for `balanceAfter` instead of a pre-read. | accepted |
| Concurrent same-actor serialization | LEDGER-01 | `lockActorLedgerScope()` uses transaction-scoped advisory locks; focused test expects monotonic 1..10 balances. | accepted |
| Income/expense rollback boundary | LEDGER-02 | Income and expense update P&L and ledger rows inside `db.transaction()`. | accepted |
| Transfer atomicity | LEDGER-02 | `transferCoins()` updates sender P&L, receiver P&L, and transfer ledger entry in one transaction. | accepted |
| P&L reconciliation | LEDGER-03 | `reconcileActorPnL()` compares `rt2PersonalPnL` net against `rt2CoinLedger` sum. | accepted |
| Ledger leg classification | LEDGER-04 | Credit/debit leg values are persisted and constrained by schema/migration. | accepted |
| Non-negative balance constraint | LEDGER-05 | `balance_after >= 0` schema and migration checks reject negative balances. | accepted |

## Commands

- `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true pnpm --filter @paperclipai/server exec vitest run src/__tests__/rt2-phase7-economy-marketplace.test.ts` - passed during Phase 31 with 6 tests.
- `pnpm --filter @paperclipai/server typecheck` - passed.
- `pnpm typecheck` - passed.
- `pnpm test` - passed; full run reported 265 files passed, 23 skipped.

## Acceptance

LEDGER-01 through LEDGER-05 are accepted for milestone audit closure.

## Residual Risk

The embedded Postgres concurrency test is the strongest runtime proof and remains host-gated. Keep it enabled in CI or audit reruns where PostgreSQL is available.
