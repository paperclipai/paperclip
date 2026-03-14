# 人员和权限实施 (V1)

状态：草案
日期：2026-02-21
所有者：服务器+UI+CLI+DB+共享
伴侣计划：`doc/plan/humans-and-permissions.md`

## 1.文档角色

本文件是人员与权限计划的工程实施合同。
它将产品决策转化为具体的模式、API、中间件、UI、CLI 和测试工作。

如果本文档与之前的探索性注释冲突，则本文档优先执行 V1。

## 2. 锁定 V1 决策

1. 仍保留两种部署模式：
- `local_trusted`
- `cloud_hosted`

2. `local_trusted`：
- 没有登录用户体验
- 隐式本地实例管理员参与者
- 仅环回服务器绑定
- 本地可用的完整管理/设置/邀请/批准功能

3. `cloud_hosted`：
- 更好的人类身份验证
- 仅电子邮件/密码
- V1 中没有电子邮件验证要求

4、权限：
- 人类和智能体的一个共享授权系统
- 标准化补助金表（`principal_permission_grants`）
- 没有单独的“智能体权限引擎”

5、邀请：
- 仅复制链接（V1 中不发送出站电子邮件）
- 统一`company_join`链接，支持人工或智能体路径
- 接受创建 `pending_approval` 加入请求
- 在管理员批准之前无法访问

6. 加入评论元数据：
- 需要源IP
- V1 中没有 GeoIP/国家/地区查找

7. 智能体API钥匙：
- 默认情况下无限期
- 静态哈希
- 索赔时显示一次
- 支持撤销/重新生成

8. 本地入口：
- 公共/不受信任的入口超出了 V1 的范围
- V1 中没有 `--dangerous-agent-ingress`

## 3. 当前基线和增量

当前基线（截至本文档的回购）：

- 服务器演员模型默认为 `server/src/middleware/auth.ts` 中的 `board`
- 授权大多为`assertBoard` + 公司签入`server/src/routes/authz.ts`
- 本地模式中没有人工身份验证/会话表
- 没有主要成员资格或补助金表
- 无邀请或加入请求生命周期

所需增量：

- 从董事会与智能体的授权转向基于主体的授权
- 在云模式下添加更好的身份验证集成
- 添加会员资格/赠款/邀请/加入请求持久性
- 添加批准收件箱信号和操作
- 保留本地无登录用户体验而不削弱云安全性

## 4. 架构

## 4.1 部署模式合约

添加显式运行时模式：

- `deployment.mode = local_trusted | cloud_hosted`

配置行为：

- 模式存储在配置文件中（`packages/shared/src/config-schema.ts`）
- 加载到服务器配置（`server/src/config.ts`）
- 出现在`/api/health`

启动护栏：

- `local_trusted`：如果绑定主机不是环回，则启动失败
- `cloud_hosted`：如果未配置 Better Auth，则启动失败

## 4.2 演员模型

用显式参与者替换隐式“板”语义：

- `user`（会话验证的人类）
- `agent`（承载API密钥）
- `local_implicit_admin`（仅限 local_trusted）

实施注意事项：- 通过引入标准化器助手，在迁移过程中保持 `req.actor` 形状向后兼容
- 在新的 authz 助手就位后删除硬编码的 `"board"` 逐路由检查

## 4.3 授权模型

授权输入元组：

- `(company_id, principal_type, principal_id, permission_key, scope_payload)`

主要类型：

- `user`
- `agent`

角色层：

- `instance_admin`（实例范围）
- 通过 `principal_permission_grants` 获得公司范围内的资助

评价顺序：

1. 从actor中解析principal
2. 解析实例角色（`instance_admin` 仅限管理员操作的短路）
3、解析公司会员（公司接入需`active`）
4. 解决拨款+请求行动的范围

## 5. 数据模型

## 5.1 更好的身份验证表

由 Better Auth 适配器/迁移管理（预计最少）：

- `user`
- `session`
- `account`
- `verification`

注意：

- 使用 Better Auth 规范表名称/类型来避免自定义分叉

## 5.2 新 Paperclip 表

1. `instance_user_roles`

- `id` uuid pk
- `user_id` 文本不为空
- `role` 文本不为空 (`instance_admin`)
- `created_at`, `updated_at`
- 唯一索引：`(user_id, role)`

2. `company_memberships`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不为空
- `principal_type` 文本不为空 (`user | agent`)
- `principal_id` 文本不为空
- `status` 文本不为空 (`pending | active | suspended`)
- `membership_role` 文字为空
- `created_at`, `updated_at`
- 唯一索引：`(company_id, principal_type, principal_id)`
- 索引：`(principal_type, principal_id, status)`

3. `principal_permission_grants`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不为空
- `principal_type` 文本不为空 (`user | agent`)
- `principal_id` 文本不为空
- `permission_key` 文本不为空
- `scope` jsonb 空
- `granted_by_user_id` 文字为空
- `created_at`, `updated_at`
- 唯一索引：`(company_id, principal_type, principal_id, permission_key)`
- 索引：`(company_id, permission_key)`

4. `invites`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不为空
- `invite_type` 文本不为空 (`company_join | bootstrap_ceo`)
- `token_hash` 文本不为空
- `company_join` 的 `allowed_join_types` 文本不为空 (`human | agent | both`)
- `defaults_payload` jsonb 空
- `expires_at` 时间戳不为空
- `invited_by_user_id` 文字为空
- `revoked_at` 时间戳空
- `accepted_at` 时间戳空
- `created_at` timestamptz 现在默认不为空()
- 唯一索引：`(token_hash)`
- 索引：`(company_id, invite_type, revoked_at, expires_at)`

5. `join_requests`- `id` uuid pk
- `invite_id` uuid fk `invites.id` 不为空
- `company_id` uuid fk `companies.id` 不为空
- `request_type` 文本不为空 (`human | agent`)
- `status` 文本不为空 (`pending_approval | approved | rejected`)
- `request_ip` 文本不为空
- `requesting_user_id` 文字为空
- `request_email_snapshot` 文字为空
- `agent_name` 文字为空
- `adapter_type` 文字为空
- `capabilities` 文字为空
- `agent_defaults_payload` jsonb 空
- `created_agent_id` uuid fk `agents.id` null
- `approved_by_user_id` 文字为空
- `approved_at` 时间戳空
- `rejected_by_user_id` 文字为空
- `rejected_at` 时间戳空
- `created_at`, `updated_at`
- 索引：`(company_id, status, request_type, created_at desc)`
- 唯一索引：`(invite_id)` 对每个消费的邀请强制执行一个请求

## 5.3 现有表更改

1. `issues`

- 添加`assignee_user_id`文本空
- 强制执行单一受让人不变式：
  - `assignee_agent_id` 和 `assignee_user_id` 至多其中之一为非空

2. `agents`

- 保留现有的 `permissions` JSON 仅用于过渡
- 一旦主体授权生效，就在代码路径中标记为已弃用

## 5.4 迁移策略

迁移顺序：

1. 添加新的表/列/索引
2. 回填现有数据的最低会员资格/赠款：
- 在运行时以本地模式创建本地隐式管理成员身份上下文（不保留为更好的身份验证用户）
- 对于云，引导程序在接受时创建第一个管理员用户角色
3. 将authz读取切换到新表
4. 删除传统的仅董事会检查

## 6. API 合约（新增/变更）

全部位于`/api`下。

## 6.1 健康

`GET /api/health` 回复补充：

- `deploymentMode`
- `authReady`
- `bootstrapStatus` (`ready | bootstrap_pending`)

## 6.2 邀请

1. `POST /api/companies/:companyId/invites`
- 创建 `company_join` 邀请
- 复制链接值返回一次

2. `GET /api/invites/:token`
- 验证令牌
- 返回邀请着陆有效载荷
- 包括`allowedJoinTypes`

3. `POST /api/invites/:token/accept`
- 身体：
  - `requestType: human | agent`
  - 人为路径：除了经过身份验证的用户之外，没有额外的有效负载
  - 智能体路径：`agentName`、`adapterType`、`capabilities`，可选适配器默认值
- 消耗邀请令牌
- 创建`join_requests(status=pending_approval)`

4. `POST /api/invites/:inviteId/revoke`
- 撤销未消费的邀请

## 6.3 加入请求

1. `GET /api/companies/:companyId/join-requests?status=pending_approval&requestType=...`

2. `POST /api/companies/:companyId/join-requests/:requestId/approve`
- 人类：
  - 创建/激活`company_memberships`
  - 应用默认补助金
- 智能体人：
  - 创建 `agents` 行
  - 为 API 密钥创建待处理的索赔上下文
  - 创建/激活智能体会员资格
  - 应用默认补助金

3. `POST /api/companies/:companyId/join-requests/:requestId/reject`

4. `POST /api/join-requests/:requestId/claim-api-key`
- 仅经批准的智能体请求
- 返回一次明文密钥
- 将哈希值存储在 `agent_api_keys` 中

## 6.4 会员资格和补助金

1. `GET /api/companies/:companyId/members`
- 返回两种主要类型

2. `PATCH /api/companies/:companyId/members/:memberId/permissions`
- 更新插入/删除补助金

3. `PUT /api/admin/users/:userId/company-access`
- 仅限实例管理员

4. `GET /api/admin/users/:userId/company-access`

5. `POST /api/admin/users/:userId/promote-instance-admin`

6. `POST /api/admin/users/:userId/demote-instance-admin`

## 6.5 收件箱

`GET /api/companies/:companyId/inbox` 补充：- 当参与者可以 `joins:approve` 时待处理的加入请求警报项目
- 每个项目都包含内联操作元数据：
  - 加入请求 ID
  - 请求类型
  - 源IP
  - 适用时的人工电子邮件快照

## 7. 服务器实现细节

## 7.1 配置与启动

文件：

- `packages/shared/src/config-schema.ts`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/startup-banner.ts`

变化：

- 添加部署模式+绑定主机设置
- 仅对 `local_trusted` 强制执行环回
- 在 `cloud_hosted` 中强制执行更好的身份验证准备
- 横幅显示模式和引导状态

## 7.2 更好的身份验证集成

文件：

- `server/package.json`（依赖）
- `server/src/auth/*`（新）
- `server/src/app.ts`（挂载身份验证处理程序端点+会话中间件）

变化：

- 添加更好的身份验证服务器实例
- 云模式的cookie/会话处理
- 本地模式下的无操作会话身份验证

## 7.3 Actor 中间件

文件：

- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`
- `server/src/middleware/board-mutation-guard.ts`

变化：

- 停止默认每个在云模式下登机的请求
- 在本地模式下将本地请求映射到 `local_implicit_admin` actor
- 在云模式下将 Better Auth 会话映射到 `user` actor
- 保留智能体承载路径
- 用面向权限的助手替换 `assertBoard`：
  - `requireInstanceAdmin(req)`
  - `requireCompanyAccess(req, companyId)`
  - `requireCompanyPermission(req, companyId, permissionKey, scope?)`

## 7.4 授权服务

文件：

- `server/src/services`（新模块）
  - `memberships.ts`
  - `permissions.ts`
  - `invites.ts`
  - `join-requests.ts`
  - `instance-admin.ts`

变化：

- 集中权限评估
- 集中的会员决议
- 主要类型分支的一处

## 7.5 路线

文件：

- `server/src/routes/index.ts` 和新的路线模块：
  - `auth.ts`（如果需要）
  - `invites.ts`
  - `join-requests.ts`
  - `members.ts`
  - `instance-admin.ts`
  - `inbox.ts`（或现有收件箱源的扩展）

变化：

- 添加上面列出的新端点
- 一致地应用公司和权限检查
- 通过活动日志服务记录所有突变

## 7.6 活动日志和审核

文件：

- `server/src/services/activity-log.ts`
- 在邀请/加入/成员/管理路线中调用站点

所需采取的行动：

- `invite.created`
- `invite.revoked`
- `join.requested`
- `join.approved`
- `join.rejected`
- `membership.activated`
- `permission.granted`
- `permission.revoked`
- `instance_admin.promoted`
- `instance_admin.demoted`
- `agent_api_key.claimed`
- `agent_api_key.revoked`

## 7.7 实时和收件箱传播

文件：

- `server/src/services/live-events.ts`
- `server/src/realtime/live-events-ws.ts`
- 收件箱数据源端点

变化：

- 发出加入请求事件
- 确保收件箱刷新路径包括加入警报

## 8. CLI 实现

文件：

- `cli/src/index.ts`
- `cli/src/commands/onboard.ts`
- `cli/src/commands/configure.ts`
- `cli/src/prompts/server.ts`

命令：

1. `paperclipai auth bootstrap-ceo`
- 创建引导邀请
- 打印一次性 URL

2. `paperclipai onboard`
- 在云模式下使用 `bootstrap_pending`，打印引导程序 URL 和后续步骤
- 在本地模式下，跳过引导程序要求

配置补充：

- 部署模式
- 绑定主机（针对模式进行验证）

## 9. UI 实现文件：

- 路由：`ui/src/App.tsx`
- API 客户：`ui/src/api/*`
- 页面/组件（新）：
  - `AuthLogin` / `AuthSignup`（云模式）
  - `BootstrapPending`页面
  - `InviteLanding`页面
  - `InstanceSettings`页面
  - 在`Inbox`中加入审批组件
  - 公司环境中的会员/资助管理

所需的用户体验：

1. 云未认证用户：
- 重定向到登录/注册

2. 云引导待处理：
- 通过设置命令指导阻止应用程序

3、邀请登陆：
- 选择人类与智能体路径（尊重`allowedJoinTypes`）
- 提交加入请求
- 显示待批准确认

4. 收件箱：
- 显示带有批准/拒绝操作的加入批准卡
- 包括源 IP 和人工电子邮件快照（如果适用）

5. 本地模式：
- 没有登录提示
- 提供完整的设置/邀请/批准用户界面

## 10. 安全控制

1. 令牌处理

- 邀请令牌静态散列
- API 密钥静态散列
- 仅显示一次性明文密钥

2. 本地模式隔离

- 环回绑定强制
- 在非环回主机上启动硬故障

3. 云认证

- 没有隐式的董事会后备
- 人类突变必须进行会话验证

4. 加入工作流强化

- 每个邀请令牌一个请求
- 待处理的请求没有数据访问权限
- 会员激活前需要获得批准

5. 滥用控制

- 速率限制邀请接受和关键声明端点
- 针对加入和声明失败的结构化日志记录

## 11. 迁移与兼容性

## 11.1 运行时兼容性

- 在迁移 authz 帮助程序使用时保持现有的依赖于板的路由功能
- 仅在许可助手覆盖所有路线后才逐步淘汰 `assertBoard` 呼叫

## 11.2 数据兼容性

- 不要在V1中删除`agents.permissions`
- 拨款一旦汇出就停止阅读
- 在 V1 后清理迁移中删除

## 11.3 更好的身份验证用户 ID 处理

- 将 `user.id` 视为端到端文本
- 现有的 `created_by_user_id` 和类似的文本字段仍然有效

## 12. 测试策略

## 12.1 单元测试

- 权限评估器：
  - 实例管理员绕过
  - 拨款支票
  - 范围检查
- 加入批准状态机
- 邀请令牌生命周期

## 12.2 集成测试

- 云模式未认证变异->`401`
- 本地模式隐式管理突变 -> 成功
- 邀请接受 -> 待加入 -> 无访问权限
- 加入批准（人类）-> 会员资格/赠款活动
- 加入批准（智能体）->关键索赔一次
- 用户和智能体主体的跨公司访问被拒绝
-本地模式非环回绑定->启动失败

## 12.3 UI 测试

- 云模式登录门
- 引导挂起屏幕
- 邀请登陆选择路径UX
- 收件箱加入警报批准/拒绝流程

## 12.4 回归测试

- 现有智能体API关键流程仍然有效
- 任务分配和结账不变量不变
- 仍然发出所有突变的活动日志记录## 13. 交付计划

## A 阶段：基础

- 配置模式/绑定主机支持
- 启动护栏
- 更好的身份验证集成框架
- 演员类型扩展

## B 阶段：架构和 authz 核心

- 添加会员资格/赠款/邀请/加入表
- 添加权限服务和助手
- 电线公司/会员/实例管理员检查

## C阶段：邀请+加入后端

- 邀请创建/撤销
- 邀请接受 -> 待处理请求
- 批准/拒绝+关键声明
- 活动日志+现场活动

## D阶段：UI + CLI

- 云登录/引导屏幕
- 邀请登陆
- 收件箱加入审批操作
- 实例设置和成员权限
- 引导 CLI 命令和入门更新

## E 阶段：强化

- 全面集成/端到端覆盖
- 文档更新（`SPEC-implementation`、`DEVELOPING`、`CLI`）
- 清理遗留的仅板代码路径

## 14.验证门

交接前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果跳过任何命令，请准确记录跳过的内容及其原因。

## 15. 完成标准

1. 行为与本文档和`doc/plan/humans-and-permissions.md`中锁定的V1决策相匹配。
2、云模式需要授权；本地模式没有登录 UX。
3. 统一的邀请+待审批流程适用于人员和座席。
4. 共享主体会员资格+权限系统对用户和智能体生效。
5. 本地模式保持仅环回，否则会失败。
6. 收件箱显示可操作的加入批准。
7. 所有新的变异路径都会被记录活动。