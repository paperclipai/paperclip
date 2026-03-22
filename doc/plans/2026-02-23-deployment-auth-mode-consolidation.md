# 部署/认证模式整合计划

状态：提案
负责方：Server + CLI + UI
日期：2026-02-23

## 目标

保持 Paperclip 低摩擦的同时使模式模型更简单、更安全：

1. `local_trusted` 仍然是默认且最简单的路径。
2. 一个认证运行时模式同时支持私有网络本地使用和公共云使用。
3. 入职/配置/诊断主要保持交互式且无需标志。
4. Board 身份由数据库中的真实用户行表示，具有显式的角色/成员资格集成点。

## 产品约束（来自评审）

1. `onboard` 默认流程是交互式的（不需要标志）。
2. 首次模式选择默认为 `local_trusted`，配有清晰的 UX 文案。
3. 认证流程为私有与公共暴露提供指引。
4. `doctor` 也应默认无标志（读取配置并评估选定的模式/配置文件）。
5. 不要为已废弃的模式名称添加向后兼容别名层。
6. 计划必须明确涵盖用户/Board 如何在数据库中表示，以及这如何影响任务分配和权限。

## 当前实现审计（截至 2026-02-23）

## 运行时/认证

- 运行时部署模式当前为 `local_trusted | cloud_hosted`（`packages/shared/src/constants.ts`）。
- `local_trusted` actor 当前是合成的：
  - `req.actor = { type: "board", userId: "local-board", source: "local_implicit" }`（`server/src/middleware/auth.ts`）。
  - 默认情况下这不是真实的认证用户行。
- `cloud_hosted` 使用 Better Auth 会话和 `authUsers` 行（`server/src/auth/better-auth.ts`、`packages/db/src/schema/auth.ts`）。

## 引导/管理

- `cloud_hosted` 需要 `BETTER_AUTH_SECRET` 并从 `instance_user_roles` 报告引导状态（`server/src/index.ts`、`server/src/routes/health.ts`）。
- 引导邀请接受将已登录用户提升为 `instance_admin`（`server/src/routes/access.ts`、`server/src/services/access.ts`）。

## 成员资格/分配集成

- 用户任务分配需要该用户的活跃 `company_memberships` 条目（`server/src/services/issues.ts`）。
- 本地隐式 board 身份不会自动成为真实的成员资格主体；这是"board 作为可分配用户"语义的一个缺口。

## 提议的运行时模型

## 模式

1. `local_trusted`
- 不需要登录
- 仅 localhost/回环
- 为单操作员本地设置优化

2. `authenticated`
- 人类操作需要登录
- 相同的认证栈适用于私有和公共部署

## 暴露策略（在 `authenticated` 内）

1. `private`
- 私有网络部署（LAN、VPN、Tailscale）
- 低摩擦 URL 处理（`auto` 基础 URL）
- 对私有目标的严格主机允许策略

2. `public`
- 面向互联网的部署
- 需要显式的公共基础 URL
- 诊断中更严格的部署检查

这是一个认证模式加两种安全策略，而非两个不同的认证系统。

## UX 合约

## 入职（主要路径：交互式）

默认命令保持不变：

```sh
pnpm paperclipai onboard
```

交互式服务器步骤：

1. 询问模式，默认选择 `local_trusted`
2. 选项文案：
- `local_trusted`："最简单的本地设置（无需登录，仅 localhost）"
- `authenticated`："需要登录；用于私有网络或公共托管"
3. 如果选择 `authenticated`，询问暴露方式：
- `private`："私有网络访问（例如 Tailscale），较低的设置摩擦"
- `public`："面向互联网的部署，更严格的安全要求"
4. 仅当 `authenticated + public` 时，要求提供显式的公共 URL

标志是可选的高级用户覆盖，正常设置不需要。

## 配置

默认命令保持交互式：

```sh
pnpm paperclipai configure --section server
```

与入职相同的模式/暴露问题和默认值。

## 诊断

默认命令保持无标志：

```sh
pnpm paperclipai doctor
```

诊断读取配置的模式/暴露并应用相关检查。可选标志可能用于覆盖/测试，但正常操作不需要。

## Board/用户数据模型集成（必需）

## 需求

Board 必须是真实的数据库用户主体，这样以用户为中心的功能（任务分配、成员资格、审计身份）才能一致工作。

## 目标行为

1. `local_trusted`
- 在设置/启动期间 seed/确保 `authUsers` 中有一个确定性的本地 board 用户行。
- actor 中间件使用该真实用户 ID 而非仅合成的身份。
- 确保：
  - `instance_user_roles` 包含该用户的 `instance_admin`。
  - 可以在需要时为该用户创建/维护公司成员资格。

2. `authenticated`
- Better Auth 注册创建用户行。
- 引导/管理流程将该真实用户提升为 `instance_admin`。
- 首次公司创建流程应确保创建者成员资格是活跃的。

## 为什么这很重要

- `assigneeUserId` 验证检查公司成员资格。
- 如果没有真实的 board 用户 + 成员资格路径，将任务分配给 board 用户是不一致的。

## 配置合约（目标）

- `server.mode`：`local_trusted | authenticated`
- `server.exposure`：`private | public`（当 mode 为 `authenticated` 时必需）
- `auth.baseUrlMode`：`auto | explicit`
- `auth.publicBaseUrl`：当 `authenticated + public` 时必需

不为已丢弃的命名变体设置兼容别名。

## 无向后兼容层

这是一次干净的切换：

- 在代码和 prompt 中移除旧的拆分术语的使用。
- 配置 schema 仅使用上述规范字段/值。
- 现有开发实例可以重新运行入职或更新一次配置。

## 实施阶段

## 第一阶段：共享 Schema + 配置界面

- `packages/shared/src/constants.ts`：定义规范的模式/暴露常量。
- `packages/shared/src/config-schema.ts`：添加模式/暴露/认证 URL 字段。
- `server/src/config.ts` 和 CLI 配置类型：仅使用规范字段。

## 第二阶段：CLI 交互式 UX

- `cli/src/prompts/server.ts`：实现带默认值的模式提示和认证暴露指引文案。
- `cli/src/commands/onboard.ts`：保持交互优先流程；仅可选覆盖。
- `cli/src/commands/configure.ts`：服务器部分相同行为。
- `cli/src/commands/doctor.ts`：从配置读取模式感知检查，默认无标志流程。

## 第三阶段：运行时/认证策略

- `server/src/index.ts`：强制模式特定的启动约束。
- `server/src/auth/better-auth.ts`：实现 `auto` vs `explicit` 基础 URL 行为。
- `authenticated + private` 的主机/来源信任辅助函数。

## 第四阶段：Board 主体集成

- 添加确保 board 用户的启动/设置步骤：
  - 真实的本地 board 用户行
  - 实例管理员角色行
- 确保首次公司创建路径授予创建者成员资格。
- 移除仅合成身份在用户分配/成员资格语义中导致问题的假设。

## 第五阶段：UI + 文档

- 更新围绕模式和暴露指引的 UI 标签/帮助文本。
- 更新文档：
  - `doc/DEPLOYMENT-MODES.md`
  - `doc/DEVELOPING.md`
  - `doc/CLI.md`
  - `doc/SPEC-implementation.md`

## 测试计划

- 规范模式/暴露/认证字段的配置 schema 测试。
- 默认交互选择和文案的 CLI 提示测试。
- 按模式/暴露的诊断测试。
- 运行时测试：
  - authenticated/private 无需显式 URL 即可工作
  - authenticated/public 需要显式 URL
  - 私有主机策略拒绝不受信主机
- Board 主体测试：
  - local_trusted board 用户作为真实数据库用户存在
  - 成员资格设置后 board 可以通过 `assigneeUserId` 被分配任务
  - 认证流程的创建者成员资格行为

## 验收标准

1. `pnpm paperclipai onboard` 是交互优先的，默认为 `local_trusted`。
2. 认证模式是一个运行时模式加 `private/public` 暴露指引。
3. `pnpm paperclipai doctor` 无标志工作，带模式感知检查。
4. 没有为已废弃命名变体设置额外的兼容别名。
5. Board 身份由真实的数据库用户/角色/成员资格集成点表示，实现一致的任务分配和权限行为。

## 验证门禁

合并前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```
