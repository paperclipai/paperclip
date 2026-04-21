# Paperclip 二次开发完整指南

> 生成时间：2026-04-04 | 基于 master 分支代码扫描 + 所有 doc/ 和 docs/ 文档综合整理

---

## 一、项目定位

**Paperclip 是一个 AI Agent 公司的控制平面（Control Plane）**，本质是一个**多 Agent 协同工作的任务调度与治理系统**。

类比：Paperclip 之于 AI Agent 公司，就像操作系统之于计算机 —— 它不直接"运行" Agent，而是**编排、调度、监控、治理** Agent 的运行。

### 核心能力

| 能力 | 描述 |
|------|------|
| Agent 组织管理 | 创建 Agent 员工、设置汇报关系、维护 Org Chart |
| 任务系统 | 分层 Issue 管理、原子化任务签出、状态机流转 |
| 心跳调度 | 定时/事件触发 Agent 执行，管理 AgentRun 全生命周期 |
| 成本管控 | Token 消耗追踪、月度预算、超额强制暂停 |
| 审批治理 | 雇员审批、CEO 策略审批、Board 人工干预 |
| 多适配器 | 支持 Claude Code、Codex、OpenCode、Hermes、Cursor、Process、HTTP 等 |

---

## 二、推荐阅读路线（按优先级排序）

### 第一轮：建立产品认知（1小时）

```
doc/GOAL.md                  → 项目使命和愿景（3分钟，必读）
doc/PRODUCT.md               → 产品定义、设计原则（10分钟，必读）
docs/start/core-concepts.md  → 六大核心概念详解（5分钟）
docs/start/architecture.md   → 技术架构概览（5分钟）
```

### 第二轮：了解数据合约（2小时）

```
doc/SPEC-implementation.md   → V1 完整实现规约（重点：第7节数据模型、第10节API合约、第11节心跳合约）
doc/DATABASE.md              → 数据库配置与 Schema 管理
docs/api/issues.md           → Issues API 完整文档（最复杂的核心实体）
docs/api/agents.md           → Agents API
docs/api/approvals.md        → 审批 API
```

### 第三轮：了解适配器系统（1小时）

```
docs/adapters/overview.md              → 适配器架构总览
docs/adapters/creating-an-adapter.md   → 创建自定义适配器
packages/adapters/opencode-local/src/  → 参考实现（最完整）
packages/adapters/claude-local/src/    → 另一个参考实现
```

### 第四轮：前端开发（1小时）

```
ui/src/pages/                           → 所有页面组件（41个路由页面）
ui/src/components/OnboardingWizard.tsx  → 安装向导（最复杂的 UI 组件）
ui/src/components/AgentConfigForm.tsx   → Agent 配置表单（核心配置 UI）
ui/src/adapters/                        → 各适配器的 UI 模块
```

### 第五轮：本地开发工作流

```
doc/DEVELOPING.md   → 完整开发环境搭建
AGENTS.md           → 代码贡献规范（AI 辅助开发时必读）
```

---

## 三、技术栈全景

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + Vite 6 + React Router 7 + Radix UI + Tailwind CSS 4 + TanStack Query |
| **后端** | Node.js 20+ + Express.js 5 + TypeScript |
| **数据库** | PostgreSQL 17（或嵌入式 PGlite）+ Drizzle ORM |
| **认证** | Better Auth（Session + API Key 双模式） |
| **包管理** | pnpm 9 + Workspaces monorepo |

**重要特点**：
- 零配置启动：不设 DATABASE_URL 时自动使用内嵌 PGlite，数据存于 `~/.paperclip/instances/default/db/`
- Monorepo 结构：server / ui / packages 三大域，通过 pnpm workspace 共享代码
- TypeScript 全栈：所有层都是 TS，类型共享通过 packages/shared 实现

---

## 四、目录结构详解

```
paperclip/
├── server/                    ← Express REST API
│   └── src/
│       ├── routes/            ← 所有 HTTP 路由（核心：agents.ts、issues.ts、access.ts）
│       ├── services/          ← 业务逻辑服务层
│       ├── adapters/          ← 适配器注册表（registry.ts 是入口）
│       └── middleware/        ← 认证、日志中间件
│
├── ui/                        ← React 前端
│   └── src/
│       ├── pages/             ← 路由页面（41个页面文件）
│       ├── components/        ← 公共组件（OnboardingWizard.tsx、AgentConfigForm.tsx 最重要）
│       ├── adapters/          ← 适配器 UI 模块（每个适配器一个子目录）
│       ├── api/               ← API 客户端（agents.ts、issues.ts 等）
│       ├── context/           ← React Context（CompanyContext 等）
│       └── lib/               ← 工具函数
│
├── packages/
│   ├── db/                    ← Drizzle Schema + 迁移
│   │   └── src/schema/        ← 所有表定义（*.ts）
│   ├── shared/                ← 前后端共享：类型、常量、校验器、API 路径
│   ├── adapter-utils/         ← 适配器基础工具库（所有适配器都依赖）
│   ├── adapters/              ← 各适配器实现包
│   │   ├── claude-local/
│   │   ├── codex-local/
│   │   ├── opencode-local/    ← 最完整的适配器，适合参考
│   │   ├── gemini-local/
│   │   ├── cursor-local/
│   │   ├── pi-local/
│   │   └── openclaw-gateway/
│   └── plugins/               ← 插件系统包
│
├── cli/                       ← 命令行工具（paperclipai CLI）
├── skills/                    ← Agent 技能文件（心跳协议等）
├── doc/                       ← 内部工程文档
└── docs/                      ← 公开用户文档（面向外部）
```

---

## 五、核心数据模型

### 实体关系

```
Company（公司）
  ├── Goal（目标，可多级嵌套）
  ├── Project（项目）
  │     └── Issue（任务，可嵌套）
  │           ├── IssueComment（评论）
  │           ├── IssueDocument（文档，如 plan/design/notes）
  │           └── IssueAttachment（附件）
  ├── Agent（AI 员工）
  │     ├── reportsTo → Agent（汇报关系，形成 Org Tree）
  │     ├── AgentApiKey（API 密钥）
  │     └── HeartbeatRun（执行记录）
  ├── Approval（审批单）
  ├── CostEvent（费用事件）
  ├── ActivityLog（操作日志）
  ├── CompanySecret（公司密钥）
  └── Asset（文件资产）
```

### Agent 核心字段

```typescript
{
  id, companyId, name, role,
  status: 'active' | 'paused' | 'idle' | 'running' | 'error' | 'terminated',
  reportsTo: string | null,    // 上级 Agent ID，null 为根（CEO）
  adapterType: string,         // 适配器类型（如 claude_local）
  adapterConfig: object,       // 适配器配置（JSON）
  budgetMonthlyCents: number,  // 月预算（单位：分）
  runtimeConfig: {             // 心跳策略配置
    heartbeat: {
      enabled: boolean,
      intervalSec: number,     // 最小 30 秒
      wakeOnDemand: boolean
    }
  }
}
```

### Issue 核心字段

```typescript
{
  id, companyId,
  parentId: string | null,     // 支持层级嵌套
  projectId, goalId,
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled',
  priority: 'critical' | 'high' | 'medium' | 'low',
  assigneeAgentId: string | null,  // 单一指派人（原子签出保证）
}
```

---

## 六、状态机

### Agent 状态流转

```
idle → running → idle
     → error → idle
idle/running → paused → idle
任意 → terminated（不可逆，Board Only）
```

### Issue 状态流转

```
backlog → todo → in_progress → in_review → done
                      ↓              ↓
                   blocked ← ───────┘
                      ↓
                     todo
任意状态 → cancelled（终止态）
```

**原子签出**：`in_progress` 通过单条 SQL UPDATE（WHERE 包含状态约束）实现并发安全，失败返回 `409 Conflict`，**绝对不要重试 409**。

---

## 七、REST API 核心接口

### 公司管理

```http
GET    /api/companies
POST   /api/companies
GET    /api/companies/:id
PATCH  /api/companies/:id
POST   /api/companies/:id/archive
```

### Agent 管理

```http
GET    /api/companies/:companyId/agents
POST   /api/companies/:companyId/agents
GET    /api/agents/:id
GET    /api/agents/me                        ← Agent 自查身份
PATCH  /api/agents/:id
POST   /api/agents/:id/pause
POST   /api/agents/:id/resume
POST   /api/agents/:id/terminate             ← 不可逆
POST   /api/agents/:id/heartbeat/invoke      ← 手动触发心跳
POST   /api/agents/:id/keys                  ← 创建 API Key

GET    /api/companies/:cid/adapters/:type/models        ← 查询可用模型
POST   /api/companies/:cid/adapters/:type/test-environment ← 测试环境
```

### 任务管理（Issues）

```http
GET    /api/companies/:cid/issues            ← 支持 status/assigneeAgentId/projectId 过滤
POST   /api/companies/:cid/issues
GET    /api/issues/:id
PATCH  /api/issues/:id
POST   /api/issues/:id/checkout              ← 原子签出（Agent 专用）
POST   /api/issues/:id/release               ← 释放签出
POST   /api/issues/:id/comments
GET    /api/issues/:id/comments
PUT    /api/issues/:id/documents/:key        ← key: plan/design/notes 等
GET    /api/issues/:id/documents/:key
```

### 审批系统

```http
GET    /api/companies/:cid/approvals?status=pending
POST   /api/companies/:cid/approvals
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/reject
```

### 成本系统

```http
POST   /api/companies/:cid/cost-events       ← 上报 Token 消耗（Agent 调用）
GET    /api/companies/:cid/costs/summary
GET    /api/companies/:cid/costs/by-agent
```

### 错误码规范

| 状态码 | 含义 |
|--------|------|
| 400 | 参数校验失败 |
| 401 | 未认证 |
| 403 | 未授权 |
| 404 | 资源不存在 |
| 409 | 状态冲突（签出冲突等） |
| 422 | 语义约束违反 |
| 500 | 服务器错误 |

---

## 八、适配器系统详解

### 适配器三层架构

```
packages/adapters/<name>/src/
  index.ts              ← 共享元数据（type、label、models）
  server/
    execute.ts          ← 核心执行逻辑（调用 CLI 或 HTTP）
    test.ts             ← 环境诊断
    models.ts           ← 模型发现（可选，动态发现）
  ui/
    build-config.ts     ← 表单值 → adapterConfig JSON
    parse-stdout.ts     ← stdout → TranscriptEntry[]（run viewer）
  cli/
    format-event.ts     ← 终端格式化（paperclipai run --watch）
```

### 已内置适配器

| 适配器 | type 键 | 说明 |
|--------|---------|------|
| Claude Local | `claude_local` | 本地 Claude Code CLI |
| Codex Local | `codex_local` | 本地 OpenAI Codex CLI |
| Gemini Local | `gemini_local` | 本地 Gemini CLI |
| OpenCode Local | `opencode_local` | 多 Provider CLI（provider/model 格式） |
| Hermes Local | `hermes_local` | 本地 Hermes CLI，自动发现模型 |
| Cursor | `cursor` | 本地 Cursor 后台模式 |
| Pi Local | `pi_local` | 内嵌 Pi agent |
| OpenClaw Gateway | `openclaw_gateway` | WebSocket 连接远程 OpenClaw |
| Process | `process` | 执行任意 Shell 命令 |
| HTTP | `http` | Webhook 调用外部 Agent |

### 三个注册表（新适配器必须同时注册）

1. `server/src/adapters/registry.ts` → 服务端执行
2. `ui/src/adapters/registry.ts` → 前端 UI
3. `cli/src/adapters/registry.ts` → CLI 输出

### adapterConfig 通用字段

```json
{
  "command": "claude",
  "cwd": "/path/to/project",
  "env": {
    "MY_KEY": { "type": "plain", "value": "xxx" },
    "API_KEY": { "type": "secret_ref", "secretId": "uuid" }
  },
  "timeoutSec": 900,
  "graceSec": 15,
  "model": "claude-sonnet-4",
  "instructionsFilePath": "/path/to/AGENTS.md",
  "promptTemplate": "...",
  "dangerouslySkipPermissions": true
}
```

---

## 九、前端组件关键索引

### 核心页面（ui/src/pages/）

| 文件 | 功能 |
|------|------|
| `NewAgent.tsx` | 新建 Agent |
| `AgentDetail.tsx` | Agent 详情（162KB，最大页面） |
| `IssueDetail.tsx` | Issue 详情（含文档/评论/附件） |
| `CompanyImport.tsx` | 导入 Agent Company Package |
| `Costs.tsx` | 成本仪表盘 |
| `Approvals.tsx` | 审批管理 |

### 核心组件（ui/src/components/）

| 文件 | 说明 |
|------|------|
| `OnboardingWizard.tsx` | 首次安装向导（4步骤） |
| `AgentConfigForm.tsx` | Agent 配置表单（新建和编辑共用） |
| `Layout.tsx` | 全局布局 |
| `CompanyRail.tsx` | 公司切换栏 |
| `JsonSchemaForm.tsx` | 通用 JSON Schema 表单 |

### 适配器 UI 模块（ui/src/adapters/）

每个适配器目录包含：
- `config-fields.tsx` → 适配器专属配置表单字段
- `index.ts` → 导出 UIAdapterModule

---

## 十、数据库操作

### 修改 Schema 的标准流程

```sh
# 1. 编辑 packages/db/src/schema/*.ts
# 2. 确保新表在 packages/db/src/schema/index.ts 中导出
# 3. 生成迁移文件
pnpm db:generate
# 4. 类型检查
pnpm -r typecheck
```

### 三种数据库模式

| 模式 | DATABASE_URL | 数据位置 |
|------|-------------|---------|
| 嵌入式 PGlite（默认） | 不设置 | `~/.paperclip/instances/default/db/` |
| 本地 Docker PostgreSQL | `postgres://...localhost...` | Docker 容器 |
| 托管 PostgreSQL | `postgres://...supabase.com...` | 云端 |

### 常用命令

```sh
pnpm dev                # 启动（自动初始化嵌入式 DB）
pnpm db:migrate         # 手动应用迁移
pnpm db:generate        # 生成迁移文件
rm -rf ~/.paperclip/instances/default/db && pnpm dev   # 重置数据库
```

---

## 十一、认证系统

### 双轨认证

| 主体 | 认证方式 | 权限范围 |
|------|---------|---------|
| Board（人类管理员） | Session（Better Auth） | 全局读写，跨公司管理 |
| Agent（AI 员工） | Bearer API Key（哈希存储） | 仅限本公司 + 自身权限 |

### Agent 权限边界

Agent **可以**：读取本公司 Org/任务/目标、读写已分配任务、创建子任务、上报心跳和费用、申请雇新员工

Agent **不能**：跳过审批门控、直接修改公司预算、操作认证/Key 接口

---

## 十二、心跳协议

### 触发条件

1. **定时器**：按 `heartbeat.intervalSec` 周期触发（最小 30 秒）
2. **任务指派**：新任务分配给 Agent 时立即触发
3. **@提及**：评论中 `@AgentName` 触发
4. **手动**：Board 点击「Invoke」按钮
5. **审批决策**：审批通过/拒绝后触发

### 跳过心跳的条件

- Agent 状态为 `paused` 或 `terminated`
- 当前已有 active 的 Run
- 月度预算已用尽

### Agent 标准工作流程

```
1. GET /agents/me                              → 获取自身身份
2. GET /companies/:id/issues?assigneeAgentId=me → 查看分配任务
3. POST /issues/:id/checkout                   → 原子签出任务（409 不重试）
4. 执行工作（调用外部工具等）
5. POST /issues/:id/comments                   → 进度更新
6. PATCH /issues/:id { status: "done" }        → 标记完成
7. POST /companies/:id/cost-events             → 上报 Token 消耗
```

---

## 十三、密钥/Secrets 系统

Agent `adapterConfig.env` 支持两种值类型：

```json
{
  "env": {
    "PLAIN_VALUE": { "type": "plain", "value": "明文" },
    "SECRET_VALUE": { 
      "type": "secret_ref", 
      "secretId": "uuid", 
      "version": "latest" 
    }
  }
}
```

本地默认 AES 加密，密钥文件：`~/.paperclip/instances/default/secrets/master.key`

严格模式（推荐生产环境）：`PAPERCLIP_SECRETS_STRICT_MODE=true`（强制敏感 Key 必须用 secret_ref）

---

## 十四、二次开发常见场景

### 场景 1：添加新的 AI 适配器

1. 在 `packages/adapters/` 下新建包（参考 `opencode-local` 结构）
2. 实现 `server/execute.ts`、`ui/build-config.ts`、`cli/format-event.ts`
3. 在三个注册表中注册
4. 在 `packages/shared` 中添加新的 adapterType 常量

参考：`docs/adapters/creating-an-adapter.md`

### 场景 2：修改现有 UI 页面

- 页面级：`ui/src/pages/`
- 组件级：`ui/src/components/`
- API 调用通过 `ui/src/api/` 层（不要直接 fetch）
- 全局公司 ID 从 `useCompany()` Context 中获取

### 场景 3：新增 API 端点

1. 在 `server/src/routes/` 找对应路由文件或新建
2. 在 `packages/shared/` 同步更新类型和常量
3. 在 `ui/src/api/` 添加客户端方法
4. **必须**：`assertCompanyAccess()` 确保公司隔离
5. **必须**：写 `activity_log` 记录所有 mutation

### 场景 4：修改 OpenCode 模型选择（放开自选）

关键代码位置：
- **模型发现**：`packages/adapters/opencode-local/src/server/models.ts` `discoverOpenCodeModels()`
- **前端校验**：`ui/src/components/OnboardingWizard.tsx` L425-L455（向导校验）
- **前端校验**：`ui/src/pages/NewAgent.tsx` L153-L179（新建 Agent 校验）
- **服务端校验**：`server/src/routes/agents.ts` `assertAdapterConfigConstraints()`

**放开方案**：
- 在校验中将"必须在发现列表"改为"仅警告不阻断"
- 在 UI 加自由输入框允许手写 `provider/model`
- 服务端可选保留或去除 `ensureOpenCodeModelConfiguredAndAvailable` 强约束

---

## 十五、验证与发布

### 修改后必须通过的检查

```sh
pnpm -r typecheck   # TypeScript 类型检查
pnpm test:run       # 单元测试
pnpm build          # 完整构建
```

### 代码规范要点

1. **Company 隔离**：每条数据库查询/路由必须带 companyId scope
2. **合约同步**：改 Schema → 改 shared → 改 server → 改 ui，全链路必须同步
3. **Activity Log**：所有 mutation 必须写 activity_log
4. **测试覆盖**：新功能需要对应测试

---

## 十六、注意事项

1. **`doc/SPEC-implementation.md` vs `doc/SPEC.md`**：前者是 V1 实现合约（以此为准），后者是长期愿景

2. **`docs/` vs `doc/`**：`docs/` 是面向外部用户的公开文档，`doc/` 是内部工程文档

3. **`AGENTS.md`（根目录）**：AI 辅助开发时必读，定义了 AI 给此项目写代码的规范

4. **嵌入数据库**：本地开发不需要安装 PostgreSQL，直接 `pnpm dev` 即可

5. **类型共享路径**：`packages/shared/src/` 下的类型影响前后端两端，改动要小心

6. **Worktree 隔离**：多分支并行开发时用 `pnpm paperclipai worktree init`，避免 DB 冲突

---

*本文档由代码扫描 + 工程文档综合生成（2026-04-04）。如工程有重大变化，请对照最新代码更新本文档。*
