# Agent Runtime Guide

Status: user-facing guide
Audience: Paperclip에서 agent를 설정하고 운영하는 사람

## 시스템이 하는 일

Paperclip의 agent는 계속 실행되지 않습니다. agent는 wakeup으로 트리거되는 짧은 실행 창인 **heartbeat** 안에서 동작합니다.

각 heartbeat는 다음을 수행합니다.

1. configured adapter를 시작합니다. 예: Claude CLI, Codex CLI.
2. 현재 prompt/context를 전달합니다.
3. agent가 exit, timeout, cancel될 때까지 작업하게 둡니다.
4. status, token usage, error, log를 저장합니다.
5. UI를 live update합니다.

## agent가 깨어나는 방식

- `timer` — scheduled interval
- `assignment` — 작업이 assign/checkout될 때
- `on_demand` — 버튼/API 수동 wakeup
- `automation` — future automation용 system trigger

이미 실행 중이면 새 wakeup은 duplicate run을 만들지 않고 coalesce됩니다.

## agent별 설정

### Adapter

내장 adapter:

- `claude_local`
- `codex_local`
- `opencode_local`
- `cursor`
- `pi_local`
- `hermes_local`
- `openclaw_gateway`
- `process`
- `http`

local CLI adapter는 host machine에 CLI가 설치/인증되어 있다고 가정합니다.

### Runtime behavior

agent runtime settings에서 heartbeat policy를 설정합니다.

- `enabled`
- `intervalSec`
- `wakeOnAssignment`
- `wakeOnOnDemand`
- `wakeOnAutomation`

### Working directory와 실행 제한

local adapter에서는 `cwd`, `timeoutSec`, `graceSec`, env var, extra CLI args를 설정합니다. 저장 전 **Test environment**로 adapter-specific diagnostic을 실행하는 것이 좋습니다.

### Prompt template

`promptTemplate`은 모든 run에 사용됩니다. `{{agent.id}}`, `{{agent.name}}` 같은 변수를 지원합니다.

`bootstrapPromptTemplate`은 deprecated이며 새 agent에는 managed instructions bundle을 사용해야 합니다.

## Session resume

resumable adapter는 session ID를 저장합니다. 다음 heartbeat는 저장된 session을 자동 재사용해 맥락을 유지합니다.

session reset이 필요한 경우:

- prompt strategy를 크게 바꾼 경우
- agent가 loop에 빠진 경우
- 깨끗한 재시작이 필요한 경우

## Logs, status, run history

heartbeat run마다 다음이 기록됩니다.

- `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`
- error text, stderr/stdout excerpt
- token usage/cost
- full logs

UI는 agent status, run status, task/activity update, dashboard/cost/activity panel을 실시간으로 갱신합니다.
