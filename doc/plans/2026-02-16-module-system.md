# Paperclip 模块系统

> 替代说明：本文档中关于公司模板/包格式的方向已不再是当前方案。当前基于 markdown 的公司导入/导出计划请参阅 `doc/plans/2026-03-13-company-import-export-v2.md` 和 `docs/companies/companies-spec.md`。

## 概述

Paperclip 的模块系统允许你在不 fork 核心代码的情况下，通过新功能扩展控制平面——包括收入跟踪、可观测性、通知、仪表盘等。模块是自包含的包，可以注册路由、UI 页面、数据库表和生命周期钩子。

另外，**公司模板**是无代码的数据包（智能体团队、组织架构、目标层级），你可以导入它们来快速初始化一个新公司。

两者都可以通过**公司商店**进行发现。

---

## 概念

| 概念 | 定义 | 是否包含代码？ |
|---------|-----------|----------------|
| **模块** | 扩展 Paperclip API、UI 和数据模型的包 | 是 |
| **公司模板** | 数据快照——智能体、项目、目标、组织结构 | 否（仅 JSON） |
| **公司商店** | 浏览/安装模块和模板的注册中心 | — |
| **钩子** | 核心中的命名事件，模块可以订阅 | — |
| **插槽** | 只允许一个模块处于活跃状态的排他类别（例如 `observability`） | — |

---

## 模块架构

### 文件结构

```
modules/
  observability/
    paperclip.module.json     # 清单文件（必需）
    src/
      index.ts                # 入口点——导出 register 函数
      routes.ts               # Express 路由器
      hooks.ts                # 钩子处理器
      schema.ts               # Drizzle 表定义
      migrations/             # SQL 迁移（由 drizzle-kit 生成）
      ui/                     # React 组件（由 shell 延迟加载）
        index.ts              # 导出页面/组件定义
        TokenDashboard.tsx
```

模块位于顶层 `modules/` 目录中。每个模块是一个 pnpm 工作区包。

### 清单文件（`paperclip.module.json`）

```json
{
  "id": "observability",
  "name": "Observability",
  "description": "Token tracking, cost metrics, and agent performance instrumentation",
  "version": "0.1.0",
  "author": "paperclip",

  "slot": "observability",

  "hooks": [
    "agent:heartbeat",
    "agent:created",
    "issue:status_changed",
    "budget:threshold_crossed"
  ],

  "routes": {
    "prefix": "/observability",
    "entry": "./src/routes.ts"
  },

  "ui": {
    "pages": [
      {
        "path": "/observability",
        "label": "Observability",
        "entry": "./src/ui/index.ts"
      }
    ],
    "widgets": [
      {
        "id": "token-burn-rate",
        "label": "Token Burn Rate",
        "placement": "dashboard",
        "entry": "./src/ui/index.ts"
      }
    ]
  },

  "schema": "./src/schema.ts",

  "configSchema": {
    "type": "object",
    "properties": {
      "retentionDays": { "type": "number", "default": 30 },
      "enablePrometheus": { "type": "boolean", "default": false },
      "prometheusPort": { "type": "number", "default": 9090 }
    }
  },

  "requires": {
    "core": ">=0.1.0"
  }
}
```

关键字段：

- **`id`**：唯一标识符，用作 npm 包名后缀（`@paperclipai/mod-observability`）
- **`slot`**：可选的排他类别。如果设置了，同一插槽只能有一个模块处于活跃状态。如果模块可以自由共存则省略。
- **`hooks`**：该模块订阅的核心事件。预先声明以便核心知道需要发出什么事件。
- **`routes.prefix`**：挂载在 `/api/modules/<prefix>` 下。该模块拥有这个命名空间。
- **`ui.pages`**：在侧边栏添加条目。延迟加载的 React 组件。
- **`ui.widgets`**：将组件注入到现有页面中（例如仪表盘卡片）。
- **`schema`**：模块自有表的 Drizzle 表定义。以 `mod_<id>_` 为前缀以避免冲突。
- **`configSchema`**：模块配置的 JSON Schema。在模块加载前进行验证。

### 入口点

模块的 `src/index.ts` 导出一个 `register` 函数，该函数接收模块 API：

```typescript
import type { ModuleAPI } from "@paperclipai/core";
import { createRouter } from "./routes.js";
import { onHeartbeat, onBudgetThreshold } from "./hooks.js";

export default function register(api: ModuleAPI) {
  // 注册路由处理器
  api.registerRoutes(createRouter(api.db, api.config));

  // 订阅钩子
  api.on("agent:heartbeat", onHeartbeat);
  api.on("budget:threshold_crossed", onBudgetThreshold);

  // 注册后台服务（可选）
  api.registerService({
    name: "metrics-aggregator",
    interval: 60_000, // 每 60 秒运行一次
    async run(ctx) {
      await aggregateMetrics(ctx.db);
    },
  });
}
```

### 模块 API 接口

```typescript
interface ModuleAPI {
  // 身份标识
  moduleId: string;
  config: Record<string, unknown>;  // 已通过 configSchema 验证

  // 数据库
  db: Db;                           // 共享的 Drizzle 客户端

  // 路由
  registerRoutes(router: Router): void;

  // 钩子
  on(event: HookEvent, handler: HookHandler): void;

  // 后台服务
  registerService(service: ServiceDef): void;

  // 日志（按模块作用域）
  logger: Logger;

  // 访问核心服务（只读辅助器）
  core: {
    agents: AgentService;
    issues: IssueService;
    projects: ProjectService;
    goals: GoalService;
    activity: ActivityService;
  };
}
```

模块获得一个作用域日志器、共享数据库的访问权限以及核心服务的只读访问。它们注册自己的路由和钩子处理器。它们不会修改核心——而是通过定义好的接口进行扩展。

---

## 钩子系统

### 核心钩子点

钩子是主要的集成点。核心在明确定义的时刻发出事件。模块在其 `register` 函数中订阅。

| 钩子 | 负载 | 触发时机 |
|------|---------|------|
| `server:started` | `{ port }` | Express 服务器开始监听后 |
| `agent:created` | `{ agent }` | 新智能体插入后 |
| `agent:updated` | `{ agent, changes }` | 智能体记录被修改后 |
| `agent:deleted` | `{ agent }` | 智能体被删除后 |
| `agent:heartbeat` | `{ agentId, timestamp, meta }` | 智能体签到时。`meta` 携带 tokens_used、cost、latency 等 |
| `agent:status_changed` | `{ agent, from, to }` | 智能体状态转换时（idle→active、active→error 等） |
| `issue:created` | `{ issue }` | 新任务插入后 |
| `issue:status_changed` | `{ issue, from, to }` | 任务在状态之间移动时 |
| `issue:assigned` | `{ issue, agent }` | 任务被分配给智能体时 |
| `goal:created` | `{ goal }` | 新目标插入后 |
| `goal:completed` | `{ goal }` | 目标状态变为完成时 |
| `budget:spend_recorded` | `{ agentId, amount, total }` | 支出增加后 |
| `budget:threshold_crossed` | `{ agentId, budget, spent, percent }` | 智能体超过预算的 80%、90% 或 100% 时 |

### 钩子执行模型

```typescript
// 核心中的钩子发射器
class HookBus {
  private handlers = new Map<string, HookHandler[]>();

  register(event: string, handler: HookHandler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: string, payload: unknown) {
    const handlers = this.handlers.get(event) ?? [];
    // 并发运行所有处理器。失败会被记录，永远不会阻塞核心。
    await Promise.allSettled(
      handlers.map(h => h(payload))
    );
  }
}
```

设计规则：
- **钩子是触发后即忘的。** 失败的钩子处理器永远不会使核心操作崩溃或阻塞。
- **钩子是并发的。** 一个事件的所有处理器通过 `Promise.allSettled` 并行运行。
- **钩子是提交后的。** 它们在数据库写入成功后触发，而不是之前。不支持否决。
- **钩子接收不可变快照。** 处理器获得数据的副本，而不是可变引用。

这保持了核心的快速和弹性。如果你需要提交前验证（例如"拒绝此预算更改"），那是一个不同的机制（中间件/拦截器），我们可以在需要时再添加。

### 可观测性钩子示例

```typescript
// modules/observability/src/hooks.ts
import type { Db } from "@paperclipai/db";
import { tokenMetrics } from "./schema.js";

export function createHeartbeatHandler(db: Db) {
  return async (payload: {
    agentId: string;
    timestamp: Date;
    meta: { tokensUsed?: number; costCents?: number; model?: string };
  }) => {
    const { agentId, timestamp, meta } = payload;

    if (meta.tokensUsed != null) {
      await db.insert(tokenMetrics).values({
        agentId,
        tokensUsed: meta.tokensUsed,
        costCents: meta.costCents ?? 0,
        model: meta.model ?? "unknown",
        recordedAt: timestamp,
      });
    }
  };
}
```

每次心跳，可观测性模块将 token 使用情况记录到其自有的 `mod_observability_token_metrics` 表中。核心不知道也不关心这个表——它只是发出钩子。

---

## 模块的数据库策略

### 表命名空间

模块表以 `mod_<moduleId>_` 为前缀，以避免与核心表和其他模块冲突：

```typescript
// modules/observability/src/schema.ts
import { pgTable, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";

export const tokenMetrics = pgTable("mod_observability_token_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  tokensUsed: integer("tokens_used").notNull(),
  costCents: integer("cost_cents").notNull().default(0),
  model: text("model").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertRules = pgTable("mod_observability_alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id"),
  metricName: text("metric_name").notNull(),
  threshold: integer("threshold").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### 迁移策略

每个模块在 `src/migrations/` 中管理自己的迁移。核心迁移运行器会发现并应用它们：

1. 核心迁移始终先运行
2. 模块迁移按依赖顺序运行
3. 每个模块的迁移在 `mod_migrations` 表中按模块 ID 跟踪
4. `pnpm db:migrate` 运行所有迁移。`pnpm db:migrate --module observability` 运行单个模块。

模块可以通过外键引用核心表（例如 `agent_id → agents.id`），但核心表永远不引用模块表。这是严格的单向依赖。

---

## 模块加载与生命周期

### 发现

服务器启动时：

```
1. 扫描 modules/ 目录中的 paperclip.module.json 清单文件
2. 验证每个清单（对 configSchema 和必填字段进行 JSON Schema 检查）
3. 检查插槽冲突（如果两个活跃模块声明了相同插槽则报错）
4. 按依赖关系进行拓扑排序（如果模块 A 依赖模块 B）
5. 按顺序对每个模块：
   a. 根据 configSchema 验证模块配置
   b. 运行待处理的迁移
   c. 导入入口点并调用 register(api)
   d. 在 /api/modules/<prefix> 挂载路由
   e. 启动后台服务
6. 发出 server:started 钩子
```

### 配置

模块配置存储在服务器的环境变量或配置文件中：

```jsonc
// paperclip.config.json（或环境变量）
{
  "modules": {
    "enabled": ["observability", "revenue", "notifications"],
    "config": {
      "observability": {
        "retentionDays": 90,
        "enablePrometheus": true
      },
      "revenue": {
        "stripeSecretKey": "$STRIPE_SECRET_KEY"
      }
    }
  }
}
```

`$ENV_VAR` 引用在加载时解析。密钥永远不直接放在配置文件中。

### 禁用模块

将模块的启用状态设置为 false：
1. 停止其后台服务
2. 卸载其路由（返回 404）
3. 取消其钩子处理器的订阅
4. 不会删除其数据库表（数据被保留）

---

## UI 集成

### 模块 UI 工作原理

核心 UI shell 提供：
- 一个侧边栏，包含模块贡献的导航项的插槽
- 一个仪表盘，包含组件挂载点
- 一个模块设置页面

模块在清单中声明页面和组件。shell 延迟加载它们：

```typescript
// ui/src/modules/loader.ts
// 在构建时或运行时，发现模块 UI 入口并创建延迟路由

import { lazy } from "react";

// 从清单生成
export const modulePages = [
  {
    path: "/observability",
    label: "Observability",
    component: lazy(() => import("@paperclipai/mod-observability/ui")),
  },
];

export const dashboardWidgets = [
  {
    id: "token-burn-rate",
    label: "Token Burn Rate",
    placement: "dashboard",
    component: lazy(() => import("@paperclipai/mod-observability/ui").then(m => ({ default: m.TokenBurnRateWidget }))),
  },
];
```

### 模块 UI 契约

模块的 UI 入口导出命名组件：

```typescript
// modules/observability/src/ui/index.ts
export { default } from "./ObservabilityPage";
export { TokenBurnRateWidget } from "./TokenBurnRateWidget";
```

模块 UI 组件接收标准 props 接口：

```typescript
interface ModulePageProps {
  moduleId: string;
  config: Record<string, unknown>;
}

interface ModuleWidgetProps {
  moduleId: string;
  config: Record<string, unknown>;
  className?: string;
}
```

模块 UI 通过模块自身的 API 路由（`/api/modules/observability/*`）获取数据。

---

## 公司模板

### 格式

公司模板是描述完整公司结构的 JSON 文件：

```json
{
  "id": "startup-in-a-box",
  "name": "Startup in a Box",
  "description": "A 5-agent startup team with engineering, product, and ops",
  "version": "1.0.0",
  "author": "paperclip",

  "agents": [
    {
      "ref": "ceo",
      "name": "CEO Agent",
      "role": "pm",
      "budgetCents": 100000,
      "metadata": { "responsibilities": "Strategy, fundraising, hiring" }
    },
    {
      "ref": "eng-lead",
      "name": "Engineering Lead",
      "role": "engineer",
      "reportsTo": "ceo",
      "budgetCents": 50000
    },
    {
      "ref": "eng-1",
      "name": "Engineer",
      "role": "engineer",
      "reportsTo": "eng-lead",
      "budgetCents": 30000
    },
    {
      "ref": "designer",
      "name": "Designer",
      "role": "designer",
      "reportsTo": "ceo",
      "budgetCents": 20000
    },
    {
      "ref": "ops",
      "name": "Ops Agent",
      "role": "devops",
      "reportsTo": "ceo",
      "budgetCents": 20000
    }
  ],

  "goals": [
    {
      "ref": "north-star",
      "title": "Launch MVP",
      "level": "company"
    },
    {
      "ref": "build-product",
      "title": "Build the product",
      "level": "team",
      "parentRef": "north-star",
      "ownerRef": "eng-lead"
    },
    {
      "ref": "design-brand",
      "title": "Establish brand identity",
      "level": "agent",
      "parentRef": "north-star",
      "ownerRef": "designer"
    }
  ],

  "projects": [
    {
      "ref": "mvp",
      "name": "MVP",
      "description": "The first shippable version"
    }
  ],

  "issues": [
    {
      "title": "Set up CI/CD pipeline",
      "status": "todo",
      "priority": "high",
      "projectRef": "mvp",
      "assigneeRef": "ops",
      "goalRef": "build-product"
    },
    {
      "title": "Design landing page",
      "status": "todo",
      "priority": "medium",
      "projectRef": "mvp",
      "assigneeRef": "designer",
      "goalRef": "design-brand"
    }
  ]
}
```

模板使用 `ref` 字符串（而非 UUID）进行内部交叉引用。导入时，系统将 ref 映射到生成的 UUID。

### 导入流程

```
1. 解析并验证模板 JSON
2. 检查 ref 唯一性和悬空引用
3. 插入智能体（按 reportsTo 进行拓扑排序）
4. 插入目标（按 parentRef 进行拓扑排序）
5. 插入项目
6. 插入任务（将 projectRef、assigneeRef、goalRef 解析为真实 ID）
7. 为所有创建的内容记录活动事件
```

### 导出流程

你也可以将运行中的公司导出为模板：

```
GET /api/templates/export → 下载当前公司为模板 JSON
```

这使得公司可以共享和克隆。

---

## 公司商店

公司商店是发现和安装模块及模板的注册中心。在 v1 中，它是一个带有 JSON 索引的精选 GitHub 仓库。之后可以发展为托管服务。

### 索引格式

```json
{
  "modules": [
    {
      "id": "observability",
      "name": "Observability",
      "description": "Token tracking, cost metrics, and agent performance",
      "repo": "github:paperclip/mod-observability",
      "version": "0.1.0",
      "tags": ["metrics", "monitoring", "tokens"]
    }
  ],
  "templates": [
    {
      "id": "startup-in-a-box",
      "name": "Startup in a Box",
      "description": "5-agent startup team",
      "url": "https://store.paperclip.ing/templates/startup-in-a-box.json",
      "tags": ["startup", "team"]
    }
  ]
}
```

### CLI 命令

```bash
pnpm paperclipai store list                    # 浏览可用的模块和模板
pnpm paperclipai store install <module-id>     # 安装模块
pnpm paperclipai store import <template-id>    # 导入公司模板
pnpm paperclipai store export                  # 将当前公司导出为模板
```

---

## 候选模块

### 第一梯队——优先构建（核心扩展）

| 模块 | 功能 | 关键钩子 |
|--------|-------------|-----------|
| **可观测性** | Token 使用跟踪、成本指标、智能体性能仪表盘、Prometheus 导出 | `agent:heartbeat`、`budget:spend_recorded` |
| **收入跟踪** | 连接 Stripe/加密钱包、跟踪收入、根据智能体成本显示损益表 | `budget:spend_recorded` |
| **通知** | Slack/Discord/邮件告警，支持可配置触发器 | 所有钩子（可配置） |

### 第二梯队——高价值

| 模块 | 功能 | 关键钩子 |
|--------|-------------|-----------|
| **分析仪表盘** | 消耗率趋势、智能体利用率、目标速度图表 | `agent:heartbeat`、`issue:status_changed`、`goal:completed` |
| **工作流自动化** | If/then 规则："当任务完成时创建后续任务"、"当预算达到 90% 时暂停智能体" | `issue:status_changed`、`budget:threshold_crossed` |
| **知识库** | 共享文档存储、向量搜索、智能体读写组织知识 | `agent:heartbeat`（用于上下文注入） |

### 第三梯队——锦上添花

| 模块 | 功能 | 关键钩子 |
|--------|-------------|-----------|
| **审计与合规** | 不可变审计记录、审批工作流、支出授权 | 所有写入钩子 |
| **智能体日志/回放** | 每个智能体的完整执行轨迹、逐 token 回放 | `agent:heartbeat` |
| **多租户** | 在一个 Paperclip 实例中分离公司/组织 | `server:started` |

---

## 实施计划

### 第一阶段：核心基础设施

添加到 `@paperclipai/server`：

1. **HookBus** ——使用 `Promise.allSettled` 的事件发射器，包含 `register()` 和 `emit()`
2. **模块加载器** ——扫描 `modules/`，验证清单，调用 `register(api)`
3. **模块 API 对象** ——`registerRoutes()`、`on()`、`registerService()`、日志器、核心服务访问
4. **模块配置** ——`paperclip.config.json`，包含每个模块的配置和环境变量插值
5. **模块迁移运行器** ——扩展 `db:migrate` 以发现和运行模块迁移
6. **从核心服务发出钩子** ——在现有 CRUD 操作中添加 `hookBus.emit()` 调用

添加到 `@paperclipai/ui`：

7. **模块页面加载器** ——读取模块清单，生成延迟路由
8. **仪表盘组件插槽** ——在仪表盘页面上渲染模块贡献的组件
9. **侧边栏扩展** ——动态添加模块导航项

添加新包：

10. **`@paperclipai/module-sdk`** ——`ModuleAPI`、`HookEvent`、`HookHandler` 和清单 schema 的 TypeScript 类型

### 第二阶段：第一个模块（可观测性）

11. 构建 `modules/observability` 作为参考实现
12. Token 指标表 + 迁移
13. 心跳钩子处理器记录 token 使用
14. 仪表盘组件显示消耗率
15. 查询指标的 API 路由

### 第三阶段：模板

16. 模板导入端点（`POST /api/templates/import`）
17. 模板导出端点（`GET /api/templates/export`）
18. 第一个模板："Startup in a Box"

### 第四阶段：公司商店

19. 基于 GitHub 的商店索引
20. 浏览/安装/导入的 CLI 命令
21. 浏览商店的 UI 页面

---

## 设计原则

1. **模块扩展，从不修改。** 模块添加新的路由、表和钩子处理器。它们永远不修改核心表或覆盖核心路由。

2. **钩子是提交后的、触发即忘的。** 模块失败永远不会破坏核心操作。

3. **单向依赖。** 模块依赖核心。核心永远不依赖模块。模块表可以外键指向核心表，反之不行。

4. **声明式清单，命令式注册。** 静态元数据在 JSON 中（无需运行代码即可验证）。运行时行为通过 API 注册。

5. **命名空间隔离。** 模块路由位于 `/api/modules/<id>/` 下。模块表以 `mod_<id>_` 为前缀。模块配置按其 ID 作用域。

6. **优雅降级。** 如果模块加载失败，记录错误并继续。系统其余部分正常工作。

7. **数据在禁用后存续。** 禁用模块会停止其代码但保留其数据。重新启用后从中断处继续。
