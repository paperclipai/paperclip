# 用户与权限实施方案（V1）

状态：草案
日期：2026-02-21
负责方：Server + UI + CLI + DB + Shared
配套计划：`doc/plan/humans-and-permissions.md`

## 1. 文档角色

本文档是用户与权限计划的工程实施合约。它将产品决策转化为具体的 schema、API、中间件、UI、CLI 和测试工作。

如果本文档与先前的探索性文档冲突，本文档以 V1 执行为准。

## 2. 锁定的 V1 决策

1. 保留两种部署模式：
- `local_trusted`
- `cloud_hosted`

2. `local_trusted`：
- 无登录 UX
- 隐式本地实例管理员角色
- 仅绑定回环地址
- 本地可使用全部管理/设置/邀请/审批功能

3. `cloud_hosted`：
- 使用 Better Auth 进行人类认证
- 仅邮箱/密码
- V1 不要求邮箱验证

4. 权限：
- 用户和智能体共享统一的授权系统
- 规范化的授权表（`principal_permission_grants`）
- 没有单独的"智能体权限引擎"

5. 邀请：
- 仅复制链接（V1 不发送邮件）
- 统一的 `company_join` 链接，支持用户或智能体路径
- 接受邀请创建 `pending_approval` 加入请求
- 管理员审批前无访问权限

6. 加入审核元数据：
- 需要来源 IP
- V1 不做 GeoIP/国家查询

7. 智能体 API 密钥：
- 默认无期限
- 静态哈希存储
- 仅在认领时显示一次
- 支持撤销/重新生成

8. 本地入口：
- V1 不支持公共/不受信入口
- V1 没有 `--dangerous-agent-ingress`

## 3. 当前基线与差异

当前基线（截至本文档时的仓库状态）：

- 服务端 actor 模型在 `server/src/middleware/auth.ts` 中默认为 `board`
- 授权主要是 `server/src/routes/authz.ts` 中的 `assertBoard` + 公司检查
- 本地 schema 中没有人类认证/会话表
- 没有主体成员资格或授权表
- 没有邀请或加入请求生命周期

需要的变更：

- 从 board-vs-agent 授权迁移到基于主体的授权
- 在云模式下添加 Better Auth 集成
- 添加成员资格/授权/邀请/加入请求的持久化
- 添加审批收件箱信号和操作
- 保留本地无登录 UX，同时不削弱云安全性

## 4. 架构

## 4.1 部署模式合约

添加显式运行时模式：

- `deployment.mode = local_trusted | cloud_hosted`

配置行为：

- 模式存储在配置文件中（`packages/shared/src/config-schema.ts`）
- 在服务器配置中加载（`server/src/config.ts`）
- 在 `/api/health` 中公开

启动保护：

- `local_trusted`：如果绑定主机不是回环地址则启动失败
- `cloud_hosted`：如果 Better Auth 未配置则启动失败

## 4.2 Actor 模型

用显式 actor 替换隐式的 "board" 语义：

- `user`（会话认证的人类用户）
- `agent`（Bearer API 密钥）
- `local_implicit_admin`（仅 `local_trusted` 模式）

实现说明：

- 在迁移期间通过引入规范化辅助函数保持 `req.actor` 结构向后兼容
- 在新的 authz 辅助函数就位后，逐个路由移除硬编码的 `"board"` 检查

## 4.3 授权模型

授权输入元组：

- `(company_id, principal_type, principal_id, permission_key, scope_payload)`

主体类型：

- `user`
- `agent`

角色层级：

- `instance_admin`（实例范围）
- 通过 `principal_permission_grants` 进行公司范围的授权

评估顺序：

1. 从 actor 解析主体
2. 解析实例角色（`instance_admin` 对仅管理员操作的短路）
3. 解析公司成员资格（需要 `active` 状态才能访问公司）
4. 解析请求操作的授权 + 作用域

## 5. 数据模型

## 5.1 Better Auth 表

由 Better Auth 适配器/迁移管理（预期最低要求）：

- `user`
- `session`
- `account`
- `verification`

说明：

- 使用 Better Auth 规范表名/类型以避免自定义分支

## 5.2 新的 Paperclip 表

1. `instance_user_roles`

- `id` uuid pk
- `user_id` text not null
- `role` text not null（`instance_admin`）
- `created_at`、`updated_at`
- 唯一索引：`(user_id, role)`

2. `company_memberships`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `principal_type` text not null（`user | agent`）
- `principal_id` text not null
- `status` text not null（`pending | active | suspended`）
- `membership_role` text null
- `created_at`、`updated_at`
- 唯一索引：`(company_id, principal_type, principal_id)`
- 索引：`(principal_type, principal_id, status)`

3. `principal_permission_grants`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `principal_type` text not null（`user | agent`）
- `principal_id` text not null
- `permission_key` text not null
- `scope` jsonb null
- `granted_by_user_id` text null
- `created_at`、`updated_at`
- 唯一索引：`(company_id, principal_type, principal_id, permission_key)`
- 索引：`(company_id, permission_key)`

4. `invites`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `invite_type` text not null（`company_join | bootstrap_ceo`）
- `token_hash` text not null
- `allowed_join_types` text not null（`human | agent | both`）用于 `company_join`
- `defaults_payload` jsonb null
- `expires_at` timestamptz not null
- `invited_by_user_id` text null
- `revoked_at` timestamptz null
- `accepted_at` timestamptz null
- `created_at` timestamptz not null default now()
- 唯一索引：`(token_hash)`
- 索引：`(company_id, invite_type, revoked_at, expires_at)`

5. `join_requests`

- `id` uuid pk
- `invite_id` uuid fk `invites.id` not null
- `company_id` uuid fk `companies.id` not null
- `request_type` text not null（`human | agent`）
- `status` text not null（`pending_approval | approved | rejected`）
- `request_ip` text not null
- `requesting_user_id` text null
- `request_email_snapshot` text null
- `agent_name` text null
- `adapter_type` text null
- `capabilities` text null
- `agent_defaults_payload` jsonb null
- `created_agent_id` uuid fk `agents.id` null
- `approved_by_user_id` text null
- `approved_at` timestamptz null
- `rejected_by_user_id` text null
- `rejected_at` timestamptz null
- `created_at`、`updated_at`
- 索引：`(company_id, status, request_type, created_at desc)`
- 唯一索引：`(invite_id)` 确保每个已消费的邀请只有一个请求

## 5.3 现有表变更

1. `issues`

- 添加 `assignee_user_id` text null
- 强制单一受理人不变式：
  - `assignee_agent_id` 和 `assignee_user_id` 最多只有一个非空

2. `agents`

- 保留现有的 `permissions` JSON 仅用于过渡
- 在主体授权上线后在代码路径中标记为已弃用

## 5.4 迁移策略

迁移顺序：

1. 添加新表/列/索引
2. 为现有数据回填最低成员资格/授权：
- 在本地模式下运行时创建本地隐式管理员成员资格上下文（不作为 Better Auth 用户持久化）
- 对于云模式，引导程序在接受时创建第一个管理员用户角色
3. 将 authz 读取切换到新表
4. 移除遗留的仅 board 检查

## 6. API 合约（新增/变更）

全部在 `/api` 下。

## 6.1 健康检查

`GET /api/health` 响应新增：

- `deploymentMode`
- `authReady`
- `bootstrapStatus`（`ready | bootstrap_pending`）

## 6.2 邀请

1. `POST /api/companies/:companyId/invites`
- 创建 `company_join` 邀请
- 返回一次性的复制链接值

2. `GET /api/invites/:token`
- 验证 token
- 返回邀请落地页负载
- 包含 `allowedJoinTypes`

3. `POST /api/invites/:token/accept`
- 请求体：
  - `requestType: human | agent`
  - 人类路径：除认证用户外无额外负载
  - 智能体路径：`agentName`、`adapterType`、`capabilities`、可选的适配器默认值
- 消费邀请 token
- 创建 `join_requests(status=pending_approval)`

4. `POST /api/invites/:inviteId/revoke`
- 撤销未消费的邀请

## 6.3 加入请求

1. `GET /api/companies/:companyId/join-requests?status=pending_approval&requestType=...`

2. `POST /api/companies/:companyId/join-requests/:requestId/approve`
- 人类：
  - 创建/激活 `company_memberships`
  - 应用默认授权
- 智能体：
  - 创建 `agents` 行
  - 创建待认领的 API 密钥上下文
  - 创建/激活智能体成员资格
  - 应用默认授权

3. `POST /api/companies/:companyId/join-requests/:requestId/reject`

4. `POST /api/join-requests/:requestId/claim-api-key`
- 仅限已批准的智能体请求
- 返回一次性明文密钥
- 将哈希存储在 `agent_api_keys` 中

## 6.4 成员资格和授权

1. `GET /api/companies/:companyId/members`
- 返回两种主体类型

2. `PATCH /api/companies/:companyId/members/:memberId/permissions`
- 新增/移除授权

3. `PUT /api/admin/users/:userId/company-access`
- 仅限实例管理员

4. `GET /api/admin/users/:userId/company-access`

5. `POST /api/admin/users/:userId/promote-instance-admin`

6. `POST /api/admin/users/:userId/demote-instance-admin`

## 6.5 收件箱

`GET /api/companies/:companyId/inbox` 新增：

- 当 actor 拥有 `joins:approve` 权限时显示待处理加入请求告警项
- 每个项目包含内联操作元数据：
  - 加入请求 id
  - 请求类型
  - 来源 IP
  - 适用时的人类邮箱快照

## 7. 服务端实现细节

## 7.1 配置和启动

文件：

- `packages/shared/src/config-schema.ts`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/startup-banner.ts`

变更：

- 添加部署模式 + 绑定主机设置
- `local_trusted` 强制仅回环
- `cloud_hosted` 强制 Better Auth 就绪
- 启动横幅显示模式和引导状态

## 7.2 Better Auth 集成

文件：

- `server/package.json`（依赖）
- `server/src/auth/*`（新增）
- `server/src/app.ts`（挂载认证处理端点 + 会话中间件）

变更：

- 添加 Better Auth 服务端实例
- 云模式的 cookie/会话处理
- 本地模式下的空操作会话认证

## 7.3 Actor 中间件

文件：

- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`
- `server/src/middleware/board-mutation-guard.ts`

变更：

- 在云模式下停止将每个请求默认为 board
- 在本地模式下将本地请求映射为 `local_implicit_admin` actor
- 在云模式下将 Better Auth 会话映射为 `user` actor
- 保留智能体 bearer 路径
- 用面向权限的辅助函数替换 `assertBoard`：
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

变更：

- 集中式权限评估
- 集中式成员资格解析
- 主体类型分支的统一位置

## 7.5 路由

文件：

- `server/src/routes/index.ts` 和新路由模块：
  - `auth.ts`（如需要）
  - `invites.ts`
  - `join-requests.ts`
  - `members.ts`
  - `instance-admin.ts`
  - `inbox.ts`（或扩展现有收件箱数据源）

变更：

- 添加上述列出的新端点
- 一致地应用公司和权限检查
- 通过活动日志服务记录所有变更

## 7.6 活动日志和审计

文件：

- `server/src/services/activity-log.ts`
- 邀请/加入/成员/管理员路由中的调用点

必需操作：

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

变更：

- 发出加入请求事件
- 确保收件箱刷新路径包含加入告警

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
- 在云模式且 `bootstrap_pending` 时，打印引导 URL 和后续步骤
- 在本地模式下跳过引导要求

配置新增：

- 部署模式
- 绑定主机（根据模式验证）

## 9. UI 实现

文件：

- 路由：`ui/src/App.tsx`
- API 客户端：`ui/src/api/*`
- 页面/组件（新增）：
  - `AuthLogin` / `AuthSignup`（云模式）
  - `BootstrapPending` 页面
  - `InviteLanding` 页面
  - `InstanceSettings` 页面
  - `Inbox` 中的加入审批组件
  - 公司设置中的成员/授权管理

所需 UX：

1. 云模式未认证用户：
- 重定向到登录/注册

2. 云模式引导待处理：
- 用设置命令指引阻止应用访问

3. 邀请落地页：
- 选择人类 vs 智能体路径（遵守 `allowedJoinTypes`）
- 提交加入请求
- 显示待审批确认

4. 收件箱：
- 显示带有批准/拒绝操作的加入审批卡片
- 适用时包含来源 IP 和人类邮箱快照

5. 本地模式：
- 无登录提示
- 可使用全部设置/邀请/审批 UI

## 10. 安全控制

1. Token 处理

- 邀请 token 静态哈希存储
- API 密钥静态哈希存储
- 仅一次性明文密钥展示

2. 本地模式隔离

- 回环绑定强制
- 非回环主机时启动硬失败

3. 云认证

- 无隐式 board 回退
- 人类变更操作必须进行会话认证

4. 加入工作流加固

- 每个邀请 token 只能有一个请求
- 待处理请求无数据访问权限
- 需要审批才能激活成员资格

5. 滥用控制

- 对邀请接受和密钥认领端点进行速率限制
- 结构化日志记录加入和认领失败

## 11. 迁移与兼容性

## 11.1 运行时兼容性

- 在迁移 authz 辅助函数使用期间保持现有依赖 board 的路由功能
- 仅在权限辅助函数覆盖所有路由后才逐步移除 `assertBoard` 调用

## 11.2 数据兼容性

- V1 不删除 `agents.permissions`
- 授权接入后停止读取
- 在 V1 后的清理迁移中移除

## 11.3 Better Auth 用户 ID 处理

- 端到端将 `user.id` 视为 text
- 现有的 `created_by_user_id` 和类似的 text 字段保持有效

## 12. 测试策略

## 12.1 单元测试

- 权限评估器：
  - 实例管理员绕过
  - 授权检查
  - 作用域检查
- 加入审批状态机
- 邀请 token 生命周期

## 12.2 集成测试

- 云模式未认证变更 -> `401`
- 本地模式隐式管理员变更 -> 成功
- 邀请接受 -> 待处理加入 -> 无访问权限
- 加入审批（人类）-> 成员资格/授权激活
- 加入审批（智能体）-> 一次性密钥认领
- 跨公司访问被拒绝——用户和智能体主体
- 本地模式非回环绑定 -> 启动失败

## 12.3 UI 测试

- 云模式登录门禁
- 引导待处理页面
- 邀请落地页选择路径 UX
- 收件箱加入告警批准/拒绝流程

## 12.4 回归测试

- 现有智能体 API 密钥流程仍然正常
- 任务分配和签出不变式不变
- 所有变更的活动日志仍然正常发出

## 13. 交付计划

## 阶段 A：基础

- 配置模式/绑定主机支持
- 启动保护
- Better Auth 集成骨架
- actor 类型扩展

## 阶段 B：Schema 和授权核心

- 添加成员资格/授权/邀请/加入表
- 添加权限服务和辅助函数
- 接入公司/成员/实例管理员检查

## 阶段 C：邀请 + 加入后端

- 邀请创建/撤销
- 邀请接受 -> 待处理请求
- 批准/拒绝 + 密钥认领
- 活动日志 + 实时事件

## 阶段 D：UI + CLI

- 云登录/引导页面
- 邀请落地页
- 收件箱加入审批操作
- 实例设置和成员权限
- 引导 CLI 命令和入职更新

## 阶段 E：加固

- 完整的集成/E2E 覆盖
- 文档更新（`SPEC-implementation`、`DEVELOPING`、`CLI`）
- 清理遗留的仅 board 代码路径

## 14. 验证门禁

交付前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果任何命令被跳过，记录确切的跳过内容和原因。

## 15. 完成标准

1. 行为符合本文档和 `doc/plan/humans-and-permissions.md` 中锁定的 V1 决策。
2. 云模式需要认证；本地模式无登录 UX。
3. 统一的邀请 + 待审批流程对人类和智能体都适用。
4. 共享的主体成员资格 + 权限系统对用户和智能体均已上线。
5. 本地模式保持仅回环绑定，否则启动失败。
6. 收件箱显示可操作的加入审批。
7. 所有新的变更路径都有活动日志记录。
