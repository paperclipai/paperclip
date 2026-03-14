# 部署/身份验证模式整合计划

状态：提案
所有者：服务器+CLI+UI
日期：2026-02-23

## 目标

保持 Paperclip 低摩擦，同时使模式模型更简单、更安全：

1. `local_trusted` 仍然是默认且最简单的路径。
2、一种认证运行模式，支持私网本地使用和公有云使用。
3. 入职/配置/医生保持主要互动且无标志。
4. 董事会身份由数据库中的真实用户行表示，具有明确的角色/成员资格集成点。

## 产品限制（来自评论）

1. `onboard` 默认流程是交互式的（不需要标志）。
2. 第一个模式选择默认为`local_trusted`，具有清晰的UX副本。
3. 经过身份验证的流程为私人曝光与公开曝光提供了指导。
4. `doctor` 默认情况下也应该是无标志的（读取配置并评估所选模式/配置文件）。
5. 不要为废弃的模式名称添加向后兼容的别名层。
6. 计划必须明确涵盖用户/董事会在数据库中的表示方式以及这如何影响任务分配和权限。

## 当前实施审计（截至 2026 年 2 月 23 日）

## 运行时/验证

- 运行时部署模式当前为 `local_trusted | cloud_hosted` (`packages/shared/src/constants.ts`)。
- `local_trusted` 演员目前已合成：
  - `req.actor = { type: "board", userId: "local-board", source: "local_implicit" }` (`server/src/middleware/auth.ts`)。
  - 默认情况下，这不是真正的身份验证用户行。
- `cloud_hosted` 使用更好的身份验证会话和 `authUsers` 行（`server/src/auth/better-auth.ts`、`packages/db/src/schema/auth.ts`）。

## 引导/管理

- `cloud_hosted` 需要 `BETTER_AUTH_SECRET` 并从 `instance_user_roles`（`server/src/index.ts`、`server/src/routes/health.ts`）报告引导状态。
- 引导程序邀请接受将登录用户提升为 `instance_admin`（`server/src/routes/access.ts`、`server/src/services/access.ts`）。

## 成员资格/任务集成

- 用户任务分配需要该用户的活动 `company_memberships` 条目 (`server/src/services/issues.ts`)。
- 本地隐性董事会身份不会自动成为真正的会员主体；这是“董事会作为可分配用户”语义的差距。

## 建议的运行时模型

## 模式

1. `local_trusted`
- 无需登录
- 仅本地主机/环回
- 针对单操作员本地设置进行了优化

2. `authenticated`
- 人类行为需要登录
- 私有和公共部署使用相同的身份验证堆栈

## 暴露政策（`authenticated` 内）

1. `private`
- 专用网络部署（LAN、VPN、Tailscale）
- 低摩擦 URL 处理（`auto` 基本 URL）
- 严格的主机允许私人目标的政策

2. `public`
- 面向互联网的部署
- 需要明确的公共基础 URL
- 医生更严格的部署检查

这是一种具有两种安全策略的身份验证模式，而不是两种不同的身份验证系统。

## 用户体验合同

## Onboard（主要路径：交互式）

默认命令保持不变：

```sh
pnpm paperclipai onboard
```

交互服务器步骤：1.询问方式默认选择`local_trusted`
2. 复制选项：
- `local_trusted`：“最简单的本地设置（无需登录，仅限本地主机）”
- `authenticated`：“需要登录；用于专用网络或公共托管”
3. 如果是`authenticated`，询问曝光：
- `private`：“专用网络访问（例如Tailscale），降低设置难度”
- `public`：“面向互联网部署，安全要求更严格”
4. 仅当`authenticated + public`时，要求明确的公共URL

标志是可选的高级用户覆盖，正常设置不需要。

## 配置

默认命令保持交互：

```sh
pnpm paperclipai configure --section server
```

与入门相同的模式/曝光问题和默认设置。

## 医生

默认命令保持无标志：

```sh
pnpm paperclipai doctor
```

医生读取配置的模式/曝光并应用相关检查。
可选标志可能存在用于覆盖/测试，但对于正常操作来说不是必需的。

## 董事会/用户数据模型集成（必需）

## 要求

董事会必须是真正的数据库用户主体，以便以用户为中心的功能（任务分配、成员身份、审核身份）一致地工作。

## 目标行为

1. `local_trusted`
- 在设置/启动期间在 `authUsers` 中播种/确保确定性本地板用户行。
- 参与者中间件使用真实的用户 ID，而不是仅合成的身份。
- 确保：
  - `instance_user_roles` 包括该用户的 `instance_admin`。
  - 可以在需要时为此用户创建/维护公司会员资格。

2. `authenticated`
- 更好的身份验证注册创建用户行。
- 引导/管理流程将该真实用户提升为 `instance_admin`。
- 第一个公司创建流程应确保创建者会员资格处于活跃状态。

## 为什么这很重要

- `assigneeUserId` 验证检查公司会员资格。
- 没有真正的董事会用户+会员路径，向董事会用户分配任务不一致。

## 配置合约（目标）

- `server.mode`: `local_trusted | authenticated`
- `server.exposure`：`private | public`（模式为`authenticated`时需要）
- `auth.baseUrlMode`: `auto | explicit`
- `auth.publicBaseUrl`：当 `authenticated + public` 时需要

已放弃的命名变体没有兼容性别名。

## 无向后兼容层

这个改变是一个彻底的改变：

- 删除代码和提示中旧的拆分术语的使用。
- 配置模式仅使用上面的规范字段/值。
- 现有的开发实例可以重新运行载入或更新配置一次。

## 实施阶段

## 第 1 阶段：共享架构 + 配置表面

- `packages/shared/src/constants.ts`：定义规范模式/曝光常数。
- `packages/shared/src/config-schema.ts`：添加模式/曝光/身份验证 URL 字段。
- `server/src/config.ts` 和 CLI 配置类型：仅使用规范字段。

## 第 2 阶段：CLI 交互用户体验- `cli/src/prompts/server.ts`：实现默认模式提示和经过验证的曝光指导副本。
- `cli/src/commands/onboard.ts`：保持互动优先流程；仅可选覆盖。
- `cli/src/commands/configure.ts`：服务器部分的行为相同。
- `cli/src/commands/doctor.ts`：从配置进行模式感知检查，无标志默认流程。

## 第 3 阶段：运行时/身份验证策略

- `server/src/index.ts`：强制执行特定于模式的启动约束。
- `server/src/auth/better-auth.ts`：实现 `auto` 与 `explicit` 基本 URL 行为。
- `authenticated + private` 的主机/源信任助手。

## 第四阶段：董事会主体整合

- 添加确保板用户启动/设置步骤：
  - 真实的本地板用户行
  - 实例管理员角色行
- 确保第一家公司创建路径授予创建者成员资格。
- 删除仅合成的假设，因为它们会破坏用户分配/成员资格语义。

## 阶段 5：UI + 文档

- 围绕模式和曝光指南更新 UI 标签/帮助文本。
- 更新文档：
  - `doc/DEPLOYMENT-MODES.md`
  - `doc/DEVELOPING.md`
  - `doc/CLI.md`
  - `doc/SPEC-implementation.md`

## 测试计划

- 规范模式/暴露/身份验证字段的配置模式测试。
- CLI 提示测试默认交互选择和复制。
- 医生按模式/暴露进行测试。
- 运行时测试：
  - 经过身份验证/私人作品，无需明确的 URL
  - 经过身份验证/公开需要明确的 URL
  - 私有主机策略拒绝不受信任的主机
- 董事会主要测试：
  - local_trusted board用户作为真实的DB用户存在
  - 会员设置后，可以通过`assigneeUserId`向董事会分配任务
  - 经过身份验证的流的创建者成员资格行为

## 验收标准

1. `pnpm paperclipai onboard` 为交互优先，默认为 `local_trusted`。
2. 身份验证模式是一种运行时模式，具有 `private/public` 暴露指导。
3. `pnpm paperclipai doctor` 通过模式感知检查进行无标志工作。
4. 删除的命名变体不再需要额外的兼容性别名。
5. 董事会身份由真实的数据库用户/角色/会员集成点表示，从而实现一致的任务分配和权限行为。

## 验证门

合并前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```