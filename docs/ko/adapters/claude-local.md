---
title: Claude Local
summary: Claude Code local adapter 설정
---

# Claude Local

`claude_local` adapter는 Anthropic Claude Code CLI를 로컬에서 실행합니다. session persistence, skills injection, structured output parsing을 지원합니다.

## Prerequisites

- Claude Code CLI 설치 (`claude` command 사용 가능)
- `ANTHROPIC_API_KEY`가 environment 또는 agent config에 설정됨

## 설정 필드

| Field | Required | 설명 |
| --- | --- | --- |
| `cwd` | Yes | agent process working directory. absolute path |
| `model` | No | 사용할 Claude model |
| `promptTemplate` | No | 모든 run에 사용할 prompt |
| `env` | No | environment variables. secret refs 지원 |
| `timeoutSec` | No | process timeout. `0`은 timeout 없음 |
| `graceSec` | No | force kill 전 grace period |
| `maxTurnsPerRun` | No | heartbeat당 최대 agentic turn |
| `dangerouslySkipPermissions` | No | headless run에서 permission prompt를 건너뜀 |

## Prompt template

`{{variable}}` 치환을 지원합니다.

| Variable | 값 |
| --- | --- |
| `{{agentId}}` | agent ID |
| `{{companyId}}` | company ID |
| `{{runId}}` | current run ID |
| `{{agent.name}}` | agent name |
| `{{company.name}}` | company name |

## Session persistence

adapter는 heartbeat 사이에 Claude Code session ID를 저장합니다. 다음 wake에서는 기존 conversation을 resume해 맥락을 유지합니다.

resume은 `cwd`를 고려합니다. working directory가 바뀌면 fresh session을 시작합니다. unknown session error가 나면 자동으로 fresh session으로 재시도합니다.

## Skills injection

adapter는 Paperclip skills를 symlink한 temp directory를 만들고 `--add-dir`로 Claude Code에 전달합니다. agent workspace를 더럽히지 않고 skill discovery를 가능하게 합니다.

수동 CLI로 agent처럼 실행하려면:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## Environment test

UI의 **Test Environment** 버튼은 다음을 확인합니다.

- Claude CLI 접근 가능 여부
- working directory 유효성
- API key/auth hint
- live hello probe 실행 가능 여부
