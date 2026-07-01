---
title: 架构
summary: 堆栈概述、请求流程和适配器模型
---
Paperclip 是一个具有四个主要层的单一存储库。

## 堆栈概述

```
┌─────────────────────────────────────┐
│  React UI (Vite)                    │
│  Dashboard, org management, tasks   │
├─────────────────────────────────────┤
│  Express.js REST API (Node.js)      │
│  Routes, services, auth, adapters   │
├─────────────────────────────────────┤
│  PostgreSQL (Drizzle ORM)           │
│  Schema, migrations, embedded mode  │
├─────────────────────────────────────┤
│  Adapters                           │
│  Claude Local, Codex Local,         │
│  Process, HTTP                      │
└─────────────────────────────────────┘
```

## 技术栈

|层|技术 |
|-------|-----------|
|前端 | React 19、Vite 6、React 路由器 7、Radix UI、Tailwind CSS 4、TanStack 查询 |
|后端| Node.js 20+、Express.js 5、TypeScript |
|数据库| PostgreSQL 17（或嵌入式PGlite），Drizzle ORM |
|授权 |更好的身份验证（会话 + API 密钥）|
|适配器| Claude Code CLI、Codex CLI、shell 进程、HTTP webhook |
|包管理器 | pnpm 9 与工作区 |

## 存储库结构

```
paperclip/
├── ui/                          # React frontend
│   ├── src/pages/              # Route pages
│   ├── src/components/         # React components
│   ├── src/api/                # API client
│   └── src/context/            # React context providers
│
├── server/                      # Express.js API
│   ├── src/routes/             # REST endpoints
│   ├── src/services/           # Business logic
│   ├── src/adapters/           # Agent execution adapters
│   └── src/middleware/         # Auth, logging
│
├── packages/
│   ├── db/                      # Drizzle schema + migrations
│   ├── shared/                  # API types, constants, validators
│   ├── adapter-utils/           # Adapter interfaces and helpers
│   └── adapters/
│       ├── claude-local/        # Claude Code adapter
│       └── codex-local/         # OpenAI Codex adapter
│
├── skills/                      # Agent skills
│   └── paperclip/               # Core Paperclip skill (heartbeat protocol)
│
├── cli/                         # CLI client
│   └── src/                     # Setup and control-plane commands
│
└── doc/                         # Internal documentation
```

## 请求流程

当心跳激发时：

1. **触发器** — 调度程序、手动调用或事件（分配、提及）触发心跳
2. **适配器调用**——服务器调用配置的适配器的`execute()`函数
3. **智能体进程** - 适配器使用 Paperclip 环境变量和提示生成智能体（例如 Claude Code CLI）
4. **智能体工作** — 智能体调用Paperclip的REST API检查作业、结账任务、做工作、更新状态
5. **结果捕获** - 适配器捕获标准输出，解析使用/成本数据，提取会话状态
6. **运行记录** — 服务器记录运行结果、成本以及下一次心跳的任何会话状态

## 适配器型号

适配器是 Paperclip 和智能体运行时之间的桥梁。每个适配器都是一个包含三个模块的包：

- **服务器模块** — `execute()` 生成/调用智能体的函数，以及环境诊断
- **UI 模块** — 用于运行查看器的标准输出解析器，用于创建智能体的配置表单字段
- **CLI 模块** — `paperclipai run --watch` 的终端格式化程序

内置适配器：`claude_local`、`codex_local`、`process`、`http`。您可以为任何运行时创建自定义适配器。

## 关键设计决策

- **控制平面，而不是执行平面** - Paperclip 协调智能体；它不运行它们
- **公司范围** — 所有实体都属于一家公司；严格的数据边界
- **单受让人任务** — 原子结帐可防止同一任务上的并发工作
- **与适配器无关** — 任何可以调用 HTTP API 的运行时都可以充当智能体
- **默认嵌入** — 具有嵌入式 PostgreSQL 的零配置本地模式