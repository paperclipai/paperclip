# Dashboard (대시보드)

## 목적
> 회사의 에이전트 상태, 작업 진행, 비용, 승인 대기를 한눈에 파악하고 최근 활동을 실시간으로 추적한다.

## 목표
- 4대 핵심 지표 카드: 활성 에이전트 / 진행 중 작업 / 월간 지출 / 대기 승인
- 14일간 실행 활동, 이슈 우선순위/상태 분포, 성공률 차트
- 최근 활동 로그 + 최근 작업 목록 실시간 갱신
- 예산 인시던트 경고 배너

## 동작 구조

### 데이터 모델
대시보드 전용 테이블 없음 — 여러 엔티티의 집계 데이터를 API에서 합산.

### API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/dashboard/summary` | 에이전트/작업/비용/승인 집계 |
| GET | `/companies/:companyId/activity` | 최근 활동 로그 |

### 비즈니스 로직
- **MetricCard 4종**:
  - Agents Enabled: active + running + paused + error 합산, 상태별 서브카운트
  - Tasks In Progress: 진행 중 이슈 수, open/blocked 서브카운트
  - Month Spend: 월간 비용 (cents), 예산 대비 % 또는 "무제한"
  - Pending Approvals: 일반 + 예산 승인 합산
- **예산 인시던트 배너**: `activeIncidents > 0`일 때 빨간 배너 표시 (일시정지 에이전트/프로젝트/대기 승인 수)
- **에이전트 없음 경고**: 에이전트 0개면 노란 배너 + 온보딩 바로가기
- **활동 애니메이션**: 새 activity 항목에 980ms fade-in 애니메이션
- **차트 4종**: RunActivity(14일 막대), PriorityChart, IssueStatusChart, SuccessRateChart

### UI
- **ActiveAgentsPanel**: 현재 실행 중인 에이전트 실시간 패널
- **MetricCard**: 아이콘 + 값 + 라벨 + 서브설명, 클릭 시 상세 페이지 이동
- **ChartCard**: 제목 + 부제 + 차트 컴포넌트
- **ActivityRow**: 활동 이벤트 렌더링 (에이전트명, 상태 변경, 시간)
- **PluginSlotOutlet**: 플러그인 위젯 삽입 슬롯

## 관련 엔티티
- **Agent**: 상태별 카운트, 실행 현황
- **Issue**: 진행 상태별 카운트, 최근 작업 목록
- **Activity**: 최근 10건 활동 로그
- **Budget**: 월간 비용, 예산 인시던트
- **Approval**: 대기 승인 수

## 파일 경로
| 구분 | 경로 |
|------|------|
| API Client | `ui/src/api/dashboard.ts` |
| Page | `ui/src/pages/Dashboard.tsx` |
| Components | `ui/src/components/MetricCard.tsx` |
| Components | `ui/src/components/ActiveAgentsPanel.tsx` |
| Components | `ui/src/components/ActivityCharts.tsx` |
| Components | `ui/src/components/ActivityRow.tsx` |
