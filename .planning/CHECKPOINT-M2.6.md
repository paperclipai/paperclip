# M2.6 협업 보상 - 체크포인트

## 완료 상태
- M2.5 지식 고도화 ✅ 완료
- M2.6 협업 보상 ✅ 완료 (2026-04-23)

## 구현 완료 내용

### DB 스키마
- `packages/db/src/schema/rt2_collaboration_rewards.ts`
- `rt2CollaborationRewards` 테이블: 명성 지수, 멀티플라이어, AI 기여도 점수 추적
- `rt2CollaborationEvents` 테이블: 개별 협업 이벤트 기록

### 협업 보상 서비스
- `server/src/services/rt2-collaboration-rewards.ts`
- `getOrCreateReward()` - 유저/에이전트 보상 기록 조회/생성
- `getCompanyRewards()` - 회사 전체 보상 조회
- `getRewardsLeaderboard()` - 명성 지수 리더보드
- `recordCollaborationEvent()` - 협업 이벤트 기록
- `confirmCollaboration()` - 협업 성공/실패 확인 및 명성 지수 업데이트
- `updateAiContributionScore()` - AI 기여도 점수 업데이트
- `getActorCollaborationHistory()` - 협업 히스토리 조회
- `getReputationStats()` - 명성 통계 (평균 명성, 상위 멀티플라이어 등)

### API Routes
- `server/src/routes/rt2-collaboration-rewards.ts`
- `GET /rt2/collaboration/leaderboard` - 리더보드
- `GET /rt2/collaboration/rewards` - 전체 보상
- `GET /rt2/collaboration/stats` - 명성 통계
- `POST /rt2/collaboration/events` - 협업 이벤트 기록
- `POST /rt2/collaboration/events/:eventId/confirm` - 협업 확인
- `POST /rt2/collaboration/ai-contribution` - AI 기여도 업데이트
- `GET /rt2/collaboration/history/:actorId` - 히스토리 조회

### 멀티플라이어 테이블
| 명성 지수 | 멀티플라이어 |
|---------|------------|
| 900+    | 1.5x       |
| 700+    | 1.3x       |
| 500+    | 1.1x       |
| 300+    | 0.9x       |
| <300    | 0.7x       |

### AI 기여도 점수
| 활동 | 점수 |
|-----|------|
| completed | +10 |
| helped | +5 |
| reviewed | +3 |

## 완료일: 2026-04-23
