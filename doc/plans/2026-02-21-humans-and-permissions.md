# 用户与权限计划

状态：草案
日期：2026-02-21
负责方：Server + UI + Shared + DB

## 目标

添加一等公民的人类用户和权限系统，同时保留两种部署模式：

- 本地受信单用户模式，无登录摩擦
- 云托管多用户模式，强制认证和授权

## 为什么需要这个计划

当前 V1 的假设是以单个 board 操作员为中心。我们现在需要：

- 多用户协作，带有用户级权限
- 安全的云部署默认值（防止意外的无登录生产环境）
- 本地模式仍然感觉即时（`npx paperclipai run` 即可开始）
- 智能体到用户的任务委派，包括人类收件箱
- 一个用户账号可以在同一部署中访问多个公司
- 实例管理员可以跨实例管理公司访问权限
- 加入审批作为可操作的收件箱告警呈现，而非隐藏在仅管理员页面中
- 对人类和智能体提供对称的邀请-审批入职路径
- 人类和智能体共享统一的成员资格和权限模型

## 产品约束

1. 对每个新表、端点和权限检查保持严格的公司作用域。
2. 保留现有控制平面不变式：

- 单一受理人任务模型
- 审批门禁
- 预算硬停行为
- 变更活动日志

3. 保持本地模式简单且受信，但防止不安全的云部署姿态。

## 部署模式

## 模式 A：`local_trusted`

行为：

- 无登录 UI
- 浏览器直接打开进入 board 上下文
- 嵌入式数据库和本地存储默认值保持不变
- 存在一个本地隐式人类 actor 用于归属
- 本地隐式 actor 对该实例具有有效的 `instance_admin` 权限
- 本地模式下可使用全部邀请/审批/权限设置流程（包括智能体注册）

保护措施：

- 服务器默认绑定到回环地址
- 如果模式为 `local_trusted` 但绑定了非回环地址则启动失败
- UI 显示持久的"本地受信模式"标识

## 模式 B：`cloud_hosted`

行为：

- 所有人类端点需要登录
- 使用 Better Auth 进行人类认证
- 初始认证方式：邮箱 + 密码
- 首次发布不要求邮箱验证
- 支持托管数据库和远程部署
- 多用户会话和角色/权限强制

保护措施：

- 如果认证提供者/会话配置缺失则启动失败
- 如果设置了不安全的认证绕过标志则启动失败
- 健康检查负载包含模式和认证就绪状态

## 认证选择

- 使用 Better Auth 进行人类用户认证
- 从仅邮箱/密码登录开始
- V1 无邮箱确认要求
- 保持实现结构化，以便后续可以添加社交/SSO 提供者而不改变成员资格/权限语义

## 认证和 Actor 模型

将请求 actor 统一为单一模型：

- `user`（已认证的人类用户）
- `agent`（API 密钥）
- `local_board_implicit`（仅本地受信模式）

规则：

- 在 `cloud_hosted` 中，只有 `user` 和 `agent` 是有效 actor
- 在 `local_trusted` 中，未认证的浏览器/API 请求解析为 `local_board_implicit`
- `local_board_implicit` 对本地操作被授权为实例管理员主体
- 所有变更操作继续用 actor 类型/ID 写入 `activity_log`

## 首次管理员引导

问题：

- 新的云部署需要安全、显式的首次人类管理员路径
- 应用不能假设预先存在管理员账号
- `local_trusted` 不使用引导流程，因为隐式本地实例管理员已经存在

引导流程：

1. 如果该部署不存在 `instance_admin` 用户，实例处于 `bootstrap_pending` 状态。
2. CLI 命令 `pnpm paperclipai auth bootstrap-ceo` 为该实例创建一次性 CEO 入职邀请 URL。
3. `pnpm paperclipai onboard` 运行此引导检查，并在 `bootstrap_pending` 时自动打印邀请 URL。
4. 在 `bootstrap_pending` 状态下访问应用时显示一个阻塞的设置页面，包含要运行的确切 CLI 命令（`pnpm paperclipai onboard`）。
5. 接受该 CEO 邀请创建第一个管理员用户并退出引导模式。

安全规则：

- 引导邀请是一次性的、短期的，token 哈希静态存储
- 每个实例同时只能有一个活跃的引导邀请（重新生成会撤销之前的 token）
- 引导操作在 `activity_log` 中审计

## 数据模型新增

## 新表

1. `users`

- 人类用户的身份记录（基于邮箱）
- 可选的实例级角色字段（或伴随表）用于管理权限

2. `company_memberships`

- `company_id`、`principal_type`（`user | agent`）、`principal_id`
- 状态（`pending | active | suspended`）、角色元数据
- 存储人类和智能体的有效访问状态
- 多对多：一个主体可以属于多个公司

3. `invites`

- `company_id`、`invite_type`（`company_join | bootstrap_ceo`）、token 哈希、expires_at、invited_by、revoked_at、accepted_at
- 一次性分享链接（无预绑定邀请邮箱）
- `allowed_join_types`（`human | agent | both`）用于 `company_join` 链接
- 可选的默认负载按加入类型区分：
  - 人类默认值：初始权限/成员角色
  - 智能体默认值：建议的角色/标题/适配器默认值

4. `principal_permission_grants`

- `company_id`、`principal_type`（`user | agent`）、`principal_id`、`permission_key`
- 显式授权如 `agents:create`
- 包含指挥链限制的作用域负载
- 规范化表（非 JSON blob），便于审计授权/撤销历史

5. `join_requests`

- `invite_id`、`company_id`、`request_type`（`human | agent`）
- `status`（`pending_approval | approved | rejected`）
- 通用审核元数据：
  - `request_ip`
  - `approved_by_user_id`、`approved_at`、`rejected_by_user_id`、`rejected_at`
- 人类请求字段：
  - `requesting_user_id`、`request_email_snapshot`
- 智能体请求字段：
  - `agent_name`、`adapter_type`、`capabilities`、`created_agent_id` 审批前可为空
- 每个已消费的邀请在选择加入类型后恰好创建一条加入请求记录

6. `issues` 扩展

- 添加 `assignee_user_id` 可空
- 通过 XOR 检查保留单一受理人不变式：
  - `assignee_agent_id` / `assignee_user_id` 中恰好零个或一个非空

## 兼容性

- 现有的 `created_by_user_id` / `author_user_id` 字段保留并变为完全活跃
- 智能体 API 密钥仍然是认证凭据；成员资格 + 授权仍然是授权来源

## 权限模型（初始集）

原则：

- 人类和智能体使用相同的成员资格 + 授权评估引擎
- 权限检查对两种 actor 类型都根据 `(company_id, principal_type, principal_id)` 进行解析
- 这避免了独立的 authz 代码路径并保持行为一致

角色层级：

- `instance_admin`：部署范围的管理员，可以访问/管理所有公司和用户-公司访问映射
- `company_member`：仅公司范围的权限

核心授权：

1. `agents:create`
2. `users:invite`
3. `users:manage_permissions`
4. `tasks:assign`
5. `tasks:assign_scope`（组织约束的委派）
6. `joins:approve`（批准/拒绝人类和智能体加入请求）

额外行为规则：

- 实例管理员可以提升/降级实例管理员并管理跨公司的用户访问
- board 级别用户可以在其控制的公司内管理公司授权
- 非管理员主体只能在显式授权范围内行动
- 分配检查对智能体和人类受理人均适用

## 指挥链作用域设计

初始方案：

- 将分配作用域表示为组织层级上的允许规则
- 示例：
  - `subtree:<agentId>`（可以分配到该管理者子树中）
  - `exclude:<agentId>`（不能分配给受保护角色，例如 CEO）

强制执行：

- 解析目标受理人的组织位置
- 在分配变更前评估允许/拒绝作用域规则
- 对超出作用域的分配返回 `403`

## 邀请和注册流程

1. 授权用户创建一个 `company_join` 邀请分享链接，包含可选的默认值 + 过期时间。
2. 系统发送包含一次性 token 的邀请 URL。
3. 邀请落地页展示两条路径：`以人类身份加入` 或 `以智能体身份加入`（受 `allowed_join_types` 约束）。
4. 请求者选择加入路径并提交所需数据。
5. 提交消费 token 并创建 `pending_approval` 加入请求（尚无访问权限）。
6. 加入请求捕获审核元数据：

- 人类：已认证邮箱
- 两者：来源 IP
- 智能体：建议的智能体元数据

7. 公司管理员/实例管理员审核请求并批准或拒绝。
8. 批准时：

- 人类：激活 `company_membership` 并应用权限授权
- 智能体：创建智能体记录并启用 API 密钥认领流程

9. 链接是一次性的，不能重复使用。
10. 邀请者/管理员可以在接受前撤销邀请。

安全规则：

- 邀请 token 静态哈希存储
- 一次性使用 token，短期有效
- 所有邀请生命周期事件记录在 `activity_log` 中
- 待审批用户在获得批准前不能读取或修改任何公司数据

## 加入审批收件箱

- 加入请求为符合条件的审批者（`joins:approve` 或管理员角色）生成收件箱告警
- 告警同时出现在：
  - 全局/公司收件箱 feed
  - 专用的待审批 UI
- 每个告警包含内联的批准/拒绝操作（无需切换上下文）
- 告警负载必须包含：
  - 当 `request_type=human` 时的请求者邮箱
  - 来源 IP
  - 请求类型（`human | agent`）

## 人类收件箱和智能体到人类的委派

行为：

- 当策略允许时，智能体可以将任务分配给人类
- 人类在收件箱视图中看到分配的任务（包括本地受信模式）
- 评论和状态转换遵循相同的任务生命周期保护

## 智能体加入路径（通过统一邀请链接）

1. 授权用户分享一个 `company_join` 邀请链接（`allowed_join_types` 包含 `agent`）。
2. 智能体操作者打开链接，选择 `以智能体身份加入`，并提交加入负载（名称/角色/适配器元数据）。
3. 系统创建 `pending_approval` 智能体加入请求并捕获来源 IP。
4. 审批者在收件箱中看到告警并批准或拒绝。
5. 审批后，服务器创建智能体记录并生成长期 API 密钥。
6. API 密钥通过安全认领流程仅显示一次，并附带显式的"立即保存"提示。

长期 token 策略：

- 默认使用长期可撤销的 API 密钥（静态哈希存储）
- 仅显示一次明文密钥
- 支持从管理 UI 立即撤销/重新生成
- 后续可选择添加过期/轮换策略而不改变加入流程

API 新增（建议）：

- `GET /companies/:companyId/inbox`（人类 actor 作用域到自身；当授权时包含任务项 + 待审批加入告警）
- `POST /companies/:companyId/issues/:issueId/assign-user`
- `POST /companies/:companyId/invites`
- `GET /invites/:token`（邀请落地页负载包含 `allowed_join_types`）
- `POST /invites/:token/accept`（body 包含 `requestType=human|agent` 和请求元数据）
- `POST /invites/:inviteId/revoke`
- `GET /companies/:companyId/join-requests?status=pending_approval&requestType=human|agent`
- `POST /companies/:companyId/join-requests/:requestId/approve`
- `POST /companies/:companyId/join-requests/:requestId/reject`
- `POST /join-requests/:requestId/claim-api-key`（仅限已批准的智能体请求）
- `GET /companies/:companyId/members`（返回人类和智能体两种主体）
- `PATCH /companies/:companyId/members/:memberId/permissions`
- `POST /admin/users/:userId/promote-instance-admin`
- `POST /admin/users/:userId/demote-instance-admin`
- `PUT /admin/users/:userId/company-access`（设置用户可访问的公司）
- `GET /admin/users/:userId/company-access`

## 本地模式 UX 策略

- 无需登录提示或账号设置
- 本地隐式 board 用户自动配置用于审计归属
- 本地操作者仍可作为有效的实例管理员使用实例设置和公司设置
- 本地模式下可使用邀请、加入审批和权限管理 UI
- 本地模式下预期进行智能体入职，包括创建邀请链接和审批加入请求
- V1 本地模式不支持公共/不受信网络入口

## 此模型中的云端智能体

- 云端智能体继续通过 `agent_api_keys` 进行认证
- 同一公司边界检查仍然是强制的
- 智能体分配人类任务的能力是权限门控的，而非隐式的

## 实例设置界面

本计划引入了实例级别的关注点（例如引导状态、实例管理员、邀请默认值和 token 策略）。目前没有专用的 UI 界面。

V1 方案：

- 为实例管理员添加一个最小化的 `Instance Settings` 页面
- 在 API + CLI 中公开关键实例设置（`paperclipai configure` / `paperclipai onboard`）
- 在完整设置 UX 存在之前，在主 UI 中显示只读实例状态指示器

## 实施阶段

## 第一阶段：模式和保护措施

- 添加显式部署模式配置（`local_trusted | cloud_hosted`）
- 强制启动安全检查和健康可见性
- 实现本地隐式 board 的 actor 解析
- 将本地隐式 board actor 映射到实例管理员授权上下文
- 在健康/配置界面中添加引导状态信号（`ready | bootstrap_pending`）
- 添加最小化的实例设置 API/CLI 界面和只读 UI 指示器

## 第二阶段：人类身份和成员资格

- 添加 users/memberships/invites 的 schema + 迁移
- 接入云模式的认证中间件
- 添加成员资格查询和公司访问检查
- 实现 Better Auth 邮箱/密码流程（无邮箱验证）
- 实现首次管理员引导邀请命令和入职集成
- 实现一次性分享链接邀请接受流程，带 `pending_approval` 加入请求

## 第三阶段：权限和分配作用域

- 添加共享主体授权模型和强制辅助函数
- 添加分配 API 的指挥链作用域检查
- 添加禁止分配的测试（例如不能分配给 CEO）
- 添加实例管理员提升/降级和全局公司访问管理 API
- 添加人类和智能体加入审批的 `joins:approve` 权限检查

## 第四阶段：邀请工作流

- 统一的 `company_join` 邀请创建/落地/接受/撤销端点
- 加入请求批准/拒绝端点，带审核元数据（适用时的邮箱、IP）
- 一次性 token 安全性和撤销语义
- 邀请管理、待审批加入、成员权限的 UI
- 待处理加入请求的收件箱告警生成
- 确保邀请和审批 UX 在 `cloud_hosted` 和 `local_trusted` 下都可用

## 第五阶段：人类收件箱 + 任务分配更新

- 扩展任务受理人模型以支持人类用户
- 收件箱 API 和 UI 用于：
  - 任务分配
  - 待处理加入审批告警，带内联批准/拒绝操作
- 带策略检查的智能体到人类分配流程

## 第六阶段：智能体自助加入和 token 认领

- 在统一邀请落地页上添加智能体加入路径
- 捕获智能体加入请求和管理员审批流程
- 审批后创建一次性 API 密钥认领流程（仅显示一次）

## 验收标准

1. `local_trusted` 启动时无需登录，直接显示 board UI。
2. `local_trusted` 在 V1 中不暴露可选的人类登录 UX。
3. `local_trusted` 本地隐式 actor 可以管理实例设置、邀请链接、加入审批和权限授权。
4. `cloud_hosted` 未配置认证时无法启动。
5. `cloud_hosted` 中没有请求可以在没有认证 actor 的情况下变更数据。
6. 如果不存在初始管理员，应用显示引导说明和 CLI 命令。
7. 引导待处理时，`pnpm paperclipai onboard` 输出 CEO 入职邀请 URL。
8. 一个 `company_join` 链接通过邀请落地页的加入类型选择同时支持人类和智能体入职。
9. V1 邀请投递仅限复制链接（无内置邮件投递）。
10. 分享链接接受创建待处理的加入请求；不授予即时访问权限。
11. 待处理的加入请求作为带有内联批准/拒绝操作的收件箱告警出现。
12. 管理员审核视图在做出决定前包含加入元数据（适用时的人类邮箱、来源 IP、智能体请求的智能体元数据）。
13. 仅已批准的加入请求解锁访问权限：

- 人类：活跃的公司成员资格 + 权限授权
- 智能体：智能体创建 + API 密钥认领资格

14. 智能体注册遵循相同的链接 -> 待审批 -> 批准流程。
15. 已批准的智能体可以恰好一次认领长期 API 密钥，带明文仅显示一次语义。
16. V1 中智能体 API 密钥默认无期限，管理员可撤销/重新生成。
17. V1 `local_trusted` 不支持公共/不受信入口（仅回环本地服务器）。
18. 一个用户可以持有多个公司的成员资格。
19. 实例管理员可以将另一用户提升为实例管理员。
20. 实例管理员可以管理每个用户可以访问哪些公司。
21. 权限可以通过一个共享的授权系统按成员主体（人类或智能体）授予/撤销。
22. 分配作用域防止超出层级或受保护角色的分配。
23. 智能体仅在被允许时才能将任务分配给人类。
24. 人类可以在收件箱中查看分配的任务并根据权限进行操作。
25. 所有新的变更都是公司范围的并记录在 `activity_log` 中。

## V1 决策（已锁定）

1. `local_trusted` 在 V1 中不支持登录 UX；仅隐式本地 board actor。
2. 权限使用规范化的共享表：`principal_permission_grants`，带作用域授权。
3. V1 邀请投递仅限复制链接（无内置邮件发送）。
4. 引导邀请创建仅需要本地 shell 访问（仅 CLI 路径，无 HTTP 引导端点）。
5. 审批审核仅显示来源 IP；V1 不做 GeoIP/国家查询。
6. V1 中智能体 API 密钥生命周期默认无期限，带显式撤销/重新生成控制。
7. 本地模式通过隐式本地实例管理员 actor 保留全部管理/设置/邀请功能。
8. V1 本地模式不支持公共/不受信入口；V1 没有 `--dangerous-agent-ingress`。
