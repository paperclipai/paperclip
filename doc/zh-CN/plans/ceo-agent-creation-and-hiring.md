# CEO 智能体创建和招聘治理计划 (V1.1)

状态： 拟定
日期：2026-02-19
所有者：产品+服务器+UI+技能

## 1. 目标

使 CEO 智能体能够通过轻量级但明确的治理直接创建新智能体：

- 公司级别切换：新员工需要董事会批准（默认开启）。
- 座席级权限：`can_create_agents`（CEO 默认开启，其他人默认关闭）。
- 明确招聘工作流程以及草案/不确定状态，直至获得批准。
- 配置反射，以便招聘智能体可以检查可用的适配器配置并比较现有的智能体配置（包括自身配置）。
- 批准协作流程，包括评论、修订请求和审计跟踪。

## 2. 当前状态（回购现实）

- 智能体创建仅在 `POST /api/companies/:companyId/agents` (`server/src/routes/agents.ts`) 上进行。
- 审批支持`pending/approved/rejected/cancelled`和`hire_agent` + `approve_ceo_strategy`（`packages/shared/src/constants.ts`、`server/src/services/approvals.ts`）。
- `hire_agent` 审批目前仅在审批后创建智能体；没有预先创建的地狱状态智能体。
- 目前没有智能体权限系统。
- 公司没有“新员工需要董事会批准”的规定。
- 批准没有评论线程或修订请求状态。
- 收件箱和审批 UI 仅支持批准/拒绝；应用路由中不存在审批详情路由。
- 智能体适配器配置为自由格式 JSON；不存在用于机器可读或文本发现的运行时反射端点。

## 3. 产品决策

## 3.1 公司设置

添加公司设置：

- `requireBoardApprovalForNewAgents: boolean`
- 默认：`true`
- 只能在公司高级设置中编辑（不可在入职/公司创建流程 UI 中编辑）

## 3.2 智能体权限

现在引入一种具有显式权限的轻量级权限模型：

- `can_create_agents: boolean`

默认值：

- 首席执行官：`true`
- 其他人：`false`

权威机构：

- 董事会可以编辑任何智能体的权限。
- CEO可以编辑同一公司内智能体的权限。

此阶段没有更广泛的 RBAC 系统。

## 3.3 招聘的不确定状态

引入专用的非运行状态：

- `pending_approval`

含义：

- 智能体记录存在于组织树中并且可以查看。
- 在获得批准之前，智能体无法运行、接收分配、创建密钥或恢复到活动状态。

## 4. 数据模型更改

## 4.1 `companies`

添加列：

- `require_board_approval_for_new_agents` 布尔值不为空默认值 `true`

需要同步：

- `packages/db/src/schema/companies.ts`
- `packages/shared/src/types/company.ts`
- `packages/shared/src/validators/company.ts`
- UI公司API类型使用及公司高级设置表格

## 4.2 `agents`

添加列：

- `permissions` jsonb 不为 null 默认 `{}`
- 状态值扩展为包括 `pending_approval`

需要同步：

- `packages/db/src/schema/agents.ts`
- `packages/shared/src/constants.ts` (`AGENT_STATUSES`)
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/validators/agent.ts`
- UI 中的状态徽章、过滤器和生命周期控制

## 4.3 `approvals`将批准保留为中央治理记录；扩展工作流程支持：

- 添加状态`revision_requested`
- 确保雇用批准的有效负载包含：
  - `agentId`
  - `requestedByAgentId`
  - `requestedConfigurationSnapshot`

## 4.4 新建 `approval_comments` 表

添加批准讨论线程：

- `id`、`company_id`、`approval_id`、`author_agent_id`、`author_user_id`、`body`、时间戳

目的：

- 评论评论
- 修改请求
- 批准/拒绝的理由
- 永久审计追踪

## 5. API 和 AuthZ 计划

## 5.1 权限助手

添加服务器端 authz 帮助程序：

- `assertCanCreateAgents(req, companyId)`
- `assertCanManageAgentPermissions(req, companyId)`

规则：

- 董事会总是通过。
- 智能体通过`can_create_agents`检查自我许可是否真实且同一公司。
- 由首席执行官或董事会进行权限管理。

## 5.2 雇用创建流程

添加路线：

- `POST /api/companies/:companyId/agent-hires`

行为：

- 需要 `can_create_agents`（或板）。
- 首先创建智能体行。
- 如果公司设置需要批准：
  - 使用 `status=pending_approval` 创建智能体
  - 创建`approvals(type=hire_agent,status=pending,payload.agentId=...)`
  - 返回两个智能体+批准
- 如果设置被禁用：
  - 创建智能体为 `idle`
  - 无需审批记录

董事会可能会继续使用直接创建路线，但此路线成为首席执行官/智能体人主导的招聘的规范。

## 5.3 审批工作流程端点

添加/扩展：

- `GET /api/approvals/:id`
- `POST /api/approvals/:id/request-revision`
- `POST /api/approvals/:id/resubmit`
- `GET /api/approvals/:id/comments`
- `POST /api/approvals/:id/comments`

更新现有的批准/拒绝语义：

- 批准雇用过渡链接智能体`pending_approval -> idle`
- 拒绝使链接智能体处于非活动状态（`pending_approval` 或 `terminated`/稍后清除）

## 5.4 智能体权限管理端点

添加：

- `PATCH /api/agents/:id/permissions`

仅支持初始密钥：

- `{ "canCreateAgents": boolean }`

## 5.5 读取配置端点（受保护）

添加权限控制的配置读取端点：

- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/agents/:id/configuration`

访问：

- 板
- 首席执行官
- 任何带有`can_create_agents`的智能体

安全性：

- 从适配器配置中编辑明显的秘密值（`env`、API 密钥、令牌、JWT 外观值）
- 在响应中包含编辑标记

## 5.6 适配器配置的反射端点

添加纯文本反射路由：

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`

索引文件包括：

- 此 Paperclip 实例已安装的适配器列表
- 每个适配器的文档 URL
- 简要“如何雇用”API 序列链接

每个适配器文件包括：

- 必需/可选配置键
- 默认值
- 字段描述
- 安全注意事项
- 负载示例

授权：

- 与配置读取端点相同的门（board/CEO/`can_create_agents`）。

## 6. 适配器协议扩展

扩展 `ServerAdapterModule` 合约以公开配置文档：

- `agentConfigurationDoc`（字符串）或 `getAgentConfigurationDoc()`

实施于：

- `packages/adapters/claude-local`
- `packages/adapters/codex-local`
- `server/src/adapters/registry.ts`

这是必需的，以便从已安装的适配器生成反射，而不是硬编码。

## 7. UI 计划## 7.1 公司高级设置

在 Companies UI 中，添加高级设置面板/模式：

- 切换：“雇用新智能体需要董事会批准”（默认开启）

未显示在入职流程中。

## 7.2 智能体权限UI

在智能体详细信息中（董事会/首席执行官背景）：

- 权限部分
- 切换“可以创建新智能体”

## 7.3 雇用用户体验

添加“雇用智能体”流程（适用于首席执行官/授权智能体）：

- 选择角色/姓名/职务/报告对象
- 撰写初始提示/功能
- 检查适配器反射文档
- 检查现有的相关智能体配置
- 提交租金

状态消息：

- 如果需要批准：显示“待董事会批准”
- 如果不需要：显示活动就绪状态

## 7.4 批准用户体验

添加审批详细信息页面并扩展收件箱集成：

- `/approvals/:approvalId`
- 线索评论
- 修改请求行动
- 批准/拒绝并附有决定说明
- 活动时间表（创建、修订、决定）

## 7.5 未批准的智能体清理

在批准详细信息中提供仅限董事会的破坏性操作：

- “删除未批准的智能体”
- 明确的确认对话框
- 保留批准+评论历史记录（审核）

## 8.新技能：`paperclip-create-agent`

创建新的技能目录：

- `skills/paperclip-create-agent/SKILL.md`
- `skills/paperclip-create-agent/references/api-reference.md`

技能职责：

- 通过 `/llms/agent-configuration*.txt` 发现可用的适配器配置
- 读取现有的智能体配置（包括自身和相关角色）
- 提出最适合当前环境的配置
- 为新智能体起草高质量的初始提示
- 设置经理/汇报线
- 执行租用API流程
- 使用董事会评论处理修订循环

另请更新 `skills/paperclip/SKILL.md` 以在招聘工作流程中引用此技能。

## 9. 执行和不变量

新的/更新的不变量：

- `pending_approval` 智能体不能：
  - 被召唤/唤醒
  - 被分配的问题
  - 创建或使用 API 密钥
  - 过渡到活跃的生命周期状态，除非通过雇用批准
- 批准转换：
  - `pending -> revision_requested | approved | rejected | cancelled`
  - `revision_requested -> pending | rejected | cancelled`
- 每个突变都会写入 `activity_log` 记录。

## 10. 实施阶段

## 第 1 阶段：合同和迁移

- 数据库架构更新（`companies`、`agents`、审批状态扩展、`approval_comments`）
- 共享常量/类型/验证器更新
- 迁移生成和类型检查

## 第 2 阶段：服务器授权 + 租用流程

- 权限解析器和授权守卫
- `agent-hires`路线
- 心跳/问题/关键流程中的边缘状态强制执行
- 批准修订/评论端点

## 第 3 阶段：反射和配置读取 APIs

- 适配器协议文档支持
- `/llms/agent-configuration*.txt` 航线
- 通过编辑保护配置读取端点

## 第 4 阶段：UI 和技能

- 公司高级设置UI
- 权限控制
- 收件箱/批准中的批准详细信息+评论/修订流程
- 未批准的智能体删除流程
- `paperclip-create-agent` 技能+文档更新## 11. 测试计划

服务器测试：

- 雇用/配置读取/权限更新端点的权限门测试
- 雇用创造行为与公司设置开/关
- 批准过渡，包括修订周期
- 唤醒/调用/分配/按键之间的pending_approval强制执行
- 配置编辑测试

用户界面测试：

- 高级设置切换持久性
- 批准详细评论/修订交互
- 租赁流程状态（待定与立即）

合并前的回购验证：

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## 12. 风险和缓解措施

- 风险：通过智能体配置读取泄露机密。
  - 缓解措施：严格的编辑通过 + 允许名单/拒绝名单测试。
- 风险：状态爆炸的复杂性。
  - 缓解措施：具有显式转换保护的单个添加状态（`pending_approval`）。
- 风险：审批流程回归。
  - 缓解措施：将转换逻辑集中在审批服务中并通过测试进行支持。

## 13. 开放决策（默认推荐）

1. 董事会是否应该直接创建绕过审批设置？
建议：是的，董事会具有明确的治理优先权。

2. 未经授权的座席是否仍应看到基本的座席元数据？
建议：是（名称/角色/状态），但配置字段仍然受到限制。

3. 拒绝后，Limbo Agent 应该保留 `pending_approval` 还是移动到 `terminated`？
建议：最终拒绝时移至`terminated`；保留可选的硬删除操作以进行清理。