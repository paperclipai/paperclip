# Phase 9: Friction-Zero Capture Surfaces - Context

**수집일:** 2026-04-25  
**상태:** planning/execution 준비 완료

<domain>
## Phase 경계

Phase 9는 wave나 sub-step이 아니라 v2.1의 정식 Phase 전체다. 범위는 `CAP-01`부터 `CAP-05`까지다. 사용자는 페이지를 이동하지 않고 One-Liner를 열 수 있어야 하며, shortcut, voice input, messenger-style inbound text가 모두 같은 review draft 경로로 수렴해야 한다. commit 후에는 생성된 task/deliverable/reward evidence를 즉시 보여줘야 한다.

</domain>

<decisions>
## 구현 결정

### Capture Surface
- **D-01:** 기존 canonical One-Liner page를 대체하지 않고, app layout에 global floating One-Liner widget을 추가한다.
- **D-02:** 모든 entry point는 기존 deterministic One-Liner parser와 review model을 재사용한다.

### Shortcut and Voice
- **D-03:** 기존 global `c` shortcut은 페이지 이동 대신 floating capture widget을 연다.
- **D-04:** voice baseline은 browser SpeechRecognition을 사용한다. 지원되지 않으면 명확한 fallback message를 보여주고 text input을 유지한다.

### Inbound Messenger Flow
- **D-05:** Slack/Teams-style intake는 company-scoped authenticated inbound draft endpoint로 구현한다. 이 endpoint는 irreversible task를 직접 만들지 않고 reviewed draft payload를 만든다.

### Reward Feedback
- **D-06:** commit 직후 task id, deliverable summary, proposed gold, XP, settlement state, reward rationale을 보여준다. 실제 ledger issuance는 이후 quality/review settlement에 맡긴다.

### agent 재량
- 이번 Phase에서는 새 DB table을 추가하지 않는다.
- source별 reward bonus는 deterministic하고 설명 가능하게 둔다.

</decisions>

<canonical_refs>
## 기준 참조

### Product and Planning
- `.planning/ROADMAP.md` — Phase 9 목표와 성공 기준.
- `.planning/REQUIREMENTS.md` — `CAP-01`부터 `CAP-05`.
- `.planning/DEVPLAN-ALIGNMENT.md` — 업로드 개발기획서 gap audit.
- `AGENTS.md` — RealTycoon2-first 제품/작업 규칙.

### Prior Implementation
- `ui/src/pages/rt2/OneLinerPage.tsx` — 기존 canonical One-Liner review flow.
- `ui/src/lib/one-liner-draft.ts` — parser entry point. 현재는 `@paperclipai/shared`를 재-export한다.
- `server/src/routes/rt2-tasks.ts` — RT2 task creation과 inbound draft route.

</canonical_refs>

<code_context>
## 기존 코드 인사이트

### 재사용 자산
- `useKeyboardShortcuts`는 이미 app-wide shortcut을 관리하므로 새 global listener 없이 widget을 열 수 있다.
- `projectsApi.list`와 `queryKeys.projects.list`는 project 선택에 재사용 가능하다.
- `rt2TasksApi.create`는 이미 RT2 task와 deliverable definition을 만든다.

### 기존 패턴
- command palette, dialog, toast처럼 layout-level component는 global surface를 mount하기 적합하다.
- RT2 task creation은 server-side에서 company-scoped이고 board-user guarded다.

### Integration Points
- `ui/src/components/Layout.tsx`가 floating capture widget을 mount한다.
- `packages/shared/src/one-liner-draft.ts`가 parser/reward-evidence source of truth다.
- `POST /api/companies/:companyId/rt2/one-liner/inbound-draft`는 Slack/Teams-style draft intake를 담당한다.

</code_context>

<specifics>
## 구체 아이디어

- floating widget helper copy는 한국어 친화적으로 작성한다.
- shortcut label은 keyboard shortcuts dialog에 문서화한다.
- voice input은 direct commit이 아니라 draft generation으로 시작한다.

</specifics>

<deferred>
## 미룬 항목

- 실제 Slack/Teams OAuth/app installation, public unauthenticated webhook secret, HMAC replay protection은 이후 integration/security phase로 미룬다.
- task creation 시 immutable coin-ledger issuance는 quality/review settlement rule이 product-approved된 뒤 처리한다.

</deferred>

---
*Phase: 09-friction-zero-capture-surfaces*  
*Context gathered: 2026-04-25*
