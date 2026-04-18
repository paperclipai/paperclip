---
title: HTTP 适配器
summary: HTTP Webhook 适配器
---
`http` 适配器向外部智能体服务发送 Webhook 请求。该智能体在外部运行，Paperclip 只是触发它。

## 何时使用

- 智能体作为外部服务运行（云功能、专用服务器）
- 即发即忘调用模型
- 与第三方智能体平台集成

## 何时不使用

- 如果智能体在同一台计算机上本地运行（使用 `process`、`claude_local` 或 `codex_local`）
- 如果您需要标准输出捕获和实时运行查看

## 配置

|领域 |类型 |必填 |描述 |
|-------|------|----------|-------------|
| `url` |字符串|是的 |要 POST 到的 Webhook URL |
| `headers` |对象|没有 |附加 HTTP 标头 |
| `timeoutSec` |数量 |没有 |请求超时 |

## 它是如何工作的

1. Paperclip 向配置的URL发送POST请求
2. 请求体包含执行上下文（智能体ID、任务信息、唤醒原因）
3、外部智能体处理请求并回调Paperclip API
4. 捕获来自 webhook 的响应作为运行结果

## 请求正文

Webhook 接收 JSON 有效负载：

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

外部智能体使用 `PAPERCLIP_API_URL` 和 API 键回拨 Paperclip。