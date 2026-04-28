---
phase: 27
slug: 27-coin-ledger-atomicity
status: verified
threats_open: 0
asvs_level: 1
created: 2026-04-28
updated: 2026-04-28
---

# Phase 27 — Security

Per-phase security contract: threat register, accepted risks, and audit trail.

## Input State

State C: `27-01-PLAN.md`, `27-02-PLAN.md`, `27-03-PLAN.md`, matching SUMMARY artifacts, and `27-UAT.md` exist. Threat verification was performed from PLAN threat models, actual implementation files, migration files, targeted tests, and UAT evidence.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| API -> DB | P&L and ledger mutations cross from Express route input into Drizzle/PostgreSQL writes. | companyId, actorId, actorType, amount, reference metadata |

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-27-01 | Tampering | recordCoinTransaction | mitigate | `balanceAfter` is computed in the ledger INSERT via SQL subquery rather than an application-level pre-read. Evidence: `server/src/services/rt2-personal-pnl.ts` uses `balanceAfter: sql<number>` in ledger insert paths. | closed |
| T-27-02 | Denial | Concurrent ledger writes | mitigate | Closed by transaction-scoped PostgreSQL advisory locks keyed by companyId + actorType + actorId before every ledger insert that computes `balanceAfter`. Evidence: `lockActorLedgerScope()` uses `pg_advisory_xact_lock(hashtextextended(...))`, and the targeted embedded Postgres test verifies 10 concurrent same-actor writes produce `balanceAfter` values [1..10]. | closed |
| T-27-03 | Information | leg/backfill exposes existing data patterns | accept | The `leg` backfill exposes only transaction direction derived from existing amount sign. No PII or new private attribute is introduced. | closed |
| T-27-04 | Tampering | transferCoins partial failure | mitigate | `transferCoins` wraps sender P&L update, receiver P&L update, and transfer ledger insert in one `db.transaction`. | closed |
| T-27-05 | Information | reconcileActorPnL exposes P&L mismatch | accept | Reconciliation mismatch is operational audit information for authorized company P&L users, not sensitive personal data by itself. | closed |
| T-27-06 | Denial | reconciliation query performance | accept | Reconciliation is exposed as service logic and not run on every write path; existing query is scoped by company, actor, actor type, and period. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-27-01 | T-27-03 | `leg` is derived from existing signed amount and does not expose a new sensitive field. | Codex security audit | 2026-04-28 |
| AR-27-02 | T-27-05 | P&L mismatch evidence is business audit data and remains behind company-scoped access checks. | Codex security audit | 2026-04-28 |
| AR-27-03 | T-27-06 | Reconciliation is bounded and not on the hot write path; no immediate performance mitigation is required for Phase 27. | Codex security audit | 2026-04-28 |

## Open Threats

None.

## Audit Evidence

| Evidence | Result |
|----------|--------|
| `packages/db/src/schema/rt2_personal_pnl.ts` | `leg` column and CHECK constraints exist. |
| `packages/db/src/migrations/0078_rt2_ledger_atomicity.sql` | `leg` column, `leg` CHECK, `balance_after >= 0` CHECK, and backfill exist. |
| `server/src/services/rt2-personal-pnl.ts` | `recordIncome`, `recordExpense`, and `transferCoins` use `db.transaction`. Ledger inserts use SQL subqueries for `balanceAfter` and acquire per-actor advisory transaction locks first. |
| `server/src/routes/rt2-personal-pnl.ts` | P&L/ledger routes enforce company access and positive amounts. |
| `server/src/__tests__/rt2-phase7-economy-marketplace.test.ts` | Concurrent same-actor ledger write regression test passes. |
| `27-UAT.md` | UAT complete; ledger leg issue and T-27-02 security gap were fixed and re-verified. |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-04-28 | 6 | 6 | 0 | Codex security audit |

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-04-28
