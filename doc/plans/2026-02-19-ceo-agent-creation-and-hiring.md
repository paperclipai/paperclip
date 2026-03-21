# CEO 智能体创建和招聘治理计划（V1.1）

状态：提议
日期：2026-02-19
负责人：产品 + 服务器 + UI + 技能

## 1. 目标

使 CEO 智能体能够直接创建新智能体，具有轻量但显式的治理：

- 公司级开关：新招聘需要董事会审批（默认开启）。
- 智能体级权限：`can_create_agents`（CEO 默认开启，其他人默认关闭）。
- 清晰的招聘工作流，在审批前有草稿/待定状态。
- 配置反射，使招聘智能体可以检查可用的适配器配置和比较现有智能体配置（包括自身）。
- 带评论、修改请求和审计跟踪的审批协作流程。

## 2. 当前状态（仓库现实）

- 智能体创建仅限董事会在 `POST /api/companies/:companyId/agents`（`server/src/routes/agents.ts`）。
- 审批支持 `pending/approved/rejected/cancelled` 和 `hire_agent` + `approve_ceo_strategy`（`packages/shared/src/constants.ts`、`server/src/services/approvals.ts`）。
- `hire_agent` 审批当前仅在审批通过时创建智能体；没有预创建的待定智能体。
- 目前没有智能体权限系统。
- 没有"新招聘需要董事会审批"的公司设置。
- 审批没有评论线程或修改请求状态。
- 收件箱和审批 UI 仅支持批准/拒绝；应用路由中不存在审批详情路由。
- 智能体适配器配置是自由形式 JSON；不存在用于机器可读或文本发现的运行时反射端点。

## 3. 产品决策

## 3.1 公司设置

添加公司设置：

- `requireBoardApprovalForNewAgents: boolean`
- 默认：`true`
- 仅在公司高级设置中可编辑（不在入门/公司创建流程 UI 中）

## 3.2 智能体权限

引入具有一个显式权限的轻量级权限模型：

- `can_create_agents: boolean`

默认值：

- CEO：`true`
- 其他人：`false`

权限：

- 董事会可以编辑任何智能体的权限。
- CEO 可以编辑同公司智能体的权限。

本阶段不引入更广泛的 RBAC 系统。

## 3.3 招聘待定状态

引入专用的非运营状态：

- `pending_approval`

含义：

- 智能体记录存在于组织树中，可以被审查。
- 在审批通过之前，智能体不能运行、接收分配、创建密钥或恢复为活跃状态。

## 4. 数据模型变更

## 4.1 `companies`

添加列：

- `require_board_approval_for_new_agents` boolean not null default `true`

需同步：

- `packages/db/src/schema/companies.ts`
- `packages/shared/src/types/company.ts`
- `packages/shared/src/validators/company.ts`
- UI 公司 API 类型使用和公司高级设置表单

## 4.2 `agents`

添加列：

- `permissions` jsonb not null default `{}`
- 状态值扩展以包含 `pending_approval`

需同步：

- `packages/db/src/schema/agents.ts`
- `packages/shared/src/constants.ts`（`AGENT_STATUSES`）
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/validators/agent.ts`
- UI 中的状态徽章、筛选器和生命周期控制

## 4.3 `approvals`

保持审批作为中心治理记录；扩展工作流支持：

- 添加状态 `revision_requested`
- 确保招聘审批的负载包含：
  - `agentId`
  - `requestedByAgentId`
  - `requestedConfigurationSnapshot`

## 4.4 新表 `approval_comments`

为审批添加讨论线程：

- `id`、`company_id`、`approval_id`、`author_agent_id`、`author_user_id`、`body`、时间戳

用途：

- 审查评论
- 修改请求
- 批准/拒绝的理由
- 永久审计跟踪

## 5. API 和授权计划

## 5.1 权限助手

添加服务器端授权助手：

- `assertCanCreateAgents(req, companyId)`
- `assertCanManageAgentPermissions(req, companyId)`

规则：

- 董事会总是通过。
- 如果自身权限为 true 且同公司，智能体通过 `can_create_agents` 检查。
- 权限管理由 CEO 或董事会执行。

## 5.2 招聘创建流程

添加路由：

- `POST /api/companies/:companyId/agent-hires`

行为：

- 需要 `can_create_agents`（或董事会）。
- 先创建智能体行。
- 如果公司设置需要审批：
  - 以 `status=pending_approval` 创建智能体
  - 创建 `approvals(type=hire_agent,status=pending,payload.agentId=...)`
  - 返回智能体 + 审批
- 如果设置禁用：
  - 以 `idle` 创建智能体
  - 不需要审批记录

董事会可以继续使用直接创建路由，但此路由成为 CEO/智能体主导招聘的规范路径。

## 5.3 审批工作流端点

添加/扩展：

- `GET /api/approvals/:id`
- `POST /api/approvals/:id/request-revision`
- `POST /api/approvals/:id/resubmit`
- `GET /api/approvals/:id/comments`
- `POST /api/approvals/:id/comments`

更新现有批准/拒绝语义：

- 招聘审批通过将关联智能体从 `pending_approval -> idle`
- 拒绝保持关联智能体在非活跃状态（`pending_approval` 或 `terminated`/后续清理）

## 5.4 智能体权限管理端点

添加：

- `PATCH /api/agents/:id/permissions`

支持初始键：

- `{ "canCreateAgents": boolean }`

## 5.5 读取配置端点（受保护）

添加权限受控的配置读取端点：

- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/agents/:id/configuration`

访问：

- 董事会
- CEO
- 任何具有 `can_create_agents` 的智能体

安全：

- 从适配器配置中脱敏明显的秘密值（`env`、API 密钥、Token、JWT 样式的值）
- 在响应中包含脱敏标记

## 5.6 适配器配置的反射端点

添加纯文本反射路由：

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`

索引文件包含：

- 此 Paperclip 实例安装的适配器列表
- 每适配器文档 URL
- 简短的"如何招聘"API 序列链接

每适配器文件包含：

- 必需/可选配置键
- 默认值
- 字段描述
- 安全说明
- 示例负载

认证：

- 与配置读取端点相同的门控（董事会/CEO/`can_create_agents`）。

## 6. 适配器协议扩展

扩展 `ServerAdapterModule` 合约以暴露配置文档：

- `agentConfigurationDoc`（string）或 `getAgentConfigurationDoc()`

在以下位置实现：

- `packages/adapters/claude-local`
- `packages/adapters/codex-local`
- `server/src/adapters/registry.ts`

这是必需的，以便反射从安装的适配器生成，而不是硬编码。

## 7. UI 计划

## 7.1 公司高级设置

在公司 UI 中，添加高级设置面板/模态框：

- 开关："新智能体招聘需要董事会审批"（默认开启）

不在入门流程中显示。

## 7.2 智能体权限 UI

在智能体详情中（董事会/CEO 上下文）：

- 权限部分
- "可以创建新智能体"的开关

## 7.3 招聘 UX

添加"招聘智能体"流程（用于 CEO/授权智能体）：

- 选择角色/名称/职称/汇报对象
- 编写初始提示/能力
- 检查适配器反射文档
- 检查现有相关智能体配置
- 提交招聘

状态消息：

- 如果需要审批：显示"待董事会审批"
- 如果不需要：显示活跃就绪状态

## 7.4 审批 UX

添加审批详情页面并扩展收件箱集成：

- `/approvals/:approvalId`
- 线程化评论
- 修改请求操作
- 带决策说明的批准/拒绝
- 活动时间线（创建、修改、决策）

## 7.5 被拒绝智能体清理

在审批详情中提供仅董事会的破坏性操作：

- "删除被拒绝的智能体"
- 显式确认对话框
- 保留审批 + 评论历史（审计）

## 8. 新技能：`paperclip-create-agent`

创建新技能目录：

- `skills/paperclip-create-agent/SKILL.md`
- `skills/paperclip-create-agent/references/api-reference.md`

技能职责：

- 通过 `/llms/agent-configuration*.txt` 发现可用的适配器配置
- 读取现有智能体配置（包括自身和相关角色）
- 为当前环境提出最佳匹配配置
- 为新智能体起草高质量初始提示
- 设置管理者/汇报线
- 执行招聘 API 流程
- 处理与董事会评论的修改循环

同时更新 `skills/paperclip/SKILL.md` 以引用此技能用于招聘工作流。

## 9. 强制执行和不变量

新增/更新的不变量：

- `pending_approval` 智能体不能：
  - 被调用/唤醒
  - 被分配任务
  - 创建或使用 API 密钥
  - 除通过招聘审批外转换为活跃生命周期状态
- 审批转换：
  - `pending -> revision_requested | approved | rejected | cancelled`
  - `revision_requested -> pending | rejected | cancelled`
- 每次变更写入 `activity_log` 记录。

## 10. 实现阶段

## 阶段 1：合约和迁移

- 数据库模式更新（`companies`、`agents`、审批状态扩展、`approval_comments`）
- 共享常量/类型/验证器更新
- 迁移生成和类型检查

## 阶段 2：服务器授权 + 招聘流程

- 权限解析器和授权守卫
- `agent-hires` 路由
- 待定状态在心跳/任务/密钥流程中的强制执行
- 审批修改/评论端点

## 阶段 3：反射和配置读取 API

- 适配器协议文档支持
- `/llms/agent-configuration*.txt` 路由
- 带脱敏的受保护配置读取端点

## 阶段 4：UI 和技能

- 公司高级设置 UI
- 权限控制
- 收件箱/审批中的审批详情 + 评论/修改流程
- 被拒绝智能体删除流程
- `paperclip-create-agent` 技能 + 文档更新

## 11. 测试计划

服务器测试：

- 招聘/配置读取/权限更新端点的权限门控测试
- 公司设置开启/关闭时的招聘创建行为
- 包括修改循环在内的审批转换
- 唤醒/调用/分配/密钥中的 pending_approval 强制执行
- 配置脱敏测试

UI 测试：

- 高级设置开关持久化
- 审批详情评论/修改交互
- 招聘流程状态（待处理 vs 立即）

合并前仓库验证：

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## 12. 风险和缓解

- 风险：通过智能体配置读取泄露秘密。
  - 缓解：严格的脱敏传递 + 白名单/黑名单测试。
- 风险：状态爆炸复杂性。
  - 缓解：仅添加一个状态（`pending_approval`），带有显式转换守卫。
- 风险：审批流程回归。
  - 缓解：在审批服务中集中转换逻辑并用测试支撑。

## 13. 待决定（默认建议）

1. 董事会直接创建是否应绕过审批设置？
建议：是，董事会是显式的治理覆盖。

2. 未授权的智能体是否仍应看到基本智能体元数据？
建议：是（名称/角色/状态），但配置字段保持受限。

3. 拒绝后，待定智能体应保持 `pending_approval` 还是转为 `terminated`？
建议：最终拒绝时转为 `terminated`；保留可选的硬删除操作用于清理。
