# COS v2 기능 문서

각 기능의 목적, 목표, 동작 구조를 정리한 문서입니다.

## 핵심 엔티티

| 기능 | 설명 | 문서 |
|------|------|------|
| Companies (회사) | 최상위 조직 단위, 모든 엔티티의 소속 | [companies.md](companies.md) |
| Agents (에이전트) | AI 에이전트 생성/실행/관리 | [agents.md](agents.md) |
| Issues (이슈) | 에이전트에게 할당되는 작업 단위 | [issues.md](issues.md) |
| Projects (프로젝트) | 이슈 그룹화 + 워크스페이스 연결 | [projects.md](projects.md) |
| Goals (목표) | 계층적 목표 설정 및 추적 | [goals.md](goals.md) |
| Teams (팀) | 에이전트 조직화 + 커스텀 워크플로우 | [teams.md](teams.md) |

## 협업 & 워크플로우

| 기능 | 설명 | 문서 |
|------|------|------|
| Rooms (룸) | 실시간 채팅 + 액션 메시지 | [rooms.md](rooms.md) |
| Approvals (승인) | 중요 액션 승인 워크플로우 | [approvals.md](approvals.md) |
| Routines (루틴) | cron/웹훅 기반 반복 작업 | [routines.md](routines.md) |

## 운영 & 분석

| 기능 | 설명 | 문서 |
|------|------|------|
| Dashboard (대시보드) | 핵심 지표 + 실시간 활동 | [dashboard.md](dashboard.md) |
| Costs & Budgets (비용) | LLM 비용 추적 + 예산 정책 | [costs.md](costs.md) |
| Skills (스킬) | 에이전트 능력 패키지 관리 | [skills.md](skills.md) |

## 템플릿

새 기능 문서 작성 시 [_TEMPLATE.md](_TEMPLATE.md) 참조.
