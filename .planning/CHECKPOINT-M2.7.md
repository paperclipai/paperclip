# M2.7 아메바 경영 - 체크포인트

## 완료 상태
- M2.6 협업 보상 ✅ 완료
- M2.7 아메바 경영 ✅ 완료 (2026-04-23)

## 구현 완료 내용

### DB 스키마
- `packages/db/src/schema/rt2_personal_pnl.ts`
- `rt2PersonalPnL` 테이블: 에이전트/유저별 손익 계산
- `rt2CoinLedger` 테이블: 게임 화폐 트랜잭션 원장

### P&L 서비스
- `server/src/services/rt2-personal-pnl.ts`
- `getOrCreatePnL()` - P&L 기록 조회/생성
- `recordIncome()` - 수입 기록
- `recordExpense()` - 지출 기록
- `getActorBalance()` - 코인 잔액 조회
- `getCompanyPnLReport()` - 회사 전체 P&L 리포트
- `getActorPnLHistory()` - 에이전트 P&L 히스토리
- `getActorCoinHistory()` - 코인 거래 내역
- `transferCoins()` - 코인 이전
- `allocateBudget()` - 예산 배분
- `getCompanyPnLSummary()` - P&L 요약

### API Routes
- `server/src/routes/rt2-personal-pnl.ts`
- `GET /rt2/pnl` - P&L 리포트
- `GET /rt2/pnl/summary` - P&L 요약
- `GET /rt2/pnl/actor/:actorId` - 에이전트 P&L 히스토리
- `GET /rt2/coins/balance/:actorId` - 코인 잔액
- `GET /rt2/coins/history/:actorId` - 코인 거래 내역
- `POST /rt2/pnl/income` - 수입 기록
- `POST /rt2/pnl/expense` - 지출 기록
- `POST /rt2/coins/transfer` - 코인 이전
- `POST /rt2/pnl/budget` - 예산 배분

## 완료일: 2026-04-23
