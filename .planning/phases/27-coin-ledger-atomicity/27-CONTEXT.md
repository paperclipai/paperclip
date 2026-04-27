# Phase 27: Coin Ledger Atomicity - Context

**Gathered:** 2026-04-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 27는 rt2CoinLedger 테이블의 잔액 연산 원자성을 보장한다. read-then-write 레이스 컨디션 제거, income/expense paired operation의 트랜잭션화, `leg` column 추가, `balance_after >= 0` check constraint, cross-table P&L 정합성 검증 기능 구현이 포함된다.

</domain>

<decisions>
## Implementation Decisions

### Atomic balanceAfter Computation (LEDGER-01)
- **D-01:** `balanceAfter`는 INSERT 시 SQL subquery로 원자적 계산한다 — application-level read-then-write 제거.
- **D-02:** 계산식: `COALESCE((SELECT SUM(amount) FROM rt2_coin_ledger WHERE company_id = $1 AND to_actor_id = $2 AND to_actor_type = $3), 0) + $4`를 INSERT VALUES에서 직접 사용.
- **D-03:** `getActorBalance()` 함수는 조회용으로 유지하되, ledger entry 생성 시에는 항상 원자적 SQL subquery를 사용한다.

### Paired Operation Transaction (LEDGER-02)
- **D-04:** `recordIncome`과 `recordExpense`의 P&L 업데이트 + ledger entry 삽입을 `db.transaction([...])`으로 묶는다.
- **D-05:** 트랜잭션 내부에서 P&L 업데이트가 먼저 실행되고, 실패 시 전체 롤백. ledger entry 삽입도 동일한 트랜잭션 내에서 atomic하게 처리.
- **D-06:** `transferCoins`도 동일한 트랜잭션 패턴 적용 — fromActor expense와 toActor income이 하나의 원자적 단위로 처리.

### leg Column (LEDGER-04)
- **D-07:** `rt2CoinLedger` 테이블에 `leg` column ('debit'/'credit') 추가.
- **D-08:** 마이그레이션: `ALTER TABLE rt2_coin_ledger ADD COLUMN leg TEXT NOT NULL DEFAULT 'credit' CHECK (leg IN ('debit', 'credit'))`.
- **D-09:** income/earned/reward transaction: `leg = 'credit'` (잔액 증가)
- **D-10:** expense/spent/penalty transaction: `leg = 'debit'` (잔액 감소)
- **D-11:** 기존 레거시 데이터는 마이그레이션 시 `leg = 'credit'`으로 기본값 설정.

### Non-negativity Check Constraint (LEDGER-05)
- **D-12:** `balance_after >= 0` check constraint 추가.
- **D-13:** 마이그레이션: `ALTER TABLE rt2_coin_ledger ADD CHECK (balance_after >= 0)`.
- **D-14:** constraint 위배 시 Postgres에서 에러 발생 → application에서 appropriate error handling 필요.

### Cross-table P&L Reconciliation (LEDGER-03)
- **D-15:** reconciliation 쿼리: `rt2CoinLedger`의 SUM(amount) per actor/period vs `rt2PersonalPnL`의 income - expenses 비교.
- **D-16:** reconciliation 결과 불일치 시 경고 로그 + SettlementGovernance signal로 표시.
- **D-17:** reconciliation은 settlement overview 호출 시마다 실행 (on-demand).

### Agent Discretion
- migration 파일 작성 시 constraint naming convention (e.g., `rt2_coin_ledger_balance_check`)
- reconciliation 불일치 시 구체적 diff 표시 방식 (어떤 레코드에서 불일치가 나는지)
- existing ledger entry에 leg column backfill 시 precision 기준 (amount > 0 → credit, amount < 0 → debit)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Context
- `.planning/PROJECT.md` — RT2-first identity, economy principles.
- `.planning/REQUIREMENTS.md` — LEDGER-01 ~ LEDGER-05 requirements.
- `.planning/ROADMAP.md` — Phase 27 goal and success criteria.

### Existing Code
- `packages/db/src/schema/rt2_personal_pnl.ts` — rt2CoinLedger and rt2PersonalPnL table schemas.
- `server/src/services/rt2-personal-pnl.ts` — existing recordIncome, recordExpense, recordCoinTransaction, getActorBalance, transferCoins functions with the race condition.
- `packages/db/src/schema/index.ts` — schema exports.

### Database
- `packages/db/src/migrations/` — existing migration files for reference on constraint naming and ALTER TABLE patterns.

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `rt2PersonalPnLService.recordCoinTransaction()` — existing ledger entry creation (수정 필요)
- `rt2PersonalPnLService.recordIncome()` / `recordExpense()` — existing P&L operations (트랜잭션화 필요)
- `rt2PersonalPnLService.getActorBalance()` — balance query (조회용으로 유지)
- `rt2PersonalPnLService.transferCoins()` — paired operation (트랜잭션화 필요)
- Drizzle ORM의 `db.transaction()` API — 다른 서비스에서 이미 사용 중

### Established Patterns
- Company-scoped operations use `assertCompanyAccess`
- Transaction rollback pattern: `db.transaction(async (tx) => { ... })` with drizzle
- Idempotency: existing ledger entries identified by (referenceId, referenceType) for approved_deliverable

### Integration Points
- Phase 28 (Settlement Governance Hardening) depends on ledger integrity — Phase 27이 완료된后才能 진행
- Settlement approval이 `recordIncome` 호출 → 이 호출이 atomic transaction으로 wrapping되어야 함
- Existing ledger entries used in anti-gaming signal detection (abnormal_gold_farming check)

</codebase_context>

<specifics>
## Specific Ideas

- balanceAfter SQL subquery 예시:
  ```sql
  INSERT INTO rt2_coin_ledger (..., balance_after)
  VALUES (..., (
    SELECT COALESCE(SUM(amount), 0) + $new_amount
    FROM rt2_coin_ledger
    WHERE company_id = $company_id AND to_actor_id = $actor_id AND to_actor_type = $actor_type
  ))
  ```
- leg column backfill query: `UPDATE rt2_coin_ledger SET leg = CASE WHEN amount >= 0 THEN 'credit' ELSE 'debit' END WHERE leg IS NULL`
- Reconciliation query structure:
  ```sql
  SELECT
    pnl.actor_id, pnl.actor_type, pnl.period,
    pnl.income - pnl.expenses AS pnl_net,
    COALESCE(SUM(l.amount), 0) AS ledger_sum,
    (pnl.income - pnl.expenses) - COALESCE(SUM(l.amount), 0) AS diff
  FROM rt2_personal_pnl pnl
  LEFT JOIN rt2_coin_ledger l ON ...
  GROUP BY pnl.actor_id, pnl.actor_type, pnl.period
  HAVING (pnl.income - pnl.expenses) != COALESCE(SUM(l.amount), 0)
  ```

</specifics>

<deferred>
## Deferred Ideas

- None — Phase 27는 ledger atomicity에 집중

---

*Phase: 27-coin-ledger-atomicity*
*Context gathered: 2026-04-27*
