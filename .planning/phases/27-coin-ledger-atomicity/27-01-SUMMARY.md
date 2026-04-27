---
phase: 27-coin-ledger-atomicity
plan: 01
subsystem: coin-ledger-schema-and-balance-write
tags:
  - ledger
  - migration
  - atomicity
key-files:
  - packages/db/src/schema/rt2_personal_pnl.ts
  - packages/db/src/migrations/0078_rt2_ledger_atomicity.sql
  - server/src/services/rt2-personal-pnl.ts
metrics:
  tests: verified by 27-UAT.md
---

# Plan 27-01 Summary

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Schema + migration | uncommitted workspace | Added `leg` to `rt2CoinLedger`, added `leg` and `balance_after >= 0` constraints, and backfilled legacy rows by amount sign. |
| Atomic balance write | uncommitted workspace | Replaced application-level balance read/write with INSERT-time SQL subquery for `balanceAfter`. |

## Deviations

The original expected summary artifact was missing after execution. This summary was reconstructed from implementation files and `27-UAT.md`.

## Self-Check

PASSED. `27-UAT.md` records passing evidence for schema/migration, atomic SQL balance computation, and the leg/non-negative constraint behavior.
