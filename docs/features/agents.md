# Agents (에이전트)

## 목적
> AI 에이전트를 생성/관리하고, 어댑터를 통해 다양한 LLM 백엔드에서 작업을 실행하며, 하트비트 기반으로 자율 운영한다.

## 목표
- 다양한 어댑터(Claude, Codex, Gemini, Cursor 등)를 통한 AI 에이전트 실행
- 하트비트 기반 자율 실행 + 온디맨드 웨이크업
- 조직도(reportsTo 계층) 기반 매니저-리포트 구조
- 설정 이력 관리 + 롤백, API 키 관리, 예산 제어

## 동작 구조

### 데이터 모델
```
agents
├── id, companyId (FK → companies)
├── name, role, title, icon
├── status (idle | active | running | paused | error | pending_approval | terminated)
├── reportsTo (FK → agents.id, 자기참조 — 조직 계층)
├── adapterType (claude_local | codex_local | gemini_local | cursor | ...)
├── adapterConfig (jsonb — 모델, 온도, 명령어 경로 등)
├── runtimeConfig (jsonb — 하트비트 설정, 커스텀 상태)
├── budgetMonthlyCents, spentMonthlyCents
├── permissions, capabilities
├── lastHeartbeatAt, metadata
└── createdAt, updatedAt

agent_sessions — Phase 4 CLI 세션 (에이전트당 1개 active)
agent_runtime_state — 실행 상태 (토큰, 비용, 마지막 실행)
agent_config_revisions — 설정 변경 이력 (before/after 스냅샷)
agent_api_keys — 인증 토큰 (해시 저장)
agent_wakeup_requests — 비동기 웨이크업 큐
agent_task_sessions — 어댑터별 작업 세션 상태
```

### API (40+ 엔드포인트)
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/companies/:companyId/agents` | 에이전트 목록 |
| POST | `/companies/:companyId/agents` | 에이전트 생성 |
| GET/PATCH/DELETE | `/agents/:id` | 조회/수정/삭제 |
| POST | `/agents/:id/pause` | 일시정지 (사유 포함) |
| POST | `/agents/:id/resume` | 재개 |
| POST | `/agents/:id/terminate` | 종료 (소프트 삭제) |
| POST | `/agents/:id/wakeup` | 비동기 웨이크업 요청 |
| POST | `/agents/:id/heartbeat/invoke` | 즉시 실행 트리거 |
| GET | `/agents/:id/config-revisions` | 설정 이력 |
| POST | `/agents/:id/config-revisions/:revisionId/rollback` | 이전 설정으로 롤백 |
| GET/POST/DELETE | `/agents/:id/keys` | API 키 관리 |
| GET | `/companies/:companyId/org` | 조직도 (JSON/SVG/PNG) |

### 비즈니스 로직
- **하트비트 시스템**: `heartbeat_runs` 테이블에서 실행 추적 (queued → running → finished), 토큰/비용/로그 캡처
- **어댑터 시스템**: adapterType별 설정 스키마, 환경 테스트(`testEnvironment`), 모델 디스커버리
- **상태 라이프사이클**: idle → active/running → paused(수동/예산/시스템) → terminated
- **설정 버전관리**: 모든 config 변경 시 `agent_config_revisions`에 before/after 기록, 롤백 지원
- **조직 계층**: `reportsTo` 자기참조로 매니저 체인 구성 (최대 50레벨), 순환 참조 방지
- **웨이크업 큐**: `agent_wakeup_requests`로 비동기 실행 요청, 멱등성 키 지원

### UI
- **Agents 페이지**: 목록 + 조직도 토글, 상태별 필터(all/active/paused/error/terminated)
- **AgentDetail**: 탭 — Overview, Config, Instructions, Activity, Heartbeats, Keys, Approvals
- **AgentConfigForm**: 이름/역할/어댑터/런타임 설정/예산 편집
- **조직도**: SVG/PNG 내보내기 지원

## 관련 엔티티
- **Issue**: 에이전트가 이슈에 할당/체크아웃/실행
- **Team**: `team_members`로 팀 소속
- **Room**: `room_participants`로 채팅방 참여
- **Goal**: `goals.ownerAgentId`로 목표 소유
- **Routine**: 루틴의 `assigneeAgentId`로 반복 작업 실행
- **Cost**: `cost_events.agentId`로 비용 추적
- **Approval**: 채용/작업 승인 워크플로우

## 파일 경로
| 구분 | 경로 |
|------|------|
| Schema | `packages/db/src/schema/agents.ts` + `agent_*.ts` (7개 파일) |
| Service | `server/src/services/agents.ts` |
| Route | `server/src/routes/agents.ts` (2483줄, 40+ 엔드포인트) |
| Page | `ui/src/pages/Agents.tsx`, `ui/src/pages/AgentDetail.tsx` |
| Components | `ui/src/components/Agent*.tsx` (Config, Action, Icon, Properties) |
