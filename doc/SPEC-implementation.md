# Paperclip V1 实现规范

状态：首次发布（V1）的实现契约
日期：2026-02-17
受众：产品、工程及智能体集成开发者
来源输入：`GOAL.md`、`PRODUCT.md`、`SPEC.md`、`DATABASE.md`、当前 monorepo 代码

## 1. 文档定位

`SPEC.md` 仍为长期产品规范。
本文档是具体的、可直接构建的 V1 契约。
如有冲突，以 `SPEC-implementation.md` 为 V1 行为的准则。

## 2. V1 目标成果

Paperclip V1 必须为自主智能体提供完整的控制平面循环：

1. 人类董事会创建公司并定义目标。
2. 董事会在组织树中创建并管理智能体。
3. 智能体通过心跳调用接收并执行任务。
4. 所有工作通过任务/评论进行跟踪，并具备审计可见性。
5. Token/成本用量被上报，预算限制可终止工作。
6. 董事会可随时介入（暂停智能体/任务、覆盖决策）。

成功标准：单个运营者能够端到端运营一家小型 AI 原生公司，具备清晰的可见性与控制力。

## 3. V1 明确产品决策

这些决策针对 V1 关闭了 `SPEC.md` 中的未解问题。

| 主题 | V1 决策 |
|---|---|
| 租户模式 | 单租户部署，多公司数据模型 |
| 公司模型 | 公司为一等实体；所有业务实体均属于公司范围 |
| 董事会 | 每个部署对应单一人类董事会运营者 |
| 组织图 | 严格树形结构（`reports_to` 可为 null 的根节点）；不支持多上级汇报 |
| 可见性 | 董事会及同公司所有智能体拥有完全可见性 |
| 沟通方式 | 仅通过任务 + 评论（无独立聊天系统） |
| 任务归属 | 单一受理人；`in_progress` 状态转换需要原子检出 |
| 恢复机制 | 无自动重新分配；工作恢复保持手动/明确方式 |
| 智能体适配器 | 内置 `process` 和 `http` 适配器 |
| 认证 | 与模式相关的人类认证（当前代码中 `local_trusted` 为隐式董事会；认证模式使用会话），智能体使用 API 密钥 |
| 预算周期 | 每月 UTC 日历窗口 |
| 预算执行 | 软性警报 + 硬上限自动暂停 |
| 部署模式 | 规范模型为 `local_trusted` + `authenticated`，配合 `private/public` 暴露策略（参见 `doc/DEPLOYMENT-MODES.md`） |

## 4. 当前基线（代码库快照）

截至 2026-02-17，代码库已包含：

- Node + TypeScript 后端，为 `agents`、`projects`、`goals`、`issues`、`activity` 提供 REST CRUD
- React UI 页面，用于仪表盘/智能体/项目/目标/问题列表
- 通过 Drizzle 管理的 PostgreSQL 架构，当 `DATABASE_URL` 未设置时回退到内嵌 PostgreSQL

V1 实现在此基线上扩展为以公司为中心、具备治理意识的控制平面。

## 5. V1 范围

## 5.1 范围内

- 公司生命周期（创建/列出/获取/更新/归档）
- 与公司使命关联的目标层级
- 含组织结构和适配器配置的智能体生命周期
- 含父子层级和评论的任务生命周期
- 原子任务检出和明确的任务状态转换
- 董事会对招聘及 CEO 战略提案的审批
- 心跳调用、状态追踪及取消
- 成本事件采集和汇总（智能体/任务/项目/公司）
- 预算设置和硬停止执行
- 董事会 Web UI（仪表盘、组织图、任务、智能体、审批、成本）
- 面向智能体的 API 契约（任务读写、心跳上报、成本上报）
- 所有变更操作的可审计活动日志

## 5.2 范围外（V1）

- 插件框架和第三方扩展 SDK
- 超出模型/Token 成本的收入/支出核算
- 知识库子系统
- 公共市场（ClipHub）
- 多董事会治理或基于角色的人类权限细粒度管理
- 自动自愈编排（自动重新分配/重试规划器）

## 6. 架构

## 6.1 运行时组件

- `server/`：REST API、认证、编排服务
- `ui/`：董事会运营者界面
- `packages/db/`：Drizzle 架构、迁移、数据库客户端（Postgres）
- `packages/shared/`：共享 API 类型、验证器、常量

## 6.2 数据存储

- 主数据库：PostgreSQL
- 本地默认：内嵌 PostgreSQL，路径为 `~/.paperclip/instances/default/db`
- 可选的本地类生产环境：Docker Postgres
- 可选托管方案：Supabase/Postgres 兼容
- 文件/对象存储：
  - 本地默认：`~/.paperclip/instances/default/data/storage`（`local_disk`）
  - 云端：S3 兼容对象存储（`s3`）

## 6.3 后台处理

服务进程中的轻量级调度器/工作进程负责处理：

- 心跳触发检查
- 卡住运行检测
- 预算阈值检查

V1 不需要独立的队列基础设施。

## 7. 规范数据模型（V1）

除特别说明外，所有核心表均包含 `id`、`created_at`、`updated_at` 字段。

## 7.0 认证表

人类认证表（`users`、`sessions` 及特定提供商的认证工件）由所选认证库管理。本规范将其视为必需依赖，在需要用户归属时引用 `users.id`。

## 7.1 `companies`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`

不变量：每条业务记录恰好属于一个公司。

## 7.2 `agents`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `status` enum: `active | paused | idle | running | error | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` enum: `process | http`
- `adapter_config` jsonb not null
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `last_heartbeat_at` timestamptz null

不变量：

- 智能体与其上级必须属于同一公司
- 汇报树中不允许出现循环
- `terminated` 状态的智能体无法恢复

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

不变量：明文密钥仅在创建时展示一次；仅存储哈希值。

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

不变量：每个公司至少有一个根级 `company` 层级目标。

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null

## 7.6 `issues`（核心任务实体）

- `id` uuid pk
- `company_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `assignee_agent_id` uuid fk `agents.id` null
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- `request_depth` int not null default 0
- `billing_code` text null
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null

不变量：

- 仅允许单一受理人
- 任务必须通过 `goal_id`、`parent_id` 或项目-目标关联追溯到公司目标链
- `in_progress` 状态需要受理人
- 终止状态：`done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk not null
- `issue_id` uuid fk `issues.id` not null
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` text not null

## 7.8 `heartbeat_runs`

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `invocation_source` enum: `scheduler | manual | callback`
- `status` enum: `queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `external_run_id` text null
- `context_snapshot` jsonb null

## 7.9 `cost_events`


- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk `agents.id` not null
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` text null
- `provider` text not null
- `model` text not null
- `input_tokens` int not null default 0
- `output_tokens` int not null default 0
- `cost_cents` int not null
- `occurred_at` timestamptz not null

不变量：每个事件必须关联智能体和公司；汇总值为聚合计算结果，绝不手动编辑。

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | approved | rejected | cancelled`
- `payload` jsonb not null
- `decision_note` text null
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` timestamptz null

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk not null
- `actor_type` enum: `agent | user | system`
- `actor_id` uuid/text not null
- `action` text not null
- `entity_type` text not null
- `entity_id` uuid/text not null
- `details` jsonb null
- `created_at` timestamptz not null default now()

## 7.12 `company_secrets` + `company_secret_versions`

- 密钥值不在 `agents.adapter_config.env` 中内联存储。
- 智能体的环境变量条目应对敏感值使用密钥引用。
- `company_secrets` 追踪每个公司的身份/提供商元数据。
- `company_secret_versions` 按版本存储加密/引用材料。
- 本地部署的默认提供商：`local_encrypted`。

运营策略：

- 配置读取 API 对敏感明文值进行脱敏处理。
- 活动和审批负载不得持久化原始敏感值。
- 配置修订版本可能包含脱敏占位符；此类修订对脱敏字段不可恢复。

## 7.13 必需索引

- `agents(company_id, status)`
- `agents(company_id, reports_to)`
- `issues(company_id, status)`
- `issues(company_id, assignee_agent_id, status)`
- `issues(company_id, parent_id)`
- `issues(company_id, project_id)`
- `cost_events(company_id, occurred_at)`
- `cost_events(company_id, agent_id, occurred_at)`
- `heartbeat_runs(company_id, agent_id, started_at desc)`
- `approvals(company_id, status, type)`
- `activity_log(company_id, created_at desc)`
- `assets(company_id, created_at desc)`
- `assets(company_id, object_key)` unique
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` unique
- `company_secret_versions(secret_id, version)` unique

## 7.14 `assets` + `issue_attachments`

- `assets` 存储提供商支持的对象元数据（不内联字节）：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `provider` enum/text (`local_disk | s3`)
  - `object_key` text not null
  - `content_type` text not null
  - `byte_size` int not null
  - `sha256` text not null
  - `original_filename` text null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
- `issue_attachments` 将资产关联到问题/评论：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null

## 7.15 `documents` + `document_revisions` + `issue_documents`

- `documents` 存储可编辑的文本优先文档：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `title` text null
  - `format` text not null (`markdown`)
  - `latest_body` text not null
  - `latest_revision_id` uuid null
  - `latest_revision_number` int not null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
  - `updated_by_agent_id` uuid fk null
  - `updated_by_user_id` uuid/text fk null
- `document_revisions` 存储只追加的历史记录：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `document_id` uuid fk not null
  - `revision_number` int not null
  - `body` text not null
  - `change_summary` text null
- `issue_documents` 通过稳定的工作流键将文档关联到问题：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `document_id` uuid fk not null
  - `key` text not null（`plan`、`design`、`notes` 等）

## 8. 状态机

## 8.1 智能体状态

允许的转换：

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused`（需要取消流程）
- `paused -> idle`
- `* -> terminated`（仅董事会，不可逆）

## 8.2 问题状态

允许的转换：

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- 终止状态：`done`、`cancelled`

副作用：

- 进入 `in_progress` 时若 `started_at` 为 null 则设置该字段
- 进入 `done` 时设置 `completed_at`
- 进入 `cancelled` 时设置 `cancelled_at`

## 8.3 审批状态

- `pending -> approved | rejected | cancelled`
- 决策后进入终止状态

## 9. Auth and Permissions

## 9.1 Board Auth

- Session-based auth for human operator
- Board has full read/write across all companies in deployment
- Every board mutation writes to `activity_log`

## 9.2 Agent Auth

- Bearer API key mapped to one agent and company
- Agent key scope:
  - read org/task/company context for own company
  - read/write own assigned tasks and comments
  - create tasks/comments for delegation
  - report heartbeat status
  - report cost events
- Agent cannot:
  - bypass approval gates
  - modify company-wide budgets directly
  - mutate auth/keys

## 9.3 Permission Matrix (V1)

| Action | Board | Agent |
|---|---|---|
| Create company | yes | no |
| Hire/create agent | yes (direct) | request via approval |
| Pause/resume agent | yes | no |
| Create/update task | yes | yes |
| Force reassign task | yes | limited |
| Approve strategy/hire requests | yes | no |
| Report cost | yes | yes |
| Set company budget | yes | no |
| Set subordinate budget | yes | yes (manager subtree only) |

## 10. API Contract (REST)

All endpoints are under `/api` and return JSON.

## 10.1 Companies

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `PATCH /companies/:companyId/branding`
- `POST /companies/:companyId/archive`

## 10.2 Goals

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents

- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (create API key)
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 Tasks (Issues)

- `GET /companies/:companyId/issues`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `GET /issues/:issueId/documents`
- `GET /issues/:issueId/documents/:key`
- `PUT /issues/:issueId/documents/:key`
- `GET /issues/:issueId/documents/:key/revisions`
- `DELETE /issues/:issueId/documents/:key`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 Atomic Checkout Contract

`POST /issues/:issueId/checkout` request:

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

Server behavior:

1. single SQL update with `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`
2. if updated row count is 0, return `409` with current owner/status
3. successful checkout sets `assignee_agent_id`, `status = in_progress`, and `started_at`

## 10.5 Projects

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 Approvals

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 Cost and Budgets

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 Activity and Dashboard

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`

Dashboard payload must include:

- active/running/paused/error agent counts
- open/in-progress/blocked/done issue counts
- month-to-date spend and budget utilization
- pending approvals count

## 10.9 Error Semantics

- `400` validation error
- `401` unauthenticated
- `403` unauthorized
- `404` not found
- `409` state conflict (checkout conflict, invalid transition)
- `422` semantic rule violation
- `500` server error

## 11. Heartbeat and Adapter Contract

## 11.1 Adapter Interface

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

## 11.2 Process Adapter

Config shape:

```json
{
  "command": "string",
  "args": ["string"],
  "cwd": "string",
  "env": {"KEY": "VALUE"},
  "timeoutSec": 900,
  "graceSec": 15
}
```

Behavior:

- spawn child process
- stream stdout/stderr to run logs
- mark run status on exit code/timeout
- cancel sends SIGTERM then SIGKILL after grace

## 11.3 HTTP Adapter

Config shape:

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

Behavior:

- invoke by outbound HTTP request
- 2xx means accepted
- non-2xx marks failed invocation
- optional callback endpoint allows asynchronous completion updates

## 11.4 Context Delivery

- `thin`: send IDs and pointers only; agent fetches context via API
- `fat`: include current assignments, goal summary, budget snapshot, and recent comments

## 11.5 Scheduler Rules

Per-agent schedule fields in `adapter_config`:

- `enabled` boolean
- `intervalSec` integer (minimum 30)
- `maxConcurrentRuns` fixed at `1` for V1

Scheduler must skip invocation when:

- agent is paused/terminated
- an existing run is active
- hard budget limit has been hit

## 12. Governance and Approval Flows

## 12.1 Hiring

1. Agent or board creates `approval(type=hire_agent, status=pending, payload=agent draft)`.
2. Board approves or rejects.
3. On approval, server creates agent row and initial API key (optional).
4. Decision is logged in `activity_log`.

Board can bypass request flow and create agents directly via UI; direct create is still logged as a governance action.

## 12.2 CEO Strategy Approval

1. CEO posts strategy proposal as `approval(type=approve_ceo_strategy)`.
2. Board reviews payload (plan text, initial structure, high-level tasks).
3. Approval unlocks execution state for CEO-created delegated work.

Before first strategy approval, CEO may only draft tasks, not transition them to active execution states.

## 12.3 Board Override

Board can at any time:

- pause/resume/terminate any agent
- reassign or cancel any task
- edit budgets and limits
- approve/reject/cancel pending approvals

## 13. Cost and Budget System

## 13.1 Budget Layers

- company monthly budget
- agent monthly budget
- optional project budget (if configured)

## 13.2 Enforcement Rules

- soft alert default threshold: 80%
- hard limit: at 100%, trigger:
  - set agent status to `paused`
  - block new checkout/invocation for that agent
  - emit high-priority activity event

Board may override by raising budget or explicitly resuming agent.

## 13.3 Cost Event Ingestion

`POST /companies/:companyId/cost-events` body:

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

Validation:

- non-negative token counts
- `costCents >= 0`
- company ownership checks for all linked entities

## 13.4 Rollups

Read-time aggregate queries are acceptable for V1.
Materialized rollups can be added later if query latency exceeds targets.

## 14. UI Requirements (Board App)

V1 UI routes:

- `/` dashboard
- `/companies` company list/create
- `/companies/:id/org` org chart and agent status
- `/companies/:id/tasks` task list/kanban
- `/companies/:id/agents/:agentId` agent detail
- `/companies/:id/costs` cost and budget dashboard
- `/companies/:id/approvals` pending/history approvals
- `/companies/:id/activity` audit/event stream

Required UX behaviors:

- global company selector
- quick actions: pause/resume agent, create task, approve/reject request
- conflict toasts on atomic checkout failure
- no silent background failures; every failed run visible in UI

## 15. Operational Requirements

## 15.1 Environment

- Node 20+
- `DATABASE_URL` optional
- if unset, auto-use PGlite and push schema

## 15.2 Migrations

- Drizzle migrations are source of truth
- no destructive migration in-place for V1 upgrade path
- provide migration script from existing minimal tables to company-scoped schema

## 15.3 Logging and Audit

- structured logs (JSON in production)
- request ID per API call
- every mutation writes `activity_log`

## 15.4 Reliability Targets

- API p95 latency under 250 ms for standard CRUD at 1k tasks/company
- heartbeat invoke acknowledgement under 2 s for process adapter
- no lost approval decisions (transactional writes)

## 16. Security Requirements

- store only hashed agent API keys
- redact secrets in logs (`adapter_config`, auth headers, env vars)
- CSRF protection for board session endpoints
- rate limit auth and key-management endpoints
- strict company boundary checks on every entity fetch/mutation

## 17. Testing Strategy

## 17.1 Unit Tests

- state transition guards (agent, issue, approval)
- budget enforcement rules
- adapter invocation/cancel semantics

## 17.2 Integration Tests

- atomic checkout conflict behavior
- approval-to-agent creation flow
- cost ingestion and rollup correctness
- pause while run is active (graceful cancel then force kill)

## 17.3 End-to-End Tests

- board creates company -> hires CEO -> approves strategy -> CEO receives work
- agent reports cost -> budget threshold reached -> auto-pause occurs
- task delegation across teams with request depth increment

## 17.4 Regression Suite Minimum

A release candidate is blocked unless these pass:

1. auth boundary tests
2. checkout race test
3. hard budget stop test
4. agent pause/resume test
5. dashboard summary consistency test

## 18. Delivery Plan

## Milestone 1: Company Core and Auth

- add `companies` and company scoping to existing entities
- add board session auth and agent API keys
- migrate existing API routes to company-aware paths

## Milestone 2: Task and Governance Semantics

- implement atomic checkout endpoint
- implement issue comments and lifecycle guards
- implement approvals table and hire/strategy workflows

## Milestone 3: Heartbeat and Adapter Runtime

- implement adapter interface
- ship `process` adapter with cancel semantics
- ship `http` adapter with timeout/error handling
- persist heartbeat runs and statuses

## Milestone 4: Cost and Budget Controls

- implement cost events ingestion
- implement monthly rollups and dashboards
- enforce hard limit auto-pause

## Milestone 5: Board UI Completion

- add company selector and org chart view
- add approvals and cost pages

## Milestone 6: Hardening and Release

- full integration/e2e suite
- seed/demo company templates for local testing
- release checklist and docs update

## 19. Acceptance Criteria (Release Gate)

V1 is complete only when all criteria are true:

1. A board user can create multiple companies and switch between them.
2. A company can run at least one active heartbeat-enabled agent.
3. Task checkout is conflict-safe with `409` on concurrent claims.
4. Agents can update tasks/comments and report costs with API keys only.
5. Board can approve/reject hire and CEO strategy requests in UI.
6. Budget hard limit auto-pauses an agent and prevents new invocations.
7. Dashboard shows accurate counts/spend from live DB data.
8. Every mutation is auditable in activity log.
9. App runs with embedded PostgreSQL by default and with external Postgres via `DATABASE_URL`.

## 20. Post-V1 Backlog (Explicitly Deferred)

- plugin architecture
- richer workflow-state customization per team
- milestones/labels/dependency graph depth beyond V1 minimum
- realtime transport optimization (SSE/WebSockets)
- public template marketplace integration (ClipHub)

## 21. Company Portability Package (V1 Addendum)

V1 supports company import/export using a portable package contract:

- markdown-first package rooted at `COMPANY.md`
- implicit folder discovery by convention
- `.paperclip.yaml` sidecar for Paperclip-specific fidelity
- canonical base package is vendor-neutral and aligned with `docs/companies/companies-spec.md`
- common conventions:
  - `agents/<slug>/AGENTS.md`
  - `teams/<slug>/TEAM.md`
  - `projects/<slug>/PROJECT.md`
  - `projects/<slug>/tasks/<slug>/TASK.md`
  - `tasks/<slug>/TASK.md`
  - `skills/<slug>/SKILL.md`

Export/import behavior in V1:

- export emits a clean vendor-neutral markdown package plus `.paperclip.yaml`
- projects and starter tasks are opt-in export content rather than default package content
- recurring `TASK.md` entries use `recurring: true` in the base package and Paperclip routine fidelity in `.paperclip.yaml`
- Paperclip imports recurring task packages as routines instead of downgrading them to one-time issues
- export strips environment-specific paths (`cwd`, local instruction file paths, inline prompt duplication) while preserving portable project repo/workspace metadata such as `repoUrl`, refs, and workspace-policy references keyed in `.paperclip.yaml`
- export never includes secret values; env inputs are reported as portable declarations instead
- import supports target modes:
  - create a new company
  - import into an existing company
- import recreates exported project workspaces and remaps portable workspace keys back to target-local workspace ids
- import forces imported agent timer heartbeats off so packages never start scheduled runs implicitly
- import supports collision strategies: `rename`, `skip`, `replace`
- import supports preview (dry-run) before apply
- GitHub imports warn on unpinned refs instead of blocking
