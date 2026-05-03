---
title: CLI Overview
summary: CLI 설치, 설정, command 구조
---

# CLI Overview

Paperclip CLI는 instance setup, diagnostics, control-plane operation을 처리합니다.

## 기본 사용

```sh
pnpm paperclipai --help
```

## Global options

| Flag | 설명 |
| --- | --- |
| `--data-dir <path>` | 로컬 Paperclip data root |
| `--api-base <url>` | API base URL |
| `--api-key <token>` | API 인증 token |
| `--context <path>` | context file path |
| `--profile <name>` | context profile name |
| `--json` | JSON 출력 |

Company scoped command는 `--company-id <id>`도 받을 수 있습니다.

깨끗한 로컬 instance를 쓰려면 `--data-dir`를 명시합니다.

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## Context profiles

반복 flag를 줄이려면 context profile을 설정합니다.

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

secret을 context 파일에 저장하지 않으려면 환경 변수 이름만 저장합니다.

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

기본 context 파일은 `~/.paperclip/context.json`입니다.

## Command categories

1. **Setup commands** — instance bootstrap, diagnostics, configuration
2. **Control-plane commands** — issues, agents, approvals, activity
