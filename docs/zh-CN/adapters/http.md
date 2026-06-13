---
title: HTTP 适配器
summary: HTTP webhook 适配器
---

`http` 适配器向外部智能体服务发送 webhook 请求。智能体在外部运行，Paperclip 只是触发它。

## 何时使用

- 智能体作为外部服务运行（云函数、专用服务器）
- 即发即弃的调用模型
- 与第三方智能体平台集成

## 何时不使用

- 如果智能体在同一台机器上本地运行（使用 `process`、`claude_local` 或 `codex_local`）
- 如果你需要 stdout 捕获和实时运行视图

## 配置

| 字段 | 类型 | 是否必填 | 描述 |
|-------|------|----------|-------------|
| `url` | string | 是 | 要 POST 到的 Webhook URL |
| `headers` | object | 否 | 附加的 HTTP 标头 |
| `timeoutSec` | number | 否 | 请求超时 |

## 它是如何工作的

1. Paperclip 向配置的 URL 发送 POST 请求
2. 请求正文包含执行上下文（智能体 ID、任务信息、唤醒原因）
3. 外部智能体处理请求并回调 Paperclip API
4. 来自 webhook 的响应被捕获为运行结果

## 请求正文

webhook 收到一个包含以下内容的 JSON 负载：

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

外部智能体使用 `PAPERCLIP_API_URL` 和 API 密钥回调 Paperclip。
