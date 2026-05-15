# Paperclip UI 한글화 — 텍스트 인벤토리

> **생성:** 2026-05-16, Phase 1 완료
> **대상:** `/home/hakkocap/paperclip/ui/src/`

---

## 전체 현황

| 디렉토리 | 파일 수 | 예상 번역 대상 | 비고 |
|----------|--------|---------------|------|
| `pages/` | 57개 | 30개 (고 string count) | Core 페이지 |
| `components/` | 175개 | 45개 | 공통 UI |
| `context/` | 10개 | 0개 | 대부분 로직 |
| `components/ui/` | 22개 | 0개 | shadcn UI (라이브러리) |
| `adapters/` | 3개 .tsx | 3개 | 어댑터 설정 UI |
| **합계** | **~270개** | **~78개** | |

---

## 우선순위 파일 목록

### Tier 1: 필수 — 네비게이션 + 코어 페이지 (7개)

| 순번 | 파일 | 문자열 수 | 중요도 | 예상 시간 |
|------|------|----------|--------|----------|
| #1 | `pages/IssueDetail.tsx` | 130 | 🔴 필수 | 30분 |
| #2 | `pages/Inbox.tsx` | 58 | 🔴 필수 | 20분 |
| #3 | `pages/AgentDetail.tsx` | 93 | 🔴 필수 | 25분 |
| #4 | `pages/Dashboard.tsx` | 14 | 🔴 필수 | 10분 |
| #5 | `components/Sidebar.tsx` | 15 | 🔴 필수 | 5분 |
| #6 | `components/SidebarAgents.tsx` | 15 | 🔴 필수 | 5분 |
| #7 | `components/IssuesList.tsx` | 48 | 🔴 필수 | 15분 |

### Tier 2: 주요 — 설정 및 Agent 페이지 (8개)

| 순번 | 파일 | 문자열 수 | 중요도 | 예상 시간 |
|------|------|----------|--------|----------|
| #8 | `components/IssueProperties.tsx` | 86 | 🟠 주요 | 20분 |
| #9 | `components/IssueChatThread.tsx` | 68 | 🟠 주요 | 20분 |
| #10 | `components/NewIssueDialog.tsx` | 73 | 🟠 주요 | 20분 |
| #11 | `components/AgentConfigForm.tsx` | 72 | 🟠 주요 | 20분 |
| #12 | `components/agent-config-primitives.tsx` | 43 | 🟠 주요 | 15분 |
| #13 | `pages/CompanySkills.tsx` | 58 | 🟠 주요 | 15분 |
| #14 | `pages/Secrets.tsx` | 86 | 🟠 주요 | 20분 |
| #15 | `components/OnboardingWizard.tsx` | 44 | 🟠 주요 | 15분 |

### Tier 3: 선택 — 세부 페이지 (10개)

| 순번 | 파일 | 문자열 수 | 중요도 | 예상 시간 |
|------|------|----------|--------|----------|
| #16 | `pages/RoutineDetail.tsx` | 65 | 🟡 선택 | 15분 |
| #17 | `pages/Routines.tsx` | 51 | 🟡 선택 | 15분 |
| #18 | `pages/ExecutionWorkspaceDetail.tsx` | 71 | 🟡 선택 | 15분 |
| #19 | `components/IssueRunLedger.tsx` | 47 | 🟡 선택 | 15분 |
| #20 | `components/IssueThreadInteractionCard.tsx` | 41 | 🟡 선택 | 10분 |
| #21 | `pages/CompanyAccess.tsx` | 38 | 🟡 선택 | 10분 |
| #22 | `pages/CompanyEnvironments.tsx` | 37 | 🟡 선택 | 10분 |
| #23 | `pages/Costs.tsx` | 29 | 🟡 선택 | 10분 |
| #24 | `pages/CompanySettings.tsx` | 27 | 🟡 선택 | 10분 |
| #25 | `components/ProjectProperties.tsx` | 37 | 🟡 선택 | 10분 |

---

## 우선순위 판단 기준

1. **사용자 접근 빈도** — 네비게이션/사이드바/대시보드/인박스 최우선
2. **사용자 직접 노출도** — 사용자가 직접 보는 UI 텍스트 우선 (로그/에러 메시지 제외)
3. **영향 범위** — 공통 컴포넌트(EmptyState, Dialog 등)가 다수 페이지에 영향을 줌
4. **의존성** — 컴포넌트의 의존 관계 고려하여 상위 페이지 먼저

---

## 번역 제외 목록

- 테스트 파일 (`*.test.tsx`, `*.spec.tsx`) — 전체 제외
- `components/ui/` — shadcn/ui 라이브러리, 번역 불필요
- `packages/shared/` — 백엔드 공유 타입, 에러 메시지 (영문 유지)
- `server/` — 서버 로그, API 응답 메시지 (영문 유지)
- 에이전트 응답 메시지 — 에이전트가 생성하는 텍스트 (영문 유지)

---

## 파일별 상세 경로

### Pages (Tier 1-3)
```
/home/hakkocap/paperclip/ui/src/pages/
├── Dashboard.tsx
├── Inbox.tsx
├── Issues.tsx
├── IssueDetail.tsx
├── AgentDetail.tsx
├── Agents.tsx
├── Routines.tsx
├── RoutineDetail.tsx
├── CompanySkills.tsx
├── CompanySettings.tsx
├── CompanyAccess.tsx
├── CompanyEnvironments.tsx
├── Cost.tsx
├── Secrets.tsx
└── ExecutionWorkspaceDetail.tsx
```

### Components (Tier 1-3)
```
/home/hakkocap/paperclip/ui/src/components/
├── Sidebar.tsx
├── SidebarAgents.tsx
├── SidebarAccountMenu.tsx
├── IssuesList.tsx
├── IssueProperties.tsx
├── IssueChatThread.tsx
├── IssueRunLedger.tsx
├── IssueThreadInteractionCard.tsx
├── NewIssueDialog.tsx
├── AgentConfigForm.tsx
├── agent-config-primitives.tsx
├── OnboardingWizard.tsx
├── ProjectProperties.tsx
└── EmptyState.tsx
```

---

*인벤토리 v1.0 | 2026-05-16 | 실제 grep 기반 스캔 결과*
