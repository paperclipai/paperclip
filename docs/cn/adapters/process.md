---
title: 过程适配器
summary: 通用 shell 进程适配器
---
`process` 适配器执行任意 shell 命令。将其用于简单的脚本、一次性任务或基于自定义框架构建的智能体。

## 何时使用

- 运行调用 Paperclip API 的 Python 脚本
- 执行自定义智能体循环
- 任何可以作为 shell 命令调用的运行时

## 何时不使用

- 如果您需要跨运行的会话持久性（使用 `claude_local` 或 `codex_local`）
- 如果智能体需要心跳之间的对话上下文

## 配置

|领域|类型 |必填|描述 |
|-------|------|----------|-------------|
| `command` |字符串|是的 |执行的 Shell 命令 |
| `cwd` |字符串|没有 |工作目录|
| `env` |对象|没有 |环境变量|
| `timeoutSec` |数量 |没有 |进程超时|

## 它是如何工作的

1. Paperclip 将配置的命令生成为子进程
2、注入标准Paperclip环境变量（`PAPERCLIP_AGENT_ID`、`PAPERCLIP_API_KEY`等）
3. 流程运行完成
4. 退出代码决定成功/失败

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

该脚本可以使用注入的环境变量向 Paperclip API 进行身份验证并执行工作。