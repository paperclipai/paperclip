---
title: 环境变量
summary: 完整环境变量参考
---
Paperclip 用于服务器配置的所有环境变量。

## 服务器配置

|变量|默认 |描述 |
|----------|---------|-------------|
| `PORT` | `3100` |服务器端口 |
| `HOST` | `127.0.0.1` |服务器主机绑定 |
| `DATABASE_URL` | （嵌入）| PostgreSQL 连接字符串 |
| `PAPERCLIP_HOME` | `~/.paperclip` |所有 Paperclip 数据的基目录 |
| `PAPERCLIP_INSTANCE_ID` | `default` |实例标识符（对于多个本地实例）|
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` |运行时模式覆盖 |

## 秘密

|变量|默认 |描述 |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | （来自文件）| 32 字节加密密钥（base64/hex/raw）|
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` |密钥文件的路径 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` |敏感环境变量需要秘密引用 |

## 智能体运行时（注入智能体进程）

这些是服务器在调用智能体时自动设置的：

|变量|描述 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` |智能体的唯一ID |
| `PAPERCLIP_COMPANY_ID` |公司ID |
| `PAPERCLIP_API_URL` | Paperclip API 基本 URL |
| `PAPERCLIP_API_KEY` | API 身份验证的短暂 JWT |
| `PAPERCLIP_RUN_ID` |当前心跳运行ID |
| `PAPERCLIP_TASK_ID` |触发此唤醒的问题 |
| `PAPERCLIP_WAKE_REASON` |唤醒触发原因 |
| `PAPERCLIP_WAKE_COMMENT_ID` |引发此唤醒的评论 |
| `PAPERCLIP_APPROVAL_ID` |已解决的批准 ID |
| `PAPERCLIP_APPROVAL_STATUS` |批准决定 |
| `PAPERCLIP_LINKED_ISSUE_IDS` |以逗号分隔的链接问题 ID |

## LLM 提供商密钥（用于适配器）

|变量|描述 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（适用于 Claude 本地适配器）|
| `OPENAI_API_KEY` | OpenAI API 密钥（用于 Codex 本地适配器）|