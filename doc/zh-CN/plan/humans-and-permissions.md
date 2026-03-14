# 人员和权限计划

状态：草案
日期：2026-02-21
所有者：服务器+UI+共享+数据库

## 目标

添加一流的人类用户和权限，同时保留两种部署模式：

- 本地可信单用户模式，无登录摩擦
- 云托管多用户模式，具有强制身份验证和授权

## 为什么这个计划

当前的 V1 假设以一名董事会运营商为中心。我们现在需要：

- 具有每个用户权限的多人协作
- 安全的云部署默认值（不会出现意外的无登录生产）
- 本地模式仍然感觉即时（`npx paperclipai run` 并继续）
- 智能体到人类的任务委托，包括人类收件箱
- 一个用户帐户可在一次部署中访问多个公司
- 实例管理员可以管理公司对实例的访问
- 加入批准作为可操作的收件箱警报出现，而不是隐藏在仅限管理的页面中
- 面向人类和智能体的对称邀请和批准加入路径
- 一种供人类和智能体共享的成员资格和权限模型

## 产品限制

1. 对每个新表、端点和权限检查保持严格的公司范围。
2. 保留现有的控制平面不变量：

- 单受让人任务模型
- 审批门
- 预算硬停止行为
- 突变活动记录

3. 保持本地模式简单且可信，但防止不安全的云状态。

## 部署模式

## 模式A：`local_trusted`

行为：

- 没有登录界面
- 浏览器直接打开到棋盘上下文中
- 保留嵌入式数据库和本地存储默认值
- 存在本地隐含人类演员以进行归因
- 本地隐式参与者对该实例具有有效的 `instance_admin` 权限
- 完整的邀请/批准/权限设置流程在本地模式下仍然可用（包括智能体注册）

护栏：

- 服务器默认绑定到环回
- 如果模式为 `local_trusted` 且具有非环回绑定，则启动失败
- 用户界面显示持久的“本地可信模式”徽章

## 模式B：`cloud_hosted`

行为：

- 所有人类端点都需要登录
- 更好的人类身份验证
- 初始身份验证方法：电子邮件+密码
- 首次发布不需要电子邮件验证
- 支持托管数据库和远程部署
- 多用户会话和角色/权限强制执行

护栏：

- 如果缺少身份验证提供程序/会话配置，则启动失败
- 如果设置了不安全的身份验证绕过标志，则启动失败
- 健康负载包括模式和身份验证准备情况

## 身份验证选择

- 对人类用户使用更好的身份验证
- 仅从电子邮件/密码登录开始
- V1 中没有电子邮件确认要求
- 保持实施结构化，以便以后可以添加社交/SSO 提供商，而无需更改成员资格/权限语义

## Auth 和 Actor 模型

将请求参与者统一到单个模型中：- `user`（经过身份验证的人类）
- `agent`（API 密钥）
- `local_board_implicit`（仅限本地信任模式）

规则：

- 在`cloud_hosted`中，只有`user`和`agent`是有效的演员
- 在`local_trusted`中，未经身份验证的浏览器/API请求解析为`local_board_implicit`
- `local_board_implicit` 被授权为本地操作的实例管理员主体
- 所有变异动作继续使用演员类型/id写入`activity_log`

## 第一个管理引导程序

问题：

- 新的云部署需要安全、明确的第一人工管理路径
- 应用程序不能采用预先存在的管理员帐户
- `local_trusted` 不使用引导流程，因为隐式本地实例管理已存在

引导流程：

1. 如果部署中不存在 `instance_admin` 用户，则实例处于 `bootstrap_pending` 状态。
2. CLI 命令 `pnpm paperclipai auth bootstrap-ceo` 为该实例创建一次性 CEO 入职邀请 URL。
3. `pnpm paperclipai onboard` 运行此引导程序检查并在 `bootstrap_pending` 时自动打印邀请 URL。
4. 在 `bootstrap_pending` 时访问应用程序会显示阻止设置页面，其中包含要运行的确切 CLI 命令 (`pnpm paperclipai onboard`)。
5. 接受 CEO 邀请将创建第一个管理员用户并退出引导模式。

安全规则：

- 引导程序邀请是一次性的、短暂的、静态存储的令牌哈希
- 每个实例一次只有一个有效的引导程序邀请（重新生成会撤销之前的令牌）
- 引导操作在 `activity_log` 中进行审核

## 数据模型添加

## 新表

1. `users`

- 人类用户的身份记录（基于电子邮件）
- 用于管理权限的可选实例级角色字段（或伴随表）

2. `company_memberships`

- `company_id`、`principal_type` (`user | agent`)、`principal_id`
- 状态（`pending | active | suspended`），角色元数据
- 存储人类和智能体的有效访问状态
- 多对多：一个主体可以属于多个公司

3. `invites`

- `company_id`、`invite_type` (`company_join | bootstrap_ceo`)、令牌哈希、expires_at、invited_by、revoked_at、accepted_at
- 一次性分享链接（无预先绑定的邀请电子邮件）
- `allowed_join_types` (`human | agent | both`) 用于 `company_join` 链接
- 可选默认负载由连接类型键入：
  - 人类默认设置：初始权限/成员角色
  - 智能体默认值：建议的角色/头衔/适配器默认值

4. `principal_permission_grants`

- `company_id`、`principal_type` (`user | agent`)、`principal_id`、`permission_key`
- 显式授予，例如 `agents:create`
- 包括命令链限制的范围有效负载
- 用于可审核授予/撤销历史记录的规范化表（不是 JSON blob）

5. `join_requests`- `invite_id`、`company_id`、`request_type` (`human | agent`)
- `status` (`pending_approval | approved | rejected`)
- 共同评论元数据：
  - `request_ip`
  - `approved_by_user_id`、`approved_at`、`rejected_by_user_id`、`rejected_at`
- 人工请求字段：
  - `requesting_user_id`, `request_email_snapshot`
- 智能体请求字段：
  - `agent_name`、`adapter_type`、`capabilities`、`created_agent_id` 在获得批准之前可为空
- 选择加入类型后，每个消费的邀请都会创建一条加入请求记录

6. `issues` 扩展

- 添加 `assignee_user_id` 可为空
- 通过 XOR 检查保留单受让人不变式：
  - `assignee_agent_id` / `assignee_user_id` 中的零个或之一

## 兼容性

- 现有的 `created_by_user_id` / `author_user_id` 字段保留并完全活跃
- 智能体 API 密钥保留身份验证凭据；会员资格+赠款仍然是授权来源

## 权限模型（初始设定）

原理：

- 人类和智能体使用相同的会员资格+赠款评估引擎
- 针对两种参与者类型的 `(company_id, principal_type, principal_id)` 进行权限检查
- 这避免了单独的 authz 代码路径并保持行为一致

角色层：

- `instance_admin`：部署范围内的管理员，可以访问/管理所有公司和用户-公司访问映射
- `company_member`：仅限公司范围的权限

核心补助金：

1. `agents:create`
2. `users:invite`
3. `users:manage_permissions`
4. `tasks:assign`
5. `tasks:assign_scope`（组织约束委托）
6. `joins:approve`（批准/拒绝人工和智能体加入请求）

附加行为规则：

- 实例管理员可以提升/降级实例管理员并管理跨公司的用户访问
- 董事会级用户可以管理他们控制的公司内部的公司拨款
- 非管理主体只能在明确的授权范围内行事
- 分配检查适用于智能体和人工分配者

## 命令链范围设计

初步方法：

- 将分配范围表示为组织层次结构中的允许规则
- 例子：
  - `subtree:<agentId>`（可以分配到该管理器子树中）
  - `exclude:<agentId>`（无法分配给受保护的角色，例如首席执行官）

执行：

- 解决目标受让人组织职位
- 在赋值突变之前评估允许/拒绝范围规则
- 对于超出范围的分配返回 `403`

## 邀请和注册流程

1. 授权用户创建一个 `company_join` 邀请共享链接，可选默认值 + 到期时间。
2. 系统发送包含一次性令牌的邀请 URL。
3. 邀请登陆页面呈现两个路径：`Join as human`或`Join as agent`（以`allowed_join_types`为准）。
4. 请求者选择加入路径并提交所需数据。
5. 提交消耗token并创建`pending_approval`加入请求（尚未访问）。
6. 加入请求捕获评论元数据：

- 人类：经过身份验证的电子邮件
- 两者：源IP
- 智能体：建议的智能体元数据7. 公司管理员/实例管理员审核请求并批准或拒绝。
8. 批准后：

- 人类：激活 `company_membership` 并申请权限授予
- 智能体：创建智能体记录并启用API-key索赔流程

9. 链接是一次性的，不能重复使用。
10. 邀请者/管理员可以在接受之前撤销邀请。

安全规则：

- 存储静态散列的邀请令牌
- 一次性使用的令牌，有效期短
- 所有邀请生命周期事件均记录在 `activity_log` 中
- 待批准的用户在获得批准之前无法读取或更改任何公司数据

## 加入审批收件箱

- 加入请求会为符合条件的审批者（`joins:approve` 或管理员角色）生成收件箱警报
- 警报出现在以下两者中：
  - 全球/公司收件箱提要
  - 专用的待批准用户界面
- 每个警报都包含内联批准/拒绝操作（无需上下文切换）
- 警报有效负载必须包括：
  - 请求者电子邮件为 `request_type=human`
  - 源IP
  - 请求类型（`human | agent`）

## 人类收件箱和智能体到人类的委托

行为：

- 当政策允许时，智能体可以将任务分配给人类
- 人们在收件箱视图中看到分配的任务（包括在本地信任模式下）
- 评论和状态转换遵循相同的问题生命周期守卫

## 智能体加入路径（通过统一邀请链接）

1、授权用户分享1个`company_join`邀请链接（`allowed_join_types`包括`agent`）。
2. 智能体操作员打开链接，选择`Join as agent`，并提交加入有效负载（名称/角色/适配器元数据）。
3. 系统创建`pending_approval`智能体加入请求并捕获源IP。
4. 审批者看到收件箱中的警报并批准或拒绝。
5. 批准后，服务器创建智能体记录并铸造一个长期存在的 API 密钥。
6. API 密钥通过带有明确“立即保存”指令的安全声明流程仅显示一次。

长期代币政策：

- 默认为长期可撤销 API 密钥（静态存储的哈希值）
- 仅显示一次明文密钥
- 支持从管理界面立即撤销/重新生成
- 稍后可以选择添加过期/轮换策略，而无需更改加入流程

API 补充（建议）：

- `GET /companies/:companyId/inbox`（人类参与者范围仅限于自身；包括任务项+授权时的待定加入批准警报）
- `POST /companies/:companyId/issues/:issueId/assign-user`
- `POST /companies/:companyId/invites`
- `GET /invites/:token`（邀请登陆有效载荷为`allowed_join_types`）
- `POST /invites/:token/accept`（主体包括`requestType=human|agent`和请求元数据）
- `POST /invites/:inviteId/revoke`
- `GET /companies/:companyId/join-requests?status=pending_approval&requestType=human|agent`
- `POST /companies/:companyId/join-requests/:requestId/approve`
- `POST /companies/:companyId/join-requests/:requestId/reject`
- `POST /join-requests/:requestId/claim-api-key`（仅限已批准的智能体请求）
- `GET /companies/:companyId/members`（返回人类和智能体委托人）
- `PATCH /companies/:companyId/members/:memberId/permissions`
- `POST /admin/users/:userId/promote-instance-admin`
- `POST /admin/users/:userId/demote-instance-admin`
- `PUT /admin/users/:userId/company-access`（为用户设置可访问的公司）
- `GET /admin/users/:userId/company-access`

## 本地模式用户体验策略- 无需登录提示或帐户设置
- 自动配置本地隐式董事会用户以进行审计归因
- 本地操作员仍然可以使用实例设置和公司设置作为有效的实例管理员
- 邀请、加入审批和权限管理 UI 在本地模式下可用
- 智能体加入预计在本地模式下进行，包括创建邀请链接和批准加入请求
- 公共/不受信任的网络入口超出了 V1 本地模式的范围

## 此模型中的云智能体

- 云智能体继续通过`agent_api_keys`进行身份验证
- 同一公司的边界检查仍然是强制性的
- 智能体分配人工任务的能力是受权限限制的，而不是隐含的

## 实例设置界面

该计划引入了实例级问题（例如引导状态、实例管理员、邀请默认值和令牌策略）。目前还没有专门的 UI 界面。

V1方法：

- 为实例管理员添加最小的 `Instance Settings` 页面
- 在 API + CLI (`paperclipai configure` / `paperclipai onboard`) 中公开关键实例设置
- 在主 UI 中显示只读实例状态指示器，直到存在完整的设置 UX

## 实施阶段

## 第一阶段：模式和护栏

- 添加显式部署模式配置（`local_trusted | cloud_hosted`）
- 加强启动安全检查和健康可见性
- 为本地隐式董事会实施参与者解析
- 将本地隐式董事会参与者映射到实例管理授权上下文
- 在健康/配置表面添加引导状态信号（`ready | bootstrap_pending`）
- 添加最小实例设置 API/CLI 表面和只读 UI 指示器

## 第二阶段：人类身份和成员资格

- 为用户/会员资格/邀请添加架构+迁移
- 用于云模式的有线身份验证中间件
- 添加会员查找和公司访问检查
- 实施更好的身份验证电子邮件/密码流程（无电子邮件验证）
- 实施第一管理员引导邀请命令和板载集成
- 通过 `pending_approval` 加入请求实现一次性共享链接邀请接受流程

## 第 3 阶段：权限和分配范围

- 添加共享主体授予模型和执行助手
- 添加分配命令链范围检查 APIs
- 添加禁止分配的测试（例如，不能分配给CEO）
- 添加实例管理员升级/降级和全局公司访问管理APIs
- 添加 `joins:approve` 人员和智能体加入批准的权限检查

## 第 4 阶段：邀请工作流程- 统一`company_join`邀请创建/登陆/接受/撤销端点
- 使用审核元数据（适用时的电子邮件、IP）加入请求批准/拒绝端点
- 一次性令牌安全和撤销语义
- 用于邀请管理、待定加入批准和会员权限的用户界面
- 为待处理的加入请求生成收件箱警报
- 确保在 `cloud_hosted` 和 `local_trusted` 中启用邀请和批准 UX

## 第 5 阶段：人工收件箱 + 任务分配更新

- 为人类用户扩展问题受让人模型
- 收件箱 API 和 UI：
  - 任务分配
  - 带有内联批准/拒绝操作的待定加入批准警报
- 智能体到人员的分配流程以及策略检查

## 第 6 阶段：智能体自加入和令牌声明

- 在统一邀请登陆页面添加智能体加入路径
- 捕获智能体加入请求和管理员批准流程
- 审核后创建一次性API-key索赔流程（显示一次）

## 验收标准

1. `local_trusted` 无需登录即可启动并立即显示棋盘UI。
2. `local_trusted` 在 V1 中未公开可选的人工登录 UX。
3. `local_trusted` 本地隐式参与者可以管理实例设置、邀请链接、加入批准和权限授予。
4. `cloud_hosted` 未配置授权无法启动。
5. `cloud_hosted` 中的请求在没有经过身份验证的参与者的情况下不能改变数据。
6. 如果不存在初始管理员，应用程序将使用 CLI 命令显示引导指令。
7. 当引导挂起时，`pnpm paperclipai onboard` 输出 CEO 入职邀请 URL。
8. 一个 `company_join` 链接通过邀请登陆页面上的加入类型选择支持人工和座席加入。
9. V1 中的邀请传送仅是复制链接（无内置电子邮件传送）。
10. 共享链接接受创建待处理的加入请求；它不授予立即访问权限。
11. 待处理的加入请求显示为带有内联批准/拒绝操作的收件箱警报。
12. 管理员审核视图包括决策前的加入元数据（适用时的人工电子邮件、源 IP 以及智能体请求的智能体元数据）。
13. 只有批准的加入请求才能解锁访问权限：

- 人力：活跃的公司会员+许可授予
- 智能体：智能体创建+API-key索赔资格14. 智能体注册遵循相同的链接 -> 待批准 -> 批准流程。
15. 经批准的智能体可以仅声明一次长期存在的 API 密钥，并具有纯文本显示一次语义。
16. 智能体 API 密钥在 V1 中默认是无限期的，并且可由管理员撤销/重新生成。
17. V1（仅环回本地服务器）不支持 `local_trusted` 的公共/不受信任入口。
18. 一名用户可以拥有多家公司的会员资格。
19. 实例管理员可以将其他用户提升为实例管理员。
20. 实例管理员可以管理每个用户可以访问哪些公司。
21. 可以通过一个共享授权系统向每个成员主体（人或智能体人）授予/撤销权限。
22. 分配范围可防止层级外或受保护角色的分配。
23. 只有在允许的情况下，智能体才能将任务分配给人类。
24. 人们可以在收件箱中查看分配的任务，并根据权限执行这些任务。
25. 所有新突变均在公司范围内并记录在 `activity_log` 中。

## V1 决策（已锁定）

1. `local_trusted` V1版本将不支持登录UX；仅隐式本地董事会演员。
2. 权限使用规范化共享表：`principal_permission_grants` 和范围授权。
3. V1版本仅通过复制链接方式发送邀请（无内置邮件发送功能）。
4. 引导邀请创建应仅需要本地 shell 访问（仅 CLI 路径，无 HTTP 引导端点）。
5、审批审核仅显示源IP； V1 中没有 GeoIP/国家/地区查找。
6. V1 中智能体 API-key 的生命周期默认为无限期，具有显式撤销/重新生成控制。
7. 本地模式通过隐式本地实例管理参与者保留完整的管理/设置/邀请功能。
8. 本地模式的公共/不受信任入口超出了 V1 的范围； V1 中没有 `--dangerous-agent-ingress`。