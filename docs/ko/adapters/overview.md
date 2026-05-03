---
title: Adapters Overview
summary: Adapter가 무엇이고 Paperclip과 에이전트를 어떻게 잇는지
---

# Adapters Overview

Adapter는 Paperclip의 orchestration layer와 실제 agent runtime 사이의 다리입니다. 각 adapter는 특정 종류의 AI 에이전트를 실행하고 결과를 수집하는 방법을 알고 있습니다.

## 작동 방식

Heartbeat가 발생하면 Paperclip은 다음 순서로 움직입니다.

1. 에이전트의 `adapterType`과 `adapterConfig`를 읽습니다.
2. adapter의 `execute()` 함수를 execution context와 함께 호출합니다.
3. adapter가 agent runtime을 실행하거나 외부 서비스를 호출합니다.
4. stdout, usage/cost data, session state를 수집합니다.
5. 구조화된 run result를 Paperclip에 반환합니다.

## 내장 adapter

| Adapter | Type key | 설명 |
| --- | --- | --- |
| Claude Local | `claude_local` | 로컬 Claude Code CLI 실행 |
| Codex Local | `codex_local` | 로컬 OpenAI Codex CLI 실행 |
| Gemini Local | `gemini_local` | 로컬 Gemini CLI 실행, experimental |
| OpenCode Local | `opencode_local` | OpenCode CLI 실행 |
| Cursor | `cursor` | Cursor background mode 실행 |
| Pi Local | `pi_local` | embedded Pi agent 실행 |
| Hermes Local | `hermes_local` | Hermes CLI 실행 |
| OpenClaw Gateway | `openclaw_gateway` | OpenClaw gateway endpoint 연결 |
| Process | `process` | 임의 shell command 실행 |
| HTTP | `http` | 외부 agent 서비스에 webhook 전송 |

## External adapter

외부 adapter는 Paperclip source를 수정하지 않고 별도 npm package로 배포할 수 있습니다. plugin system이 startup 때 package를 로드합니다.

```sh
curl -X POST http://localhost:3102/api/adapters \
  -d '{"packageName": "my-paperclip-adapter"}'
```

로컬 디렉터리를 연결할 수도 있습니다.

```sh
curl -X POST http://localhost:3102/api/adapters \
  -d '{"localPath": "/home/user/my-adapter"}'
```

## Adapter 구조

```text
my-adapter/
  src/
    index.ts
    server/
      execute.ts
      parse.ts
      test.ts
    ui-parser.ts
    cli/
      format-event.ts
```

- **Server** — 에이전트를 실행하고 결과를 수집합니다.
- **UI** — run transcript와 config form을 렌더링합니다.
- **CLI** — `paperclipai run --watch` 출력 형식을 제공합니다.

## 선택 기준

- coding agent가 필요하면 `claude_local`, `codex_local`, `opencode_local`, `hermes_local` 중 하나를 씁니다.
- 단순 command 실행이면 `process`를 씁니다.
- 외부 agent platform 호출이면 `http`를 씁니다.
- 직접 만든 runtime을 연결하려면 external adapter plugin을 만듭니다.
