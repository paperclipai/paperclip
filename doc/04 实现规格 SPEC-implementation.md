# Paperclip V1 实现规格（Implementation Spec）

> **路径（path）**：`doc/04 实现规格 SPEC-implementation.md`。与 `doc/03 规范 SPEC.md` 冲突时，**本文件**约束 V1 行为。表名、字段名、API 片段、JSON 键保持英文。

**状态（Status）**：首版发布（V1）的实现契约  
**日期（Date）**：2026-04-28  
**读者（Audience）**：产品、工程与 agent 集成作者  
**输入来源（Source inputs）**：`doc/01 目标 GOAL.md`、`doc/02 产品定义 PRODUCT.md`、`doc/03 规范 SPEC.md`、`doc/06 数据库 DATABASE.md`、当前 monorepo 代码  

## 1. 文档角色（Document Role）

`doc/03 规范 SPEC.md` 仍是长周期产品规格。  
本文档是可落地、可构建的 **V1 契约**。  
若有冲突，以 **`doc/04 实现规格 SPEC-implementation.md`** 为准，约束 V1 行为。

## 2. V1 目标结果（V1 Outcomes）

Paperclip V1 必须为自主 **agent** 提供完整 **control plane（控制面）** 闭环：

1. 人类 **board（控制台操作者/董事会）** 创建 **company（公司）** 并定义 **goals（目标）**。  
2. **board** 在组织树中创建并管理 **agents（代理）**。  
3. **Agent** 通过 **heartbeat（心跳）** 调用接收并执行任务。  
4. 所有工作通过 **tasks（任务）/ 工单（issues）** + **comments（评论）** 跟踪，具备审计可见性。  
5. **Token/cost（令牌/费用）** 用量可上报，**budget（预算）** 上限可停止工作。  
6. **board** 可在任意处介入（暂停 agent/任务、覆盖决策）。  

成功标准：一名 **operator（操作者）** 能端到端运行一家小型 AI-native 公司，并具备清晰可见性与控制力。

## 3. V1 明确产品决策（Explicit V1 Product Decisions）

以下决策收敛 `doc/03 规范 SPEC.md` 在 V1 的开放问题。

| Topic（主题） | V1 决策 |
|---|---|
| Tenancy（租户） | 单租户部署（single-tenant deployment），数据模型多 **company** |
| Company model | **Company** 为一级对象；业务实体全部 **company-scoped（按公司隔离）** |
| Board | 每个部署一名人类 **board** 操作者 |
| Org graph（组织图） | 严格树形（`reports_to` 根可空）；不支持多上级汇报 |
| Visibility（可见性） | 同 **company** 内 **board** 与全部 **agent** 完全互见 |
| Communication | 仅 **tasks + comments**（无独立聊天系统） |
| Task ownership | **单一 assignee（受指派人）**；进入 `in_progress` 须 **atomic checkout（原子签出）** |
| Recovery（恢复） | 存活/看门狗恢复保持明确所有权：若安全则重试丢失的执行连续性，否则生成可见 **recovery issues** 或要求人类升级（见 `doc/execution-semantics.md`） |
| Agent adapters | 内置 `process`、`http`、本地 CLI/会话适配器与 OpenClaw **gateway**；外部适配器也可经 **adapter plugin** 加载 |
| Plugin framework | 本地/自托管早期 **plugin runtime** 在范围内；云市场与打包公开发布不在 V1 范围 |
| Auth（鉴权） | 人类鉴权随模式变化（`local_trusted` 当前代码里 **board** 隐含；`authenticated` 用 **session**）；**agent** 用 **API keys** |
| Budget period | 按 **UTC** 月历窗口 |
| Budget enforcement | **soft alerts（软告警）** + **hard limit（硬上限）** 自动暂停 |
| Deployment modes | 规范模型为 `local_trusted` + `authenticated`，配合 `private`/`public` **exposure（曝光）**（见 `doc/07 部署模式 DEPLOYMENT-MODES.md`） |

## 4. 当前基线（代码快照）

截至 2026-02-17，仓库已具备：

- Node + TypeScript 后端，对 `agents`、`projects`、`goals`、`issues`、`activity` 等的 REST **CRUD**  
- React UI：dashboard / agents / projects / goals / issues 列表页  
- Drizzle 的 PostgreSQL **schema**，`DATABASE_URL` 未设置时回退嵌入式 PostgreSQL  

V1 在此基线上扩展为以 **company** 为中心、可治理的 **control plane**。

## 5. V1 范围

## 5.1 范围内（In Scope）

- **Company** 生命周期（create/list/get/update/archive）  
- 与公司使命关联的 **goal** 层级  
- **Agent** 生命周期：组织结构 + **adapter** 配置  
- **Task/issue** 生命周期：父子层级 + 评论  
- **Atomic task checkout** + 显式 **issue status** 迁移  
- **board** 审批：招聘与 CEO 战略提案  
- **Heartbeat** 调用、状态跟踪与取消  
- **cost events** 摄入与汇总（agent/task/project/company）  
- **budget** 设置与硬停止执行  
- **board** Web UI：dashboard、组织结构图、任务、agents、审批、成本  
- **Agent** 向 API：**task** 读/写、heartbeat 上报、成本上报  
- 可审计 **activity log**：所有变更类动作  

## 5.2 范围外（V1 不做）

- 超越本地/自托管 **plugin runtime** 的云级插件市场/分发  
- 超出模型/token 费用的收入/支出会计  
- 知识库子系统  
- 公开市场（ClipHub）  
- 多 **board** 治理或细粒度人类 RBAC  
- 自动自愈编排（自动改派/重试规划器）  

## 6. 架构

## 6.1 运行时组件（Runtime Components）

- `server/`：REST API、鉴权、编排服务  
- `ui/`：**board** 操作界面  
- `packages/db/`：Drizzle schema、migration、DB 客户端（Postgres）  
- `packages/shared/`：共享 API 类型、校验器、常量  

## 6.2 数据存储（Data Stores）

- 主存储：PostgreSQL  
- 本地默认：嵌入式 PostgreSQL 路径 `~/.paperclip/instances/default/db`  
- 可选本地类生产：Docker Postgres  
- 可选托管：Supabase / 兼容 Postgres  
- 文件/对象存储：  
  - 本地默认：`~/.paperclip/instances/default/data/storage`（`local_disk`）  
  - 云：S3 兼容对象存储（`s3`）  

## 6.3 后台处理（Background Processing）

服务器进程内轻量 **scheduler/worker** 负责：

- heartbeat 触发检查  
- **stuck run** 检测  
- **budget** 阈值检查  

V1 不需要单独队列基础设施。

## 7. 规范数据模型 V1（Canonical Data Model）

除非另有说明，核心表均含 `id`、`created_at`、`updated_at`。

## 7.0 人类鉴权表（Auth Tables）

人类鉴权相关表（`users`、`sessions` 及各 **provider（身份提供方）** 附属结构）由所选鉴权库管理。本文将其视为必需依赖；需要人类归因时引用 `users.id`。

## 7.1 `companies`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`
- `pause_reason` text null
- `paused_at` timestamptz null
- `issue_prefix` text not null
- `issue_counter` int not null
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `attachment_max_bytes` int not null
- `require_board_approval_for_new_agents` boolean not null default false
- feedback sharing consent fields
- branding fields such as `brand_color`

不变量：**每条业务记录**恰属一家 **company**。

## 7.2 `agents`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `icon` text null
- `status` enum: `active | paused | idle | running | error | pending_approval | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` text; built-ins include `process`, `http`, `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `pi_local`, `cursor`, and `openclaw_gateway`
- `adapter_config` jsonb not null
- `runtime_config` jsonb not null default `{}`; may include Paperclip runtime policy such as `modelProfiles.cheap.adapterConfig` for an optional low-cost model lane that does not change the primary adapter config
- `default_environment_id` uuid fk `environments.id` null
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- pause fields: `pause_reason`, `paused_at`
- `permissions` jsonb not null default `{}`
- `last_heartbeat_at` timestamptz null
- `metadata` jsonb null

不变量：

- **agent** 与其 **manager（上级）** 须在同一 **company**  
- **reports_to** 树无环  
- `terminated` 的 **agent** 不可恢复（不可 resume）

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `company_id` uuid fk `companies.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

不变量：明文 **API key** 创建时只展示一次；库中仅存 **key_hash**。

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

不变量：每家 **company** 至少一条根级 `company` **goal**。

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null
- `env` jsonb null (same secret-aware env binding format used by agent config)

不变量：

- **project** 的 `env` 会并入该项目下 **issues** 的 **run environment（运行环境）**；与同 **agent** 的 env 冲突时优先 **project**，早于 Paperclip 运行时注入的自有键

## 7.6 `issues`（核心任务实体 / core task entity）

- `id` uuid pk
- `company_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `project_workspace_id` uuid fk `project_workspaces.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `assignee_agent_id` uuid fk `agents.id` null
- `assignee_user_id` text null
- checkout/execution locks: `checkout_run_id`, `execution_run_id`, `execution_agent_name_key`, `execution_locked_at`
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- identifier fields: `issue_number`, `identifier`
- origin fields: `origin_kind`, `origin_id`, `origin_run_id`, `origin_fingerprint`
- `request_depth` int not null default 0
- `billing_code` text null
- `assignee_adapter_overrides` jsonb null
- `execution_policy` jsonb null
- `execution_state` jsonb null
- execution workspace fields: `execution_workspace_id`, `execution_workspace_preference`, `execution_workspace_settings`
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null
- `hidden_at` timestamptz null

不变量：

- **单一 assignee**  
- 任务必须能经 `goal_id`、`parent_id` 或 **project–goal** 关联追溯至公司 **goal** 链  
- `in_progress` 必须有 **assignee**  
- 终态：`done | cancelled`

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

不变量：每条 **cost event** 必须挂到 **agent** 与 **company**；**rollups（汇总）** 仅由聚合得到，不可手改。

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy | budget_override_required | request_board_approval`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | revision_requested | approved | rejected | cancelled`
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

- **Secret** 明文不落库在 `agents.adapter_config.env` 内联。  
- **Agent** 的 env 条目对敏感值应使用 **secret refs（秘钥引用）**。  
- `company_secrets`：每 **company** 的身份/provider 元数据。  
- `company_secret_versions`：每版加密/引用材料。  
- 本地部署默认 provider：`local_encrypted`。

运维策略（Operational policy）：

- 配置读取 API 对敏感明文做 **redact（脱敏）**。  
- **activity** 与 **approval** payload 不得持久化原始敏感值。  
- 配置修订可含脱敏占位；此类字段不可从修订复原。  

## 7.13 必需索引（Required Indexes）

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

- `assets`：provider 侧对象元数据（不内联字节）：
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
- `issue_attachments`：把 **assets** 链到 **issues** / **comments**：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null

## 7.15 `documents` + `document_revisions` + `issue_documents`

- `documents`：可编辑、以文本为先的文档：
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
- `document_revisions`：仅追加历史：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `document_id` uuid fk not null
  - `revision_number` int not null
  - `body` text not null
  - `change_summary` text null
- `issue_documents`：文档挂到 **issues**，带稳定 workflow **key**：
  - `id` uuid pk
  - `company_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `document_id` uuid fk not null
  - `key` text not null (`plan`, `design`, `notes`, etc.)

## 7.16 当前实现增补（Current Implementation Addenda）

相对早期二月快照，当前实现还包含额外 V1 控制面表：

- **Issue** 结构与评审：**blocker** 用 `issue_relations`、`labels`/`issue_labels`、`issue_thread_interactions`、`issue_approvals`、`issue_execution_decisions`、`issue_work_products`、`issue_inbox_archives`、`issue_read_states` 及 issue 引用提及索引等。  
- **执行与工作区**：`execution_workspaces`、`project_workspaces`、`workspace_runtime_services`、`workspace_operations`、`environments`、`environment_leases`、`agent_task_sessions`、`agent_runtime_state`、`agent_wakeup_requests`、heartbeat 事件与 watchdog 决策表等。  
- **插件与例行**：`plugins` 及其 config/state/entities/jobs/logs/webhooks、plugin DB 命名空间/迁移、`routines` 等。  
- **访问与运营**：company membership、instance roles、principal permission grants、invites、join requests、board API keys、CLI auth challenges、budget policies/incidents、feedback 导出/投票、company skills、侧栏偏好、company logo 等。  

## 8. 状态机（State Machines）

## 8.1 Agent **status（状态）**

允许的迁移（Allowed transitions）：

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused` (requires cancel flow)
- `paused -> idle`
- `* -> terminated` (board only, irreversible)

## 8.2 Issue **status**

允许的迁移：

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- terminal: `done`, `cancelled`

副作用（Side effects）：

- 进入 `in_progress`：若 `started_at` 为空则写入  
- 进入 `done`：写入 `completed_at`  
- 进入 `cancelled`：写入 `cancelled_at`  

V1 **非终态存活（non-terminal liveness）** 规则：

- **agent** 持有的 `todo`、`in_progress`、`in_review`、`blocked` **issues** 必须落在「活跃执行路径 / 显式等待路径 / 显式恢复路径」之一。  
- `in_review` 仅当存在明确的下一动作归属（具名执行参与方、待处理 issue-thread 交互或审批、**user** owner、**active run**、队列中的 **wake**、或显式 **recovery issue**）才视为健康。  
- **blocked** 链仅当每个未解叶子 issue 都处于 live 或显式 waiting 才被覆盖。  
- 当 Paperclip 无法安全推断下一步时，应通过可见的 blocked/recovery 工作暴露问题，而非悄悄完成或改派。  

所有权、执行、阻塞、**active-run watchdog**、崩溃恢复与非终态存活语义的详解见 `doc/execution-semantics.md`。

## 8.3 Approval **status**

- `pending -> approved | rejected | cancelled`  
- 做出决策后即终态  

## 9. 鉴权与权限（Auth and Permissions）

## 9.1 Board 鉴权

- 人类操作者使用 **session** 鉴权  
- **Board** 对部署内所有 **company** 拥有完整读/写  
- 每次 **board** 变更写入 `activity_log`  

## 9.2 Agent 鉴权

- **Bearer** **API key** 绑定单一 **agent** 与 **company**  
- **Agent key** 权限范围：  
  - 读本 **company** 的组织/任务/公司上下文  
  - 读/写被指派的任务与评论  
  - 为委派创建任务/评论  
  - 上报 **heartbeat** 状态  
  - 上报 **cost events**  
- **Agent** 不得：  
  - 绕过 **approval gates（审批门）**  
  - 直接修改全公司 **budget**  
  - 改动鉴权/密钥体系  

## 9.3 权限矩阵 V1（Permission Matrix）

| Action（动作） | Board | Agent |
|---|---|---|
| 创建公司 Create company | yes | no |
| 招聘/创建 agent Hire/create agent | yes（直接） | request via approval |
| 暂停/恢复 agent Pause/resume agent | yes | no |
| 创建/更新任务 Create/update task | yes | yes |
| 强制改派任务 Force reassign task | yes | limited |
| 批准战略/招聘 Approve strategy/hire requests | yes | no |
| 上报成本 Report cost | yes | yes |
| 设置公司预算 Set company budget | yes | no |
| 设置下属预算 Set subordinate budget | yes | yes（仅 manager 子树） |

## 10. API 契约 REST（API Contract）

所有端点位于 `/api` 下，返回 JSON。

## 10.1 Companies（公司）

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `PATCH /companies/:companyId/branding`
- `POST /companies/:companyId/archive`

## 10.2 Goals（目标）

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents（代理）

- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (create API key)
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 Tasks（Issues / 工单）

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
- `POST /issues/:issueId/admin/force-release` (board-only lock recovery)
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 原子签出契约（Atomic Checkout Contract）

`POST /issues/:issueId/checkout` 请求体：

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

服务端行为（Server behavior）：

1. 单条 SQL `UPDATE`，条件 `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`  
2. 若更新行数为 0，返回 `409` 并带上当前 owner/status  
3. 成功则设置 `assignee_agent_id`、`status = in_progress`，并写 `started_at`  

`POST /issues/:issueId/admin/force-release` 是操作员恢复用端点，用于处置卡住的 harness 锁。需要 **board** 对该 issue 所属 **company** 的访问权限；清除 **checkout** 与 **execution run** 锁字段；若传 `clearAssignee=true` 可清空 **agent** 受指派人。路由必须写 `issue.admin_force_release` 的 **activity log**，包含先前 checkout 与 execution run id。

## 10.5 Projects（项目）

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 Approvals（审批）

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 Cost 与 Budgets（费用与预算）

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 Activity 与 Dashboard

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`

Dashboard **payload** 须包含：

- **active/running/paused/error** **agent** 数量  
- **open/in-progress/blocked/done** **issue** 数量  
- 月累计支出与 **budget** 利用率  
- 待处理 **approvals** 数量  

## 10.9 错误语义（Error Semantics）

- `400` validation error（校验失败）  
- `401` unauthenticated（未认证）  
- `403` unauthorized（未授权）  
- `404` not found  
- `409` state conflict（签出冲突、非法状态迁移）  
- `422` semantic rule violation（语义规则违反）  
- `500` server error  

## 10.10 当前实现 API 增补（Current Implementation API Addenda）

当前应用还暴露支撑 V1 的接口面，包括：

- **issue thread** 交互（`suggest_tasks`、`ask_user_questions`、`request_confirmation`）  
- **issue approvals**、引用/搜索、labels、read state、inbox/archive、**work products**  
- **execution workspaces**、**project workspaces**、**workspace runtime services**、**workspace operations**  
- **routines** 与 scheduled/API/webhook 触发  
- **plugin** 安装/配置/状态/jobs/logs/webhooks、plugin DB 命名空间迁移  
- **company** 导入导出预览/应用、feedback 导出/投票、实例备份/配置路由、invites、join requests、memberships、permission grants  

## 11. Heartbeat 与 Adapter 契约

## 11.1 Adapter 接口

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

## 11.2 Process Adapter

配置形态（Config shape）：

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

行为（Behavior）：

- **spawn** 子进程  
- 将 stdout/stderr 流式写入 **run logs**  
- 依退出码/超时标记 **run** 状态  
- **cancel** 先发 SIGTERM，**grace** 后再 SIGKILL  

## 11.3 HTTP Adapter

配置形态：

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

- 出站 HTTP 请求触发调用  
- `2xx` 视为已接受  
- 非 `2xx` 标记调用失败  
- 可选 **callback** 端点用于异步完成更新  

## 11.4 上下文投递（Context Delivery）

- `thin`：只发 ID 与指针；**agent** 经 API 拉上下文  
- `fat`：包含当前指派、**goal** 摘要、**budget** 快照、近期评论  

## 11.5 **Scheduler** 规则

`adapter_config` 内每 **agent** 调度字段：

- `enabled` boolean  
- `intervalSec` integer（最小 30）  
- `maxConcurrentRuns` integer；新 **agent** 默认 `1`；调度器把配置限制在 `1..1`（同一 **agent** 任意时刻仅允许一笔 `running` **run**，多 **issue** / 多唤醒在队列中串行处理）。同一 **company** 内，任意时刻最多允许 `4` 个不同的 **agent** 各自拥有至少一笔 `running` **run**（若第 5 个 **agent** 的 **run** 已排队，则暂不 **claim**，直至某一 **agent** 结束其唯一 **`running` run**）。  

下列情况**必须**跳过调用：

- **agent** 已 **paused** / **terminated**  
- 已有 **run** 处于 **active**  
- 已触及 **hard budget** 上限  

## 12. 治理与审批流（Governance and Approval Flows）

## 12.1 招聘（Hiring）

1. **Agent** 或 **board** 创建 `approval(type=hire_agent, status=pending, payload=agent draft)`。  
2. **Board** 批准或拒绝。  
3. 批准后服务端创建 **agent** 行与初始 **API key**（可选）。  
4. 决策写入 `activity_log`。  

**Board** 也可跳过请求流、在 UI 直接创建 **agent**；直接创建仍记为治理动作。

## 12.2 CEO 战略审批

1. CEO 以 `approval(type=approve_ceo_strategy)` 提交战略提案。  
2. **Board** 审阅 **payload**（计划文本、初始结构、高层任务）。  
3. 批准后解锁 CEO 创建委派工作的执行态。  

首次战略审批前，CEO 只能起草任务，不可切到活跃执行态。

## 12.3 **Board** 覆盖权

**Board** 可随时：

- 暂停/恢复/终止任意 **agent**  
- 改派或取消任意任务  
- 编辑 **budget** 与限制  
- 批准/拒绝/取消待处理 **approvals**  

## 13. 费用与预算系统（Cost and Budget System）

## 13.1 预算层级（Budget Layers）

- **company** 月度预算  
- **agent** 月度预算  
- 可选 **project** 预算（若配置）  

## 13.2 执行规则（Enforcement Rules）

- **soft alert** 默认阈值：80%  
- **hard limit** 在 100% 时触发：  
  - **agent** `status` 置 `paused`  
  - 阻止该 **agent** 新的 checkout/invocation  
  - 发出高优先级 **activity** 事件  

**Board** 可通过提高预算或显式恢复 **agent** 覆盖。

## 13.3 **Cost event** 摄入

`POST /companies/:companyId/cost-events` 请求体：

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

校验（Validation）：

- token 计数非负  
- `costCents >= 0`  
- 对所链实体做 **company** 归属检查  

## 13.4 **Rollups（汇总）**

V1 可接受运行时聚合查询；若延迟超标再引入物化汇总。

## 14. UI 要求（Board App）

V1 UI 路由：

- `/` dashboard  
- `/companies` 公司列表/创建  
- `/companies/:id/org` 组织图与 **agent** 状态  
- `/companies/:id/tasks` 任务列表/kanban  
- `/companies/:id/agents/:agentId` **agent** 详情  
- `/companies/:id/costs` 成本与预算  
- `/companies/:id/approvals` 待处理/历史审批  
- `/companies/:id/activity` 审计/事件流  

必需 UX：

- 全局 **company** 选择器  
- 快捷动作：暂停/恢复 **agent**、建任务、批/拒请求  
- 原子签出失败时 **toast** 冲突提示  
- 禁止静默失败；每次失败 **run** 在 UI 可见  

## 15. 运维要求（Operational Requirements）

## 15.1 Environment（环境）

- Node 20+  
- `DATABASE_URL` 可选；未设置则自动使用 `~/.paperclip/instances/default/db` 嵌入式 PostgreSQL  

## 15.2 Migrations（迁移）

- Drizzle **migrations** 为真相来源  
- 本地/dev 启动在支持处自动应用待处理迁移  
- `pnpm db:migrate` 手工应用  
- V1 升级路径不做破坏性原地迁移  

## 15.3 日志与审计

- **structured logs**（生产 JSON）  
- 每次 API 调用带 **request ID**  
- 每次变更写 `activity_log`  

## 15.4 可靠性目标

- 单 **company** 约 1k **tasks** 时，标准 CRUD 的 API **p95** < 250ms  
- **process adapter** 的 **heartbeat invoke** 确认 < 2s  
- **approval** 决策不丢失（事务写入）  

## 16. 安全要求（Security Requirements）

- **agent API keys** 仅存 **hash**  
- 日志脱敏（`adapter_config`、鉴权头、env）  
- **board** **session** 端点 **CSRF** 防护  
- 鉴权与密钥管理端点 **rate limit**  
- 每次实体读/写做强 **company** 边界检查  

## 17. 测试策略（Testing Strategy）

## 17.1 单元测试

- 状态迁移守卫（**agent** / **issue** / **approval**）  
- **budget** 执行规则  
- **adapter** 调用/cancel 语义  

## 17.2 集成测试

- 原子签出竞争  
- 审批到创建 **agent**  
- 成本摄入与汇总正确性  
- **run** 活跃时 **pause**（先优雅 **cancel** 再强杀）  

## 17.3 端到端测试

- **board** 建公司 → 雇 CEO → 批战略 → CEO 收到工作  
- **agent** 上报成本 → 达预算阈值 → 自动暂停  
- 跨团队委派与 **request_depth** 递增  

## 17.4 回归套件底线

发布候选必须在以下全部通过：

1. **auth** 边界  
2. **checkout** 竞态  
3. **hard budget** 停止  
4. **agent** 暂停/恢复  
5. **dashboard** 摘要与 DB 一致  

## 18. 交付计划（Delivery Plan）

当前实现说明：下列里程碑描述原始 V1 顺序；原标为后续工作的多项系统已实质上交付或推进，包括 issue 文档/交互、**blockers**、**routines**、**execution workspaces**、导入导出可移植、**authenticated** 部署、多用户基础与本地/自托管 **plugin runtime**。

## Milestone 1: Company Core and Auth

- 为既有实体增加 `companies` 与 **company** 作用域  
- **board** **session** 与 **agent** **API keys**  
- API 路由迁移为 **company** 感知路径  

## Milestone 2: Task and Governance Semantics

- 实现原子 **checkout** 端点  
- **issue** 评论与生命周期守卫  
- `approvals` 表与招聘/战略工作流  

## Milestone 3: Heartbeat and Adapter Runtime

- 实现 **adapter** 接口  
- 交付带 **cancel** 语义的 `process` **adapter**  
- 交付含超时/错误处理的 `http` **adapter**  
- 持久化 **heartbeat runs** 与状态  

## Milestone 4: Cost and Budget Controls

- **cost events** 摄入  
- 月度汇总与 **dashboard**  
- **hard limit** 自动暂停  

## Milestone 5: Board UI Completion

- **company** 选择器与组织图  
- 审批与成本页  

## Milestone 6: Hardening and Release

- 全套集成/e2e  
- 本地测试用 seed/demo **company** 模板  
- 发布清单与文档更新  

## 19. 验收标准（发布门）

仅当以下全为真，V1 才算完成：

1. **board** 用户可创建多家 **company** 并切换。  
2. 一家 **company** 至少能跑一个启用 **heartbeat** 的 **agent**。  
3. 任务签出并发安全，冲突返回 `409`。  
4. **Agent** 仅用 **API keys** 就能更新任务/评论并上报成本。  
5. **Board** 可在 UI 批准/拒绝招聘与 CEO 战略请求。  
6. **budget** 硬上限会暂停 **agent** 并阻止新调用。  
7. **Dashboard** 展示的计数/花费与实时 DB 一致。  
8. 每次变更可在 **activity log** 审计。  
9. 默认嵌入式 PostgreSQL 可运行；设 `DATABASE_URL` 时可用外部 Postgres。  

## 20. V1 后待办（Post-V1 Backlog）

- 云级插件市场/分发  
- 每团队更丰富的工作流状态定制  
- 超越 V1 最低限度的里程碑/标签/依赖图深度  
- 实时传输优化（SSE/WebSockets）  
- 公共模板市场集成（ClipHub）  

## 21. **Company** 可移植包（V1 附录）

V1 支持用可移植包契约做 **company** 导入/导出：

- 以 `COMPANY.md` 为根的 **markdown-first** 包  
- 约定式隐式目录发现  
- `.paperclip.yaml` **sidecar（侧车文件）** 承载 Paperclip 特有保真度  
- 规范基包 vendor-neutral，对齐 `docs/公司/01 公司规范 companies-spec.md`  
- 常见约定：  
  - `agents/<slug>/AGENTS.md`  
  - `teams/<slug>/TEAM.md`  
  - `projects/<slug>/PROJECT.md`  
  - `projects/<slug>/tasks/<slug>/TASK.md`  
  - `tasks/<slug>/TASK.md`  
  - `skills/<slug>/SKILL.md`  

V1 导出/导入行为：

- **export** 产出干净 markdown 包 + `.paperclip.yaml`  
- **projects** 与启动任务为可选导出，而非默认包内容  
- 重复 `TASK.md` 条目在基包用 `recurring: true`，在 `.paperclip.yaml` 保持 Paperclip **routine** 保真  
- 导入重复任务包时作为 **routines**，不降格为一次性 **issues**  
- **export** 剥离环境相关路径（`cwd`、本地说明文件路径、内联 prompt 重复），但保留可移植的 `repoUrl`、refs、`.paperclip.yaml` 键控的 workspace 策略引用  
- **export** 永不包含秘钥明文；env 以可移植声明报告  
- **import** 目标模式：新建 **company**；或导入到已有 **company**  
- **import** 重建导出的 **project workspaces**，并把可移植 workspace 键映射回目标本地 id  
- **import** 强制关闭导入 **agent** 的定时 **heartbeat**，避免包隐式启动定时 run  
- **import** 碰撞策略：`rename`、`skip`、`replace`  
- **import** 支持 apply 前 **preview（dry-run）**  
- GitHub 导入对未 pin 的 ref **警告**而非阻断  
