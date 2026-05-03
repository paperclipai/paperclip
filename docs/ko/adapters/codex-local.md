---
title: Codex Local
summary: OpenAI Codex local adapter 설정
---

# Codex Local

`codex_local` adapter는 OpenAI Codex CLI를 로컬에서 실행합니다. `previous_response_id` chaining으로 session persistence를 지원하고, global Codex skills directory를 통해 skills를 주입합니다.

## Prerequisites

- Codex CLI 설치 (`codex` command 사용 가능)
- `OPENAI_API_KEY`가 environment 또는 agent config에 설정됨

## 설정 필드

| Field | Required | 설명 |
| --- | --- | --- |
| `cwd` | Yes | agent process working directory. absolute path |
| `model` | No | 사용할 model |
| `promptTemplate` | No | 모든 run에 사용할 prompt |
| `env` | No | environment variables. secret refs 지원 |
| `timeoutSec` | No | process timeout |
| `graceSec` | No | force kill 전 grace period |
| `fastMode` | No | Codex Fast mode 활성화. 현재 `gpt-5.4`에서만 적용 |
| `dangerouslyBypassApprovalsAndSandbox` | No | safety check 우회. dev only |

## Session persistence

Codex는 `previous_response_id`로 conversation continuity를 유지합니다. adapter는 이 값을 heartbeat 사이에 serialize/restore합니다.

## Skills injection

adapter는 Paperclip skills를 `~/.codex/skills`에 symlink합니다. 기존 user skill은 overwrite하지 않습니다.

## Fast Mode

`fastMode`가 켜지면 Paperclip은 다음과 같은 Codex config override를 추가합니다.

```sh
-c 'service_tier="fast"' -c 'features.fast_mode=true'
```

현재 선택 model이 `gpt-5.4`일 때만 실행에 적용합니다.

## Managed `CODEX_HOME`

Paperclip이 managed worktree instance에서 실행 중이면 worktree-isolated `CODEX_HOME`을 사용합니다. Codex skill, session, log, runtime state가 checkout 사이에 섞이지 않게 하기 위해서입니다.

## Manual local CLI

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

필요한 skill을 설치하고 agent API key를 만든 뒤, 해당 agent로 실행할 shell export를 출력합니다.

## Instructions resolution

`instructionsFilePath`가 설정되어 있으면 Paperclip은 해당 파일을 읽어 `codex exec` stdin prompt 앞에 붙입니다. Codex 자체의 repo instruction discovery와 별개이므로 repo-local `AGENTS.md`도 추가로 로드될 수 있습니다.
