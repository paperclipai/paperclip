---
title: 环境变量
summary: 完整的环境变量参考
---

Paperclip 用于服务器配置的所有环境变量。

## 服务器配置

| 变量 | 默认值 | 描述 |
|----------|---------|-------------|
| `PORT` | `3100` | 服务器端口 |
| `PAPERCLIP_BIND` | `loopback` | 可访问性预设：`loopback`、`lan`、`tailnet` 或 `custom` |
| `PAPERCLIP_BIND_HOST` |（未设置） | 当 `PAPERCLIP_BIND=custom` 时必需 |
| `HOST` | `127.0.0.1` | 传统主机覆盖；对于新设置，优先使用 `PAPERCLIP_BIND` |
| `DATABASE_URL` |（嵌入式） | PostgreSQL 连接字符串 |
| `PAPERCLIP_HOME` | `~/.paperclip` | 所有 Paperclip 数据的基本目录 |
| `PAPERCLIP_INSTANCE_ID` | `default` | 实例标识符（用于多个本地实例） |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | 运行时模式覆盖 |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | 当部署模式为 `authenticated` 时的暴露策略 |
| `PAPERCLIP_API_URL` |（自动派生） | Paperclip API 基础 URL。当在外部设置时（例如，通过 Kubernetes ConfigMap、负载均衡器或反向代理），服务器保留该值，而不是从侦听主机和端口派生。对于面向公共的 URL 与本地绑定地址不同的部署很有用。 |
| `PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED` | 开启（未设置或非 `false`） | 设为 `false` 时，心跳调度器不再自动创建 `stranded_issue_recovery`（滞留回收子单）。修改后需重启 API 进程生效。 |

## 密钥

| 变量 | 默认值 | 描述 |
|----------|---------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` |（来自文件） | 32 字节加密密钥（base64/hex/raw） |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | `~/.paperclip/.../secrets/master.key` | 密钥文件路径 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `false` | 要求敏感环境变量使用密钥引用 |

## 代理运行时（注入到代理进程中）

这些由服务器在调用代理时自动设置：

| 变量 | 描述 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | 代理的唯一 ID |
| `PAPERCLIP_COMPANY_ID` | 公司 ID |
| `PAPERCLIP_API_URL` | Paperclip API 基础 URL（继承服务器级值；请参见上面的服务器配置） |
| `PAPERCLIP_API_KEY` | 用于 API 认证的短期 JWT |
| `PAPERCLIP_RUN_ID` | 当前心跳运行 ID |
| `PAPERCLIP_TASK_ID` | 触发此唤醒的问题 |
| `PAPERCLIP_WAKE_REASON` | 唤醒触发器原因 |
| `PAPERCLIP_WAKE_COMMENT_ID` | 触发此唤醒的评论 |
| `PAPERCLIP_APPROVAL_ID` | 已解析的批准 ID |
| `PAPERCLIP_APPROVAL_STATUS` | 批准决定 |
| `PAPERCLIP_LINKED_ISSUE_IDS` | 逗号分隔的链接问题 ID |

## LLM 提供商密钥（用于适配器）

| 变量 | 描述 |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（用于 Claude Local 适配器） |
| `OPENAI_API_KEY` | OpenAI API 密钥（用于 Codex Local 适配器） |