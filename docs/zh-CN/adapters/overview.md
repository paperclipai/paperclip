---
title: 适配器概览
summary: 什么是适配器以及它们如何将智能体连接到 Paperclip
---

适配器是 Paperclip 的编排层与智能体运行时之间的桥梁。每个适配器都知道如何调用特定类型的 AI 智能体并捕获其结果。

## 适配器如何工作

当心跳触发时，Paperclip 会：

1. 查找智能体的 `adapterType` 和 `adapterConfig`
2. 使用执行上下文调用适配器的 `execute()` 函数
3. 适配器生成或调用智能体运行时
4. 适配器捕获 stdout，解析使用量/成本数据，并返回结构化的结果

## 内置适配器

| 适配器 | 类型键 | 描述 |
|---------|----------|-------------|
| [Claude Local](/adapters/claude-local) | `claude_local` | 在本地运行 Claude Code CLI |
| [Codex Local](/adapters/codex-local) | `codex_local` | 在本地运行 OpenAI Codex CLI |
| [Gemini Local](/adapters/gemini-local) | `gemini_local` | 在本地运行 Gemini CLI |
| OpenCode Local | `opencode_local` | 在本地运行 OpenCode CLI（多提供商 `provider/model`） |
| OpenClaw | `openclaw` | 将唤醒有效负载发送到 OpenClaw webhook |
| [Process](/adapters/process) | `process` | 执行任意的 shell 命令 |
| [HTTP](/adapters/http) | `http` | 将 webhook 发送到外部智能体 |

## 适配器架构

每个适配器都是一个包含三个模块的包：

```
packages/adapters/<name>/
  src/
    index.ts            # 共享元数据（类型、标签、模型）
    server/
      execute.ts        # 核心执行逻辑
      parse.ts          # 输出解析
      test.ts           # 环境诊断
    ui/
      parse-stdout.ts   # Stdout -> 运行查看器的转录条目
      build-config.ts   # 表单值 -> adapterConfig JSON
    cli/
      format-event.ts   # 用于 `paperclipai run --watch` 的终端输出
```

三个注册表使用这些模块：

| 注册表 | 它的作用 |
|----------|-------------|
| **Server** | 执行智能体，捕获结果 |
| **UI** | 渲染运行转录，提供配置表单 |
| **CLI** | 格式化用于实时监视的终端输出 |

## 选择一个适配器

- **需要一个编码智能体？** 使用 `claude_local`，`codex_local`，`gemini_local` 或 `opencode_local`
- **需要运行脚本或命令？** 使用 `process`
- **需要调用外部服务？** 使用 `http`
- **需要自定义？** [创建你自己的适配器](/adapters/creating-an-adapter)
