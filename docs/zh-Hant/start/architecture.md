---
title: 建築學
summary: 堆疊概述、請求流程和適配器模型
---
Paperclip 是一個具有四個主要層的單一儲存庫。

## 堆疊概述

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

## 技術堆疊

|層|技術 |
|-------|-----------|
|前端 | React 19、Vite 6、React 路由器 7、Radix UI、Tailwind CSS 4、TanStack 查詢 |
|後端| Node.js 20+、Express.js 5、TypeScript |
|資料庫| PostgreSQL 17（或嵌入式PGlite），Drizzle ORM |
|授權 |更好的身份驗證（會話 + API 金鑰）|
|適配器| Claude Code CLI、Codex CLI、shell 進程、HTTP webhook |
|套件管理器 | pnpm 9 與工作區 |

## 儲存庫結構

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

## 請求流程

當心跳激發時：

1. **觸發器** — 調度程序、手動呼叫或事件（分配、提及）觸發心跳
2. **適配器呼叫**——伺服器呼叫配置的適配器的`execute()`函數
3. **智能體程式流程** - 適配器使用 Paperclip 環境變數和提示產生智能體程式（例如 Claude Code CLI）
4. **智能體工作** — 智能體呼叫Paperclip的REST API檢查作業、結帳任務、做工作、更新狀態
5. **結果擷取** - 適配器擷取標準輸出，解析使用/成本數據，擷取會話狀態
6. **運行記錄** — 伺服器記錄運行結果、成本以及下一次心跳的任何會話狀態

## 轉接器型號

適配器是 Paperclip 和智能體程式運作時之間的橋樑。每個適配器都是一個包含三個模組的套件：

- **伺服器模組** — `execute()` 產生/呼叫智能體的函數，以及環境診斷
- **UI 模組** — 用於執行檢視器的標準輸出解析器，用於建立智能體程式的設定表單字段
- **CLI 模組** — `paperclipai run --watch` 的終端格式化程式

內建轉接器：`claude_local`、`codex_local`、`process`、`http`。您可以為任何運行時建立自訂適配器。

## 關鍵設計決策

- **控制平面，而不是執行平面** - Paperclip 協調智能體；它不運行它們
- **公司範圍** — 所有實體都屬於一家公司；嚴格的資料邊界
- **單受讓人任務** — 原子結帳可防止同一任務上的同時工作
- **與適配器無關** — 任何可以呼叫 HTTP API 的運行時都可以充當智能體
- **預設嵌入** — 具有嵌入式 PostgreSQL 的零配置本機模式