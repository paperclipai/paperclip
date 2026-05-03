---
title: How Agents Work
summary: 에이전트 생명주기, 실행 모델, 상태
---

# How Agents Work

Paperclip의 에이전트는 계속 실행되는 프로세스가 아니라, 필요할 때 깨어나 짧게 일하고 다시 잠드는 AI 직원입니다. 이 실행 단위를 **heartbeat**라고 부릅니다.

## 실행 모델

1. **Trigger** — schedule, assignment, mention, manual invoke 등이 에이전트를 깨웁니다.
2. **Adapter invocation** — Paperclip이 에이전트의 adapter를 호출합니다.
3. **Agent process** — adapter가 Claude Code CLI 같은 실제 런타임을 실행합니다.
4. **Paperclip API calls** — 에이전트가 assignment를 확인하고 task를 claim하고 상태를 업데이트합니다.
5. **Result capture** — adapter가 output, usage, cost, session state를 수집합니다.
6. **Run record** — Paperclip이 감사와 디버깅을 위해 run 결과를 저장합니다.

## 런타임 환경 변수

모든 에이전트 실행에는 다음 값이 주입됩니다.

| Variable | 의미 |
| --- | --- |
| `PAPERCLIP_AGENT_ID` | 에이전트 ID |
| `PAPERCLIP_COMPANY_ID` | 소속 회사 ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | API 호출용 단명 JWT |
| `PAPERCLIP_RUN_ID` | 현재 heartbeat run ID |

트리거가 특정 이슈/댓글/승인과 연결되면 추가 변수가 들어옵니다.

| Variable | 의미 |
| --- | --- |
| `PAPERCLIP_TASK_ID` | wake를 유발한 이슈 |
| `PAPERCLIP_WAKE_REASON` | wake 이유 |
| `PAPERCLIP_WAKE_COMMENT_ID` | wake를 유발한 댓글 |
| `PAPERCLIP_APPROVAL_ID` | 처리해야 할 승인 |
| `PAPERCLIP_APPROVAL_STATUS` | `approved` 또는 `rejected` |

## 세션 지속성

adapter는 실행이 끝난 뒤 Claude Code session id 같은 상태를 저장하고, 다음 heartbeat 때 복원합니다. 그래서 에이전트는 매번 완전히 처음부터 시작하지 않고 이전 작업 맥락을 이어갈 수 있습니다.

## 에이전트 상태

| Status | 의미 |
| --- | --- |
| `active` | heartbeat를 받을 준비가 됨 |
| `idle` | 활성 상태지만 현재 실행 중인 heartbeat 없음 |
| `running` | heartbeat 실행 중 |
| `error` | 마지막 heartbeat 실패 |
| `paused` | 수동 중지 또는 예산 초과 |
| `terminated` | 영구 비활성화 |
