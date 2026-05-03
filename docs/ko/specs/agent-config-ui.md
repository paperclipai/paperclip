# Agent Configuration & Activity UI

이 spec은 Paperclip agent 생성/설정/활동 UI의 형태를 정의합니다.

## 범위

1. **Agent Creation Dialog** — 새 agent 생성 flow
2. **Agent Detail Page** — 설정, activity, log
3. **Agents List Page** — 기존 목록 개선

## Agent Creation Dialog

기존 `NewIssueDialog`, `NewProjectDialog` 패턴을 따릅니다. expand/minimize toggle, company badge breadcrumb, Cmd+Enter submit을 사용합니다.

주요 field:

- Name
- Title
- Role
- Reports To
- Capabilities
- Adapter Type
- Test environment
- CWD
- Prompt Template
- Model
- Runtime config
- Heartbeat policy

adapter type에 따라 Claude/Codex/process/http 전용 field가 표시됩니다.

## Agent Detail Page

header는 name, role, title, status badge, action button을 유지하고, tab layout을 더 풍부하게 구성합니다.

주요 tab:

- Overview
- Configuration
- Activity
- Logs
- Costs

Header action:

- Invoke
- Pause/Resume
- Terminate
- Reset Session
- Create API Key

## Agents List Page

agent status, reporting hierarchy, budget, recent run 상태를 빠르게 볼 수 있어야 합니다. list는 agent 운영자가 “누가 살아 있고, 누가 막혔는지” 즉시 판단하는 surface입니다.
