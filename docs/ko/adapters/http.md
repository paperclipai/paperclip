---
title: HTTP Adapter
summary: 외부 agent service를 webhook으로 호출하는 adapter
---

# HTTP Adapter

`http` adapter는 외부 agent service에 webhook request를 보냅니다. 에이전트는 Paperclip 밖에서 실행되고, Paperclip은 trigger와 context 전달을 담당합니다.

## 사용할 때

- 에이전트가 cloud function, 별도 서버, third-party platform에서 실행될 때
- fire-and-forget invocation 모델이 맞을 때
- stdout capture보다 외부 시스템 callback이 자연스러울 때

## 사용하지 않을 때

- 같은 머신에서 로컬 프로세스로 실행할 수 있으면 `process`, `claude_local`, `codex_local`을 고려합니다.
- 실시간 stdout viewing과 transcript parsing이 중요하면 local/process adapter가 더 적합합니다.

## 설정

| Field | Type | Required | 설명 |
| --- | --- | --- | --- |
| `url` | string | Yes | POST할 webhook URL |
| `headers` | object | No | 추가 HTTP header |
| `timeoutSec` | number | No | request timeout |

## 요청 payload

Webhook은 다음 형태의 JSON을 받습니다.

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

외부 agent는 전달받은 context와 Paperclip API credential을 이용해 이슈를 읽고 상태를 업데이트합니다.
