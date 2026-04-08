# COS v2 — 전체 컨텍스트

> 이 문서는 설계 세션(2026-04-07~08)의 모든 결정사항을 담는다.
> 새 세션에서 작업 시 이 문서를 먼저 읽어야 한다.

## 프로젝트 개요

**COS v2 = Paperclip fork + 팀 구조(Linear 대체) + 미션 룸(실시간 채팅)**

BBrightCode의 AI 에이전트 회사 운영 시스템. COS v1(Slack 기반)의 한계를 해결하기 위해 Paperclip(오픈소스 에이전트 오케스트레이션)을 fork하고 확장.

## 핵심 결정사항 (절대 잊지 말 것)

### 1. Paperclip 기존 코드/UI에 추가하는 방식

- Paperclip 기존 UI, API, DB 스키마를 **재구현하지 않는다**
- 기존 사이드바에 Teams 메뉴를 **삽입한다** — 새 사이드바를 만들지 않는다
- 기존 Issues 페이지에 team 필터를 **추가한다** — 새 이슈 페이지를 만들지 않는다
- 기존 Agent Detail에 리더/서브 구분을 **추가한다**

### 2. issues.status는 text 유지

- FK 전환하지 않는다 (Paperclip 코어 수정 최소화)
- `team_workflow_statuses` 테이블이 팀별 허용 상태를 정의
- API 레벨에서 유효값 검증
- status에 저장되는 값 = **slug** (immutable, rename-safe)
- category 기반 전이: started → startedAt, completed → completedAt

### 3. 워크플로우 상태에 immutable slug

- 각 상태에 slug(불변) + name(변경 가능)
- issues.status에 slug 저장
- rename 시 기존 이슈 안 깨짐 (Codex #10 반영)

### 4. DB는 Embedded PostgreSQL 그대로

- Neon 불필요 (나중에 전환 가능, DATABASE_URL만 설정하면 됨)
- 백업 자동 (60분마다, 30일 보관)

### 5. 실행 모델: 상시 실행 + 유휴 리셋

- Paperclip 기본은 1회 실행(heartbeat). COS v2는 상시 실행
- CLI 상시 대기 → 룸 메시지 수신 → 즉시 반응
- 작업 완료 시 컨텍스트 요약을 md로 저장
- 유휴 시간 감지 → graceful restart (컨텍스트 초기화)
- 재시작 후 저장된 md 참조 가능
- PM2 + Paperclip 어댑터 혼합 (Phase 3에서 구현)

### 6. 에이전트 계층: 리더 + 서브에이전트

- **리더 에이전트**: CLI 보유, adapterType=claude_local, 미션 룸 참여, 팀 lead
- **서브 에이전트**: CLI 없음, adapterType=none, 리더가 Agent tool로 spawn
- 서브에이전트 스킬은 DB에 등록, 리더 instructions에 자동 주입
- superpowers:subagent-driven-development 패턴과 동일 구조

### 7. 프로젝트는 멀티팀 (project_teams N:M)

- projects.team_id 단일 FK 아님
- project_teams 조인 테이블로 N:M

### 8. Slack 범위 제외, Triage 범위 제외, Board 뷰 생략

### 9. 라이선스: MIT (fork/수정/상업적 사용 자유)

### 10. company-os(v1)는 현행 유지, company-os-v2는 별도 repo

## Codex 리뷰 핵심 이슈 (미해결 주의사항)

Codex 비판적 리뷰(25개 이슈) 중 대응 완료되지 않은 주의사항:

| # | 이슈 | 상태 |
|---|------|------|
| 3 | PM2 예시가 잘못됨 — `claude --print`는 1회 실행, wrapper 프로세스 미정의 | Phase 3에서 해결 |
| 4 | 세션 소유권 미정의 (PM2/wrapper/Paperclip 중 누가 관리) | Phase 3에서 해결 |
| 6 | 업스트림 충돌 위험 — Paperclip TASKS.md가 teams/workflow 자체 구현 예정 | 우리가 먼저 구현하는 전략. 충돌 시 수동 머지 |
| 11 | 액션 메시지 실행이 unsafe — 중복/우발 실행 가능 | ✅ `5628eb0f` — FOR UPDATE 락 + true idempotency |
| 12 | 액션 모델 미완성 (idempotency, ACL 등) | ✅ `5628eb0f` — result/error/executedAt/executedBy 컬럼 + idempotency |
| 14 | Source of truth 분산 (룸 채팅 vs 이슈 코멘트 vs md) | 규칙 정의 필요 |
| 15 | 룸 운영 설계 미흡 (unread, presence, reconnect 등) | Phase 3에서 해결 |
| 17 | 팀별 atomic counter + 식별자 마이그레이션 | Unit 1e에서 해결 |
| 18 | lead_agent_id vs team_members.role=lead 이중 source of truth | Unit 1b에서 동기화 로직 구현 |
| 25 | v1↔v2 공존 계획 미흡 | 다른 포트 사용으로 우선 회피 |

## 현재 Paperclip 상태 (실동작 확인)

- **서버**: port 3100 (또는 3101), embedded PG
- **UI 페이지**: Dashboard, Inbox, Issues, Routines(Beta), Goals, Projects, Agents, OrgChart, Approvals, Settings, CompanySkills, Costs, Activity, PluginManager
- **에이전트**: 4명 있었음 (Bright/Axel/Luna/Mina) — 테스트 데이터, 삭제 예정
- **이슈**: 7개 있었음 (BBR-1~7) — 테스트 데이터, 삭제 예정
- **Heartbeat**: 30초 간격으로 실제 동작 확인됨
- **인증**: better-auth, local_trusted 모드 (인증 없이 접근)

## Paperclip 기존 기능 — 변경 없이 활용

에이전트 CRUD, 이슈 CRUD+코멘트+첨부+문서, 승인 큐(UI 포함), 비용 추적(UI 포함), Routines(cron), Documents, Secrets, Activity Log, Inbox, OrgChart, Import/Export, Skills, Agent Instructions, Plugin 시스템, SSE Live Events

## Phase 1 — 서브 유닛 (9개)

```
1a (Fork + 클린 환경)                   ← 현재 위치 (repo 생성 완료)
  └→ 1b (팀 스키마 + API)
       ├→ 1c (팀 UI — 기존 사이드바에 삽입)
       ├→ 1d (워크플로우 상태 + slug)
       │    └→ 1e (이슈 팀 귀속 + 식별자 ENG-42)
       │         ├→ 1f (Labels 확장)
       │         ├→ 1g (Issue Relations 확장)
       │         └→ 1h (Estimates)
       └→ 1i (에이전트 시드 + 팀 배치 + 서브에이전트)
```

## Phase 전체 (5단계)

| Phase | 내용 | 의존 |
|-------|------|------|
| 1 | 팀 + 이슈 + 인증 (Linear 핵심) | 기반 |
| 2 | 프로젝트 확장 (milestones, health, multi-team) | Phase 1 |
| 3 | 미션 룸 + CLI 연결 (WebSocket, PM2, 액션 메시지) | Phase 2 |
| 4 | Cycles + 자동화 + 승인 (GitHub PR, auto-close) | Phase 3 |
| 5 | Views + Initiatives + 채용 에이전트 + 측정 | Phase 4 |

## 파일 맵

| 파일 | 내용 |
|------|------|
| `docs/cos-v2/CONTEXT.md` | **이 파일** — 전체 컨텍스트 |
| `docs/cos-v2/design-spec.md` | COS v2 전체 설계 스펙 |
| `docs/cos-v2/paperclip-analysis.md` | Paperclip 완벽 분석 (60+ 테이블, 서버/UI/CLI) |
| `docs/cos-v2/phase1-breakdown.md` | Phase 1 서브 유닛 분해 (9개, QA 기준 포함) |
| `docs/cos-v2/unit-1a-plan.md` | Unit 1a 상세 구현 계획 |
| `docs/cos-v2/builder-skill.md` | /cos-v2 빌더 스킬 (연속 실행 커맨드) |
| `docs/cos-v2/progress.md` | 진행 상태 (Unit 1a 완료 후 생성) |

## 빌더 커맨드

company-os repo에서:
```
/cos-v2
```
실행하면: 상태 파악 → 다음 유닛 진행 → Codex 리뷰 → 반복.

## 다음 할 일

1. **Unit 1a 실행**: 기존 데이터 삭제 → pnpm install → pnpm build → pnpm dev → onboard
2. **QA**: 서버 동작, 클린 상태, 테스트 통과 확인
3. **Unit 1b 계획 작성**: teams + team_members 테이블 + API
4. 계속 `/cos-v2` 반복
