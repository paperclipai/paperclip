# Paperclip V1 实现规范

状态：首次发布的实施合同 (V1)
日期：2026-02-17
受众：产品、工程和智能体集成作者
源输入：`GOAL.md`、`PRODUCT.md`、`SPEC.md`、`DATABASE.md`、当前 monorepo 代码

## 1. 文档角色

`SPEC.md` 仍然是长期产品规格。
本文档是具体的、可构建的 V1 合约。
当发生冲突时，`SPEC-implementation.md` 控制 V1 行为。

## 2.V1 结果

Paperclip V1 必须为自治智能体提供完整的控制平面循环：

1. 董事会创建公司并确定目标。
2. 董事会在组织树中创建和管理智能体。
3. 智能体通过心跳调用接收并执行任务。
4. 所有工作都通过具有审计可见性的任务/评论进行跟踪。
5. 报告代币/成本使用情况，预算限制可能会停止工作。
6. 董事会可以在任何地方进行干预（暂停智能体/任务、推翻决策）。

成功意味着一名运营商可以以清晰的可见性和控制力端到端地运营一家小型人工智能原生公司。

## 3. 明确的 V1 产品决策

这些决定结束了 `SPEC.md` 针对 V1 的未决问题。

| 主题     | V1 决定                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------- |
| 租赁     | 单租户部署、多公司数据模型                                                                                   |
| 公司模式   | 公司为一级；所有商业实体均属于公司范围                                                                             |
| 董事会    | 每次部署配备一名人员板操作员                                                                                  |
| 组织图    | 严格树（`reports_to` 根可为空）；没有多经理报告                                                                  |
| 能见度    | 董事会和同一公司所有智能体的完全可见性                                                                             |
| 通讯     | 仅任务+评论（没有单独的聊天系统）                                                                               |
| 任务所有权  | 单一受让人； `in_progress` 转换需要原子结账                                                                   |
| 恢复     | 没有自动重新分配；工作恢复仍然是手动/明确的                                                                          |
| 智能体适配器 | 内置 `process` 和 `http` 适配器                                                                       |
| 授权     | 依赖于模式的人工身份验证（当前代码中的 `local_trusted` 隐式板；身份验证模式使用会话），智能体的 API 密钥                                 |
| 预算期    | 每月 UTC 日历窗口                                                                                     |
| 预算执行   | 软警报+硬限制自动暂停                                                                                     |
| 部署模式   | 规范模型为 `local_trusted` + `authenticated`，具有 `private/public` 暴露策略（请参阅 `doc/DEPLOYMENT-MODES.md`） |

## 4. 当前基线（回购快照）

截至 2026 年 2 月 17 日，该存储库已包括：

- 节点 + TypeScript 后端，带有 REST CRUD，用于 `agents`、`projects`、`goals`、`issues`、`activity`
- React 控制台/智能体/项目/目标/问题列表的 UI 页面
- 当 `DATABASE_URL` 未设置时，通过 Drizzle 嵌入 PostgreSQL 回退的 PostgreSQL 模式

V1 实施将此基线扩展为以公司为中心、具有治理意识的控制平面。

## 5.V1范围

## 5.1 范围- 公司生命周期（创建/列表/获取/更新/存档）
- 与公司使命相关的目标层次
- 具有组织结构和适配器配置的智能体生命周期
- 具有父/子层次结构和注释的任务生命周期
- 原子任务签出和显式任务状态转换
- 董事会批准招聘和首席执行官战略提案
- 心跳调用、状态跟踪和取消
- 成本事件摄取和汇总（智能体/任务/项目/公司）
- 预算设置和硬停止执行
- 用于控制台、组织架构图、任务、智能体、批准、成本的董事会 Web UI
- 面向Agent的API合约（任务读/写、心跳报告、成本报告）
- 所有变异操作的可审计活动日志

## 5.2 超出范围 (V1)

- 插件框架和第三方扩展SDK
- 模型/代币成本之外的收入/费用核算
- 知识库子系统
- 公共市场（ClipHub）
- 多板治理或基于角色的人员权限粒度
- 自动自我修复编排（自动重新分配/重试规划器）

## 6. 架构

## 6.1 运行时组件

- `server/`：REST API，身份验证，编排服务
- `ui/`：板操作员界面
- `packages/db/`：Drizzle 架构、迁移、数据库客户端 (Postgres)
- `packages/shared/`：共享 API 类型、验证器、常量

## 6.2 数据存储

- 主要：PostgreSQL
- 本地默认：在 `~/.paperclip/instances/default/db` 嵌入 PostgreSQL
- 可选的本地产品：Docker Postgres
- 可选托管：Supabase/Postgres 兼容
- 文件/对象存储：
  - 本地默认：`~/.paperclip/instances/default/data/storage` (`local_disk`)
  - 云：S3兼容的对象存储（`s3`）

## 6.3 后台处理

服务器进程中的轻量级调度程序/工作人员处理：

- 心跳触发检查
- 卡住运行检测
- 预算门槛检查

V1 不需要单独的队列基础设施。

## 7. 规范数据模型 (V1)

除非另有说明，所有核心表均包括 `id`、`created_at`、`updated_at`。

## 7.0 验证表

人工身份验证表（`users`、`sessions` 和特定于提供者的身份验证工件）由选定的身份验证库管理。此规范将它们视为必需的依赖项，并在需要用户归属的地方引用 `users.id`。

## 7.1 `companies`

- `id` uuid pk
- `name` 文本不为空
- `description` 文字为空
- `status` 枚举：`active | paused | archived`

不变：每条业务记录都属于一家公司。

## 7.2 `agents`- `id` uuid pk
- `company_id` uuid fk `companies.id` 不为空
- `name` 文本不为空
- `role` 文本不为空
- `title` 文字为空
- `status` 枚举：`active | paused | idle | running | error | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` 文字为空
- `adapter_type` 枚举：`process | http`
- `adapter_config` jsonb 不为空
- `context_mode` 枚举：`thin | fat` 默认 `thin`
- `budget_monthly_cents` int 不为 null 默认 0
- `spent_monthly_cents` int 不为 null 默认 0
- `last_heartbeat_at` 时间戳空

不变量：

- 智能体人和经理必须在同一家公司
- 报告树中没有循环
- `terminated`智能体无法恢复

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` 不为空
- `company_id` uuid fk `companies.id` 不为空
- `name` 文本不为空
- `key_hash` 文本不为空
- `last_used_at` 时间戳空
- `revoked_at` 时间戳空

不变：明文密钥在创建时显示一次；仅存储哈希值。

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `title` 文本不为空
- `description` 文字为空
- `level` 枚举：`company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` 枚举：`planned | active | achieved | cancelled`

不变式：每个公司至少有一个根 `company` 级别目标。

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `goal_id` uuid fk `goals.id` null
- `name` 文本不为空
- `description` 文字为空
- `status` 枚举：`backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` 日期为空

## 7.6 `issues`（核心任务实体）

- `id` uuid pk
- `company_id` uuid fk 不为空
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` 文本不为空
- `description` 文字为空
- `status` 枚举：`backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` 枚举：`critical | high | medium | low`
- `assignee_agent_id` uuid fk `agents.id` null
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- `request_depth` int 不为 null 默认 0
- `billing_code` 文字为空
- `started_at` 时间戳空
- `completed_at` 时间戳空
- `cancelled_at` 时间戳空

不变量：

- 仅限单一受让人
- 任务必须通过 `goal_id`、`parent_id` 或项目目标链接追溯到公司目标链
- `in_progress` 需要受让人
- 终端状态：`done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `issue_id` uuid fk `issues.id` 不为空
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` 文本不为空

## 7.8 `heartbeat_runs`- `id` uuid pk
- `company_id` uuid fk 不为空
- `agent_id` uuid fk 不为空
- `invocation_source` 枚举：`scheduler | manual | callback`
- `status` 枚举：`queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` 时间戳空
- `finished_at` 时间戳空
- `error` 文字为空
- `external_run_id` 文字为空
- `context_snapshot` jsonb 空

## 7.9 `cost_events`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `agent_id` uuid fk `agents.id` 不为空
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` 文字为空
- `provider` 文本不为空
- `model` 文本不为空
- `input_tokens` int 不为 null 默认 0
- `output_tokens` int 不为 null 默认 0
- `cost_cents` int 不为空
- `occurred_at` 时间戳不为空

不变性：每个事件必须附加到智能体和公司；汇总是聚合，从不手动编辑。

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `type` 枚举：`hire_agent | approve_ceo_strategy`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` 枚举：`pending | approved | rejected | cancelled`
- `payload` jsonb 不为空
- `decision_note` 文字为空
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` 时间戳空

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk 不为空
- `actor_type` 枚举：`agent | user | system`
- `actor_id` uuid/文本不为空
- `action` 文本不为空
- `entity_type` 文本不为空
- `entity_id` uuid/文本不为空
- `details` jsonb 空
- `created_at` timestamptz 现在默认不为空()

## 7.12 `company_secrets` + `company_secret_versions`

- 秘密值不内联存储在 `agents.adapter_config.env` 中。
- 智能体环境条目应使用敏感值的秘密引用。
- `company_secrets` 跟踪每个公司的身份/提供商元数据。
- `company_secret_versions` 存储每个版本的加密/参考资料。
- 本地部署中的默认提供程序：`local_encrypted`。

经营方针：

- 配置读取 APIs 编辑敏感的普通值。
- 活动和批准有效负载不得保留原始敏感值。
- 配置修订可能包括经过编辑的占位符；对于已编辑的字段，此类修订是不可恢复的。

## 7.13 所需索引

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
- `assets(company_id, object_key)` 独特
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` 独特
- `company_secret_versions(secret_id, version)` 独特

## 7.14 `assets` + `issue_attachments`- `assets` 存储提供者支持的对象元数据（不是内联字节）：
  - `id` uuid pk
  - `company_id` uuid fk 不为空
  - `provider` 枚举/文本 (`local_disk | s3`)
  - `object_key` 文本不为空
  - `content_type` 文本不为空
  - `byte_size` int 不为空
  - `sha256` 文本不为空
  - `original_filename` 文字为空
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/文本 fk null
- `issue_attachments` 将资产链接到问题/评论：
  - `id` uuid pk
  - `company_id` uuid fk 不为空
  - `issue_id` uuid fk 不为空
  - `asset_id` uuid fk 不为空
  - `issue_comment_id` uuid fk null

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
- `* -> terminated`（仅限主板，不可逆）

## 8.2 问题状态

允许的转换：

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- 终端：`done`、`cancelled`

副作用：

- 输入 `in_progress` 如果为空则设置 `started_at`
- 输入 `done` 设置 `completed_at`
- 输入 `cancelled` 设置 `cancelled_at`

## 8.3 批准状态

- `pending -> approved | rejected | cancelled`
- 决定后的终端

## 9. 授权和权限

## 9.1 板授权

- 人工操作员基于会话的身份验证
- 董事会对部署中的所有公司具有完全读/写能力
- 每个主板突变都会写入`activity_log`

## 9.2 智能体验证

- 承载 API 密钥映射到一个智能体和公司
- 智能体关键范围：
  - 阅读自己公司的组织/任务/公司背景
  - 读/写自己分配的任务和评论
  - 为委托创建任务/评论
  - 报告心跳状态
  - 报告成本事件
- 智能体人不能：
  - 绕过审批关卡
  - 直接修改公司范围的预算
  - 改变身份验证/密钥

## 9.3 权限矩阵（V1）

|行动|董事会|智能体|
|---|---|---|
|创建公司 |是的 |没有|
|雇用/创建智能体 |是（直接）|请求通过批准 |
|暂停/恢复智能体 |是的 |没有|
|创建/更新任务 |是的 |是的 |
|强制重新分配任务 |是的 |有限|
|批准策略/招聘请求 |是的 |没有|
|报告费用 |是的 |是的 |
|设定公司预算|是的 |没有|
|设定下级预算 |是的 |是（仅限管理器子树）|

## 10. API 合约（REST）

所有端点都在`/api`下，并返回JSON。

## 10.1 公司

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `POST /companies/:companyId/archive`

## 10.2 目标

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId`（软删除可选，硬删除仅板）

## 10.3 智能体- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys`（创建API密钥）
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 任务（问题）

- `GET /companies/:companyId/issues`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments`（分段上传）
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 原子结帐合约

`POST /issues/:issueId/checkout` 请求：

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

服务器行为：

1. 使用 `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)` 进行单个 SQL 更新
2. 如果更新的行数为0，则返回`409`以及当前所有者/状态
3. 成功结账设置`assignee_agent_id`、`status = in_progress`、`started_at`

## 10.5 项目

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 批准

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 成本和预算

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 活动和控制台

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`

控制台有效负载必须包括：

- 活动/运行/暂停/错误智能体计数
- 开放/进行中/阻止/完成的问题计数
- 本月迄今的支出和预算利用率
- 待批准计数

## 10.9 错误语义

- `400` 验证错误
- `401` 未经身份验证
- `403` 未经授权
- `404` 未找到
- `409` 状态冲突（结帐冲突、无效转换）
- `422` 语义规则违规
- `500` 服务器错误

## 11. 心跳和适配器合约

## 11.1 适配器接口

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

## 11.2 进程适配器

配置形状：

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

行为：

- 生成子进程
- 流式传输标准输出/标准错误以运行日志
- 在退出代码/超时上标记运行状态
- 取消发送 SIGTERM，然后在宽限后发送 SIGKILL

## 11.3 HTTP 适配器

配置形状：

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

行为：

- 通过出站 HTTP 请求调用
- 2xx 表示已接受
- 非 2xx 标记调用失败
- 可选的回调端点允许异步完成更新

## 11.4 上下文传递

- `thin`：仅发送ID和指针；智能体通过 API 获取上下文
- `fat`：包括当前作业、目标摘要、预算快照和最近评论

## 11.5 调度规则

`adapter_config` 中的每个业务代表计划字段：

- `enabled` 布尔值
- `intervalSec` 整数（最少 30）
- V1 的 `maxConcurrentRuns` 固定为 `1`

在以下情况下，调度程序必须跳过调用：

- 智能体已暂停/终止
- 现有运行处于活动状态
- 已达到硬预算限制

## 12. 治理和审批流程

## 12.1 招聘1. 智能体或董事会创建`approval(type=hire_agent, status=pending, payload=agent draft)`。
2. 董事会批准或拒绝。
3. 批准后，服务器创建智能体行和初始 API 密钥（可选）。
4. 决定记录在`activity_log` 中。

Board可以绕过请求流程，直接通过UI创建智能体；直接创建仍被记录为治理操作。

## 12.2 CEO 战略批准

1. CEO发布战略提案，编号为`approval(type=approve_ceo_strategy)`。
2. 董事会审查有效负载（计划文本、初始结构、高级任务）。
3. 批准解锁首席执行官创建的委派工作的执行状态。

在首次战略批准之前，CEO 只能起草任务，而不能将其转变为主动执行状态。

## 12.3 板覆盖

董事会可以随时：

- 暂停/恢复/终止任何智能体
- 重新分配或取消任何任务
- 编辑预算和限制
- 批准/拒绝/取消待批准

## 13. 成本和预算系统

## 13.1 预算层

- 公司每月预算
- 智能体每月预算
- 可选的项目预算（如果配置）

## 13.2 执行规则

- 软警报默认阈值：80%
- 硬限制：100%时，触发：
  - 将智能体状态设置为`paused`
  - 阻止该智能体的新结账/调用
  - 发出高优先级活动事件

董事会可以通过提高预算或明确恢复智能体来推翻。

## 13.3 成本事件摄取

`POST /companies/:companyId/cost-events` 正文：

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

验证：

- 非负令牌计数
- `costCents >= 0`
- 所有关联实体的公司所有权检查

## 13.4 汇总

V1 可以接受读取时聚合查询。
如果查询延迟超过目标，可以稍后添加物化汇总。

## 14. UI 要求（Board 应用程序）

V1 UI路线：

- `/` 控制台
- `/companies` 公司列表/创建
- `/companies/:id/org` 组织架构图和智能体状态
- `/companies/:id/tasks` 任务列表/看板
- `/companies/:id/agents/:agentId` 智能体详情
- `/companies/:id/costs` 成本和预算控制台
- `/companies/:id/approvals` 待批准/历史批准
- `/companies/:id/activity` 审计/事件流

所需的用户体验行为：

- 全球公司选择器
- 快速操作：暂停/恢复智能体、创建任务、批准/拒绝请求
- 原子结账失败时发生冲突
- 没有静默的后台故障；每个失败的运行都在 UI 中可见

## 15. 操作要求

## 15.1 环境

- 节点 20+
- `DATABASE_URL` 可选
- 如果未设置，则自动使用 PGlite 和推送模式

## 15.2 迁移

- 毛毛雨迁徙是真相的来源
- V1 升级路径没有破坏性迁移
- 提供从现有最小表到公司范围架构的迁移脚本

## 15.3 日志记录和审计

- 结构化日志（JSON 生产中）
- 每次 API 调用请求 ID
- 每个突变都写为`activity_log`

## 15.4 可靠性目标- API 对于 1k 任务/公司的标准 CRUD，p95 延迟低于 250 毫秒
- 进程适配器的心跳调用确认在 2 秒内完成
- 不会丢失批准决策（事务写入）

## 16. 安全要求

- 仅存储散列智能体 API 密钥
- 编辑日志中的秘密（`adapter_config`、身份验证标头、环境变量）
- 针对董事会会话端点的 CSRF 保护
- 速率限制身份验证和密钥管理端点
- 对每个实体获取/突变进行严格的公司边界检查

## 17. 测试策略

## 17.1 单元测试

- 国家过渡警卫（智能体、发行、批准）
- 预算执行规则
- 适配器调用/取消语义

## 17.2 集成测试

- 原子结账冲突行为
- 批准到智能体创建流程
- 成本摄取和汇总正确性
- 运行时暂停（优雅取消然后强制终止）

## 17.3 端到端测试

- 董事会创建公司 -> 聘请首席执行官 -> 批准战略 -> 首席执行官接受工作
- 智能体报告成本 -> 达到预算阈值 -> 发生自动暂停
- 跨团队的任务委派，请求深度增量

## 17.4 回归套件最小值

除非通过以下条件，否则候选版本将被阻止：

1. 授权边界测试
2. 结账比赛测试
3. 硬预算停止测试
4. 智能体暂停/恢复测试
5. 仪表盘汇总一致性测试

## 18. 交付计划

## 里程碑 1：公司核心和授权

- 将 `companies` 和公司范围添加到现有实体
- 添加董事会会话身份验证和智能体 API 密钥
- 将现有的 API 路由迁移到公司感知的路径

## 里程碑 2：任务和治理语义

- 实现原子结账端点
- 实施问题评论和生命周期守卫
- 实施审批表和雇用/策略工作流程

## 里程碑 3：心跳和适配器运行时

- 实现适配器接口
- 提供带有取消语义的 `process` 适配器
- 提供具有超时/错误处理功能的 `http` 适配器
- 持续心跳运行和状态

## 里程碑 4：成本和预算控制

- 实施成本事件摄取
- 实施每月汇总和控制台
- 强制执行硬限制自动暂停

## 里程碑 5：董事会 UI 完成

- 添加公司选择器和组织架构图视图
- 添加审批和成本页面

## 里程碑 6：强化和发布

- 完全集成/e2e套件
- 用于本地测试的种子/演示公司模板
- 发布清单和文档更新

## 19. 验收标准（释放门）

仅当所有条件都为真时，V1 才完整：1. 一个董事会用户可以创建多个公司并在多个公司之间切换。
2. 一家公司可以运行至少一个启用心跳的活动智能体。
3. 任务签出与 `409` 在并发声明上是冲突安全的。
4. 智能体只能使用API密钥更新任务/评论和报告费用。
5. 董事会可以在 UI 中批准/拒绝招聘和 CEO 战略请求。
6. 预算硬限制会自动暂停智能体并阻止新的调用。
7. 控制台显示实时数据库数据的准确计数/支出。
8. 每个突变都可以在活动日志中进行审核。
9. 应用程序默认与嵌入式 PostgreSQL 一起运行，并通过 `DATABASE_URL` 与外部 Postgres 一起运行。

## 20.V1 后积压（明确推迟）

- 插件架构
- 每个团队更丰富的工作流程状态定制
- 里程碑/标签/依赖图深度超出 V1 最小值
- 实时传输优化（SSE/WebSockets）
- 公共模板市场集成（ClipHub）

## 21. 公司可移植性包（V1 附录）

V1支持使用便携式打包合同的公司导入/导出：

- 恰好一个 JSON 入口点：`paperclip.manifest.json`
- 所有其他包文件都是带有 frontmatter 的 markdown
- 智能体约定：
  - `agents/<slug>/AGENTS.md`（V1导出/导入所需）
  - `agents/<slug>/HEARTBEAT.md`（可选，接受导入）
  - `agents/<slug>/*.md`（可选，接受导入）

V1 中的导出/导入行为：

- 导出包括基于选择的公司元数据和/或智能体
- 导出条带环境特定路径（`cwd`，本地指令文件路径）
- 导出从不包含秘密值；报告秘密要求
- 导入支持目标模式：
  - 创建一家新公司
  - 导入现有公司
- 导入支持碰撞策略：`rename`、`skip`、`replace`
- 导入支持应用前预览（试运行）