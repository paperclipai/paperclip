---
title: 架构 (Architecture)
summary: 技术栈概览、请求流程和适配器模型
---

Paperclip 是一个由四个主要数据层组成的单体仓库 (monorepo)。

## 技术栈概览

```
┌─────────────────────────────────────┐
│  React UI (Vite)                    │
│  控制面板、组织管理、任务看板       │
├─────────────────────────────────────┤
│  Express.js REST API (Node.js)      │
│  路由、服务、身份验证、适配器       │
├─────────────────────────────────────┤
│  PostgreSQL (Drizzle ORM)           │
│  数据模式、迁移、嵌入式模式         │
├─────────────────────────────────────┤
│  适配器 (Adapters)                  │
│  Claude Local, Codex Local,         │
│  进程模式, HTTP 模式                │
└─────────────────────────────────────┘
```

## 技术栈列表

| 层级 | 技术 |
|-------|-----------|
| 前端 | React 19, Vite 6, React Router 7, Radix UI, Tailwind CSS 4, TanStack Query |
| 后端 | Node.js 20+, Express.js 5, TypeScript |
| 数据库 | PostgreSQL 17 (或嵌入式的 PGlite), Drizzle ORM |
| Auth 鉴权 | Better Auth (会话支持 + API 密钥支持) |
| 适配器 | Claude Code CLI, Codex CLI, Shell 进程, HTTP webhook |
| 包管理器 | pnpm 9 配合工作区 (workspaces) |

## 仓库结构

```
paperclip/
├── ui/                          # React 前端
│   ├── src/pages/              # 路由页面 (Route pages)
│   ├── src/components/         # React 组件
│   ├── src/api/                # API 客户端
│   └── src/context/            # React context providers
│
├── server/                      # Express.js API 后端
│   ├── src/routes/             # REST 接口端点
│   ├── src/services/           # 业务逻辑服务
│   ├── src/adapters/           # 智能体执行适配器
│   └── src/middleware/         # 中间件（鉴权、日志等）
│
├── packages/
│   ├── db/                      # Drizzle 模式数据表定义和迁移文件
│   ├── shared/                  # 共享 API 类型、常量和验证器
│   ├── adapter-utils/           # 适配器接口和底层相关的辅助函数
│   └── adapters/
│       ├── claude-local/        # Claude Code 适配器
│       └── codex-local/         # OpenAI Codex 适配器
│
├── skills/                      # 智能体技能库
│   └── paperclip/               # 核心 Paperclip 技能 (处理心跳协议)
│
├── cli/                         # 命令行客户端 (CLI)
│   └── src/                     # 安装向导以及控制平面 CLI 命令
│
└── doc/                         # 内部系统设计文档
```

## 请求流程 (Request Flow)

当一次心跳事件触发时：

1. **触发唤醒 (Trigger)** — 调度器、管理员手动调用、或者系统事件（如分配任务、@提及等）触发了一次心跳
2. **适配器调用 (Adapter invocation)** — 服务器调用所配置智能体适配器的 `execute()` 执行函数
3. **智能体进程 (Agent process)** — 适配器启动该智能体的运行时（例如运行 Claude Code CLI），并附带注入 Paperclip 专有的环境变量与起始提示词 (prompt)
4. **智能体执行工作 (Agent work)** — 智能体运行过程中调用 Paperclip 的 REST API，来检查自己的任务分配、签出认领任务、执行相关指令并更新其状态
5. **结果捕获 (Result capture)** — 当运行时结束，适配器捕获它的标准输出 (stdout)，解析消耗的 Token 数据及成本统计，并提取对话的会话状态 (session state)
6. **运行记录 (Run record)** — 服务器把此次运行的结果、产生的成本，以及会话状态保存下来，以备下一次心跳使用

## 适配器模型 (Adapter Model)

适配器 (Adapters) 是连接 Paperclip 与各种智能体大模型运行时的主要桥梁。每个适配器都是一个包含了以下三个模块的包：

- **Server 模块** — 包含生成/调用智能体并在沙盒内设置环境变量等前置诊断步骤的 `execute()` 函数
- **UI 模块** — 用于终端运行查看器 (run viewer) 捕获并解析 stdout 标准输出的地方，并为新建自定义智能体的配置提供相关的表单字段
- **CLI 模块** — 用于为 `paperclipai run --watch` 等终端命令提供的格式化输出模块

目前内置已支持的适配器：`claude_local`, `codex_local`, `process`, `http`。如果您有特殊的运行环境，还可以为其开发编写任何自定义适配器。

## 关键架构决策 (Key Design Decisions)

- **是控制平面，而不是执行平面** — Paperclip 的核心作用是“统筹编排”各路智能体，它本身并不实际运行甚至生成智能体
- **基于公司范围** — 所有的实体/模块都只隶属于某一个具体的公司 (Company)；由此强制实施严格的数据隔离边界
- **仅单人分配任务 (Single-assignee tasks)** — 为了防止工作重叠和状态冲突，独家的原子操作任务签出 (atomic checkout) 逻辑可防止多个并发请求认领同一个任务
- **不依赖具体的适配器 (Adapter-agnostic)** — 简而言之，任何能够调用 HTTP API 的运行环境都可以充当智能体
- **默认开箱即用 (Embedded by default)** — 依托于嵌入式 PostgreSQL（即 PGlite），实现环境零配置启动
