---
title: 适配器概述
summary: 什么是适配器以及它们如何将智能体连接到 Paperclip
---
适配器是 Paperclip 的编排层和智能体运行时之间的桥梁。每个适配器都知道如何调用特定类型的 AI 智能体并捕获其结果。

## 适配器如何工作

当心跳触发时，Paperclip：

1. 查找智能体的`adapterType`和`adapterConfig`
2. 使用执行上下文调用适配器的`execute()`函数
3. 适配器生成或调用智能体运行时
4. 适配器捕获标准输出，解析使用/成本数据，并返回结构化结果

## 内置适配器

|适配器|键入键 |描述 |
|---------|----------|-------------|
| [Claude 本地](/cn/adapters/claude-local) | `claude_local` |本地运行 Claude Code CLI |
| [Codex 本地](/cn/adapters/codex-local) | `codex_local` |在本地运行 OpenAI Codex CLI |
| [Gemini 本地](/cn/adapters/gemini-local) | `gemini_local` |在本地运行 Gemini CLI |
| OpenCode 本地 | `opencode_local` |本地运行 OpenCode CLI（多提供商 `provider/model`） |
| OpenClaw | `openclaw` |将唤醒有效负载发送到 OpenClaw Webhook |
| [流程](/cn/adapters/process) | `process` |执行任意 shell 命令 |
| [HTTP](/cn/adapters/http) | `http` |向外部智能体发送 webhooks |

## 适配器架构

每个适配器都是一个包含三个模块的包：

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      parse-stdout.ts   # Stdout -> transcript entries for run viewer
      build-config.ts   # Form values -> adapterConfig JSON
    cli/
      format-event.ts   # Terminal output for `paperclipai run --watch`
```

三个注册表使用这些模块：

|登记处 |它有什么作用 |
|----------|-------------|
| **服务器** |执行智能体，捕获结果 |
| **用户界面** |渲染运行记录，提供配置表单 |
| **CLI** |格式化终端输出以进行实时观看 |

## 选择适配器

- **需要编码剂？** 使用 `claude_local`、`codex_local`、`gemini_local` 或 `opencode_local`
- **需要运行脚本或命令？** 使用 `process`
- **需要调用外部服务？** 使用`http`
- **需要定制一些东西？** [创建您自己的适配器](/cn/adapters/creating-an-adapter)