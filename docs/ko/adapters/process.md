---
title: Process Adapter
summary: 범용 shell process adapter
---

# Process Adapter

`process` adapter는 임의 shell command를 실행합니다. 단순 script, one-shot task, custom framework 기반 agent에 적합합니다.

## 사용할 때

- Paperclip API를 호출하는 Python script 실행
- custom agent loop 실행
- shell command로 호출 가능한 runtime 연결

## 사용하지 않을 때

- run 사이 session persistence가 필요하면 `claude_local` 또는 `codex_local`을 사용합니다.
- heartbeat 사이 conversational context가 중요하면 process adapter는 부족할 수 있습니다.

## 설정

| Field | Required | 설명 |
| --- | --- | --- |
| `command` | Yes | 실행할 shell command |
| `cwd` | No | working directory |
| `env` | No | environment variables |
| `timeoutSec` | No | process timeout |

## 작동 방식

1. Paperclip이 configured command를 child process로 실행합니다.
2. `PAPERCLIP_AGENT_ID`, `PAPERCLIP_API_KEY` 같은 표준 환경 변수를 주입합니다.
3. process가 완료될 때까지 실행합니다.
4. exit code로 success/failure를 판단합니다.

예시:

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```
