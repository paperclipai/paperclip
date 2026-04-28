# Phase 27: Coin Ledger Atomicity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-27
**Phase:** 27-coin-ledger-atomicity
**Areas discussed:** Atomic balanceAfter, Paired transaction, leg column, Check constraint, Reconciliation

---

## Atomic balanceAfter Computation (LEDGER-01)

| Option | Description | Selected |
|--------|-------------|----------|
| SQL subquery in INSERT | `COALESCE((SELECT SUM(amount) FROM rt2_coin_ledger WHERE ...), 0) + amount` in INSERT VALUES | ✓ |
| Application-level locking | SELECT FOR UPDATE, then INSERT | |
|乐观锁 with version column | Add version column, use optimistic concurrency | |

**User's choice:** SQL subquery in INSERT (recommended default)
**Notes:** [auto] Balance computed atomically at DB level — no read-then-write race condition.

## Paired Operation Transaction (LEDGER-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Wrap in db.transaction() | recordIncome/recordExpense + ledger insert in single transaction | ✓ |
| Two-phase commit | Prepare, then commit with coordinator | |
| Saga pattern with compensation | Eventual consistency via compensating transactions | |

**User's choice:** Wrap in db.transaction() (recommended default)
**Notes:** [auto] P&L update + ledger entry as atomic unit — rollback on any failure.

## leg Column (LEDGER-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Add leg column with backfill | ALTER TABLE + backfill legacy rows | ✓ |
| New ledger_v2 table | Create new table with leg column, migrate data | |
| Virtual column / computed | Postgres generated column | |

**User's choice:** Add leg column with backfill (recommended default)
**Notes:** [auto] Simple migration, backfill: amount >= 0 → 'credit', amount < 0 → 'debit'.

## Non-negativity Check Constraint (LEDGER-05)

| Option | Description | Selected |
|--------|-------------|----------|
| Postgres CHECK constraint | `ALTER TABLE ADD CHECK (balance_after >= 0)` | ✓ |
| Trigger-based enforcement | Before insert/update trigger | |
| Application-level guard | Check in application code before insert | |

**User's choice:** Postgres CHECK constraint (recommended default)
**Notes:** [auto] DB-level enforcement — any violation rejected at database level.

## Cross-table P&L Reconciliation (LEDGER-03)

| Option | Description | Selected |
|--------|-------------|----------|
| On-demand reconciliation | Run comparison on settlement overview call | ✓ |
| Scheduled batch reconciliation | Nightly cron job | |
| Event-driven reconciliation | After each P&L write | |

**User's choice:** On-demand reconciliation (recommended default)
**Notes:** [auto] Compare rt2PersonalPnL net vs rt2CoinLedger SUM on settlement overview.

## Deferred Ideas

- None

---
