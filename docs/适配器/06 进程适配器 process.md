---
title: 进程适配器
summary: 通用 shell 进程适配器
---

`process` 适配器执行任意 shell 命令。适用于简单脚本、一次性任务，或基于自研框架的智能体。

## 适用场景

- 运行会调用 Paperclip API 的 Python 脚本
- 执行自定义智能体循环
- 任意可通过 shell 命令启动的运行时

## 不适用场景

- 需要在多次运行之间持久化会话（请用 `claude_local` 或 `codex_local`）
- 智能体需要心搏之间的对话上下文

## 配置

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `command` | string | 是 | 要执行的 shell 命令 |
| `cwd` | string | 否 | 工作目录 |
| `env` | object | 否 | 环境变量 |
| `timeoutSec` | number | 否 | 进程超时（秒） |

## 工作原理

1. Paperclip 将配置的命令作为子进程启动
2. 注入标准 Paperclip 环境变量（`PAPERCLIP_AGENT_ID`、`PAPERCLIP_API_KEY` 等）
3. 进程运行直至结束
4. 退出码决定成功/失败

## 示例

运行 Python 脚本的智能体：

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

脚本可使用注入的环境变量对接 Paperclip API 并完成工作。
