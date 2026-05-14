---
title: 适配器概览
summary: 适配器是什么，以及它们如何把智能体接到 Paperclip
---

适配器是 Paperclip 编排层与智能体运行时之间的桥梁。每个适配器知道如何唤起特定类型的 AI 智能体并采集其结果。

## 适配器如何工作

当心搏触发时，Paperclip：

1. 查找智能体的 `adapterType` 与 `adapterConfig`
2. 用执行上下文调用适配器的 `execute()` 函数
3. 适配器启动子进程或调用智能体运行时
4. 适配器捕获标准输出，解析用量/费用数据，并返回结构化结果

## 内置适配器

| 适配器 | 类型键 | 说明 |
|---------|----------|-------------|
| [Claude 本地](/适配器/05%20Claude%20本地适配器%20claude-local) | `claude_local` | 在本地运行 Claude Code CLI |
| [Codex 本地](/适配器/06%20Codex%20本地适配器%20codex-local) | `codex_local` | 在本地运行 OpenAI Codex CLI |
| [Gemini 本地](/适配器/07%20Gemini%20本地适配器%20gemini-local) | `gemini_local` | 在本地运行 Gemini CLI（实验性——适配器包已存在，尚未进入稳定类型枚举） |
| OpenCode 本地 | `opencode_local` | 在本地运行 OpenCode CLI（多厂商 `provider/model`） |
| Cursor | `cursor` | 在后台模式下运行 Cursor |
| Pi 本地 | `pi_local` | 在本地运行嵌入式 Pi 智能体 |
| Hermes 本地 | `hermes_local` | 在本地运行 Hermes CLI（`hermes-paperclip-adapter`） |
| OpenClaw 网关 | `openclaw_gateway` | 连接到 OpenClaw 网关端点 |
| [进程](/适配器/09%20进程适配器%20process) | `process` | 执行任意 shell 命令 |
| [HTTP](/适配器/08%20HTTP%20适配器%20http) | `http` | 向外部智能体发送 Webhook |

### 外部（插件）适配器

以下适配器以独立 npm 包形式发布，通过插件系统安装：

| 适配器 | 包名 | 类型键 | 说明 |
|---------|---------|----------|-------------|
| Droid 本地 | `@henkey/droid-paperclip-adapter` | `droid_local` | 在本地运行 Factory Droid |

## 外部适配器

你可以将适配器做成独立包分发——无需修改 Paperclip 源码。外部适配器在启动时通过插件系统加载。

```sh
# 通过 API 从 npm 安装
curl -X POST http://localhost:3102/api/adapters \
  -d '{"packageName": "my-paperclip-adapter"}'

# 或从本地目录链接
curl -X POST http://localhost:3102/api/adapters \
  -d '{"localPath": "/home/user/my-adapter"}'
```

完整说明见 [外部适配器](/适配器/03%20外部适配器%20external-adapters)。

## 适配器架构

每个适配器是一个包，其中的模块会被三类注册表消费：

```
my-adapter/
  src/
    index.ts            # 共享元数据（类型、标签、模型）
    server/
      execute.ts        # 核心执行逻辑
      parse.ts          # 输出解析
      test.ts           # 环境与配置诊断
    ui-parser.ts        # 自包含的 UI 逐行解析器（外部适配器用）
    cli/
      format-event.ts   # `paperclipai run --watch` 的终端输出
```

| 注册表 | 作用 | 来源 |
|----------|-------------|--------|
| **Server** | 执行智能体并采集结果 | 包根的 `createServerAdapter()` |
| **UI** | 渲染运行记录、提供配置表单 | `ui-parser.js`（动态）或静态导入（内置） |
| **CLI** | 为实时观察格式化终端输出 | 静态导入 |

## 如何选择适配器

- **需要编程智能体？** 使用 `claude_local`、`codex_local`、`opencode_local`、`hermes_local`，或将 `droid_local` 作为外部插件安装
- **需要跑脚本或命令？** 使用 `process`
- **需要调用外部服务？** 使用 `http`
- **需要完全定制？** [自行创建适配器](/适配器/02%20创建适配器%20creating-an-adapter) 或 [构建外部适配器插件](/适配器/03%20外部适配器%20external-adapters)

## UI 解析器契约

外部适配器可附带自包含的 UI 解析器，告诉 Paperclip Web UI 如何渲染其标准输出。没有它时，UI 使用通用 shell 解析器。详见 [UI 解析器契约](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser)。
