---
title: Environment Variables
summary: Server configuration 환경 변수 전체 개요
---

# Environment Variables

Paperclip server 설정에 사용하는 주요 환경 변수입니다.

## Server configuration

| Variable | Default | 설명 |
| --- | --- | --- |
| `PORT` | `3100` | server port |
| `PAPERCLIP_BIND` | `loopback` | `loopback`, `lan`, `tailnet`, `custom` |
| `PAPERCLIP_BIND_HOST` | unset | `PAPERCLIP_BIND=custom`일 때 필요 |
| `HOST` | `127.0.0.1` | legacy host override |
| `DATABASE_URL` | embedded | PostgreSQL connection string |
| `PAPERCLIP_HOME` | `~/.paperclip` | Paperclip data base directory |
| `PAPERCLIP_INSTANCE_ID` | `default` | local multi-instance identifier |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | runtime mode override |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | authenticated mode exposure policy |
| `PAPERCLIP_API_URL` | auto | external/public API base URL override |

## Secrets

| Variable | 설명 |
| --- | --- |
| `PAPERCLIP_SECRETS_MASTER_KEY` | 32-byte encryption key |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | master key file path |
| `PAPERCLIP_SECRETS_STRICT_MODE` | secret refs 강제 여부 |

## Agent runtime 주입 변수

server가 agent process 실행 시 자동으로 설정합니다.

| Variable | 설명 |
| --- | --- |
| `PAPERCLIP_AGENT_ID` | agent ID |
| `PAPERCLIP_COMPANY_ID` | company ID |
| `PAPERCLIP_API_URL` | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | 단명 API auth JWT |
| `PAPERCLIP_RUN_ID` | current heartbeat run ID |
| `PAPERCLIP_TASK_ID` | wake를 유발한 issue |
| `PAPERCLIP_WAKE_REASON` | wake trigger reason |
| `PAPERCLIP_WAKE_COMMENT_ID` | wake comment |
| `PAPERCLIP_APPROVAL_ID` | resolved approval ID |
| `PAPERCLIP_APPROVAL_STATUS` | approval decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | linked issue IDs |

## LLM provider keys

| Variable | 설명 |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude Local adapter용 Anthropic API key |
| `OPENAI_API_KEY` | Codex Local adapter용 OpenAI API key |
