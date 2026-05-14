---
title: HTTP 适配器
summary: 通过 HTTP Webhook 调用外部智能体服务
---

`http` 适配器会向外部智能体服务发送 Webhook 请求。智能体在外部运行，Paperclip 只负责触发。

## 适用场景

- 智能体以独立服务形态运行（云函数、专属服务器）
- 「触发即返回」式的调用模型
- 与第三方智能体平台集成

## 不适用场景

- 智能体与 Paperclip 在同一台机器本地运行（请用 `process`、`claude_local` 或 `codex_local`）
- 需要捕获标准输出并实时查看运行过程

## 配置

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `url` | string | 是 | 要 POST 的 Webhook URL |
| `headers` | object | 否 | 附加 HTTP 头 |
| `timeoutSec` | number | 否 | 请求超时时间 |

## 工作原理

1. Paperclip 向配置的 URL 发送 POST 请求
2. 请求体包含执行上下文（智能体 ID、任务信息、唤醒原因等）
3. 外部智能体处理请求并通过 Paperclip API 回写状态
4. Webhook 的响应作为本次运行的结果被捕集

## 请求体

Webhook 收到的 JSON 负载示例：

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

外部智能体使用 `PAPERCLIP_API_URL` 与 API 密钥回调 Paperclip。
