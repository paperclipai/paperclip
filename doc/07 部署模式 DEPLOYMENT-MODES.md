# 部署模式（Deployment Modes）

状态：规范的部署与认证模式模型  
日期：2026-02-23

## 1. 目的

Paperclip 支持两种运行时模式（runtime modes）：

1. `local_trusted`
2. `authenticated`

`authenticated` 支持两种暴露策略（exposure policies）：

1. `private`
2. `public`

这样可以在保持统一的认证栈的同时，将低摩擦的私有网络默认配置与面向互联网的加固要求区分开来。

Paperclip 现将**绑定（bind）**视为与认证（auth）分离的关注点：

- 认证模型：`local_trusted` vs `authenticated`，以及 `private/public`
- 可达性模型（reachability model）：`server.bind = loopback | lan | tailnet | custom`

## 2. 规范模型

| 运行时模式 | 暴露策略 | 用户认证 | 主要用途 |
|---|---|---|---|
| `local_trusted` | 不适用 | 无需登录 | 单操作者本地机器工作流 |
| `authenticated` | `private` | 需要登录 | 私有网络访问（例如 Tailscale/VPN/LAN） |
| `authenticated` | `public` | 需要登录 | 面向互联网/云端部署 |

## 可达性模型

| 绑定方式 | 含义 | 典型用途 |
|---|---|---|
| `loopback` | 仅监听 localhost | 默认本地使用、反向代理部署 |
| `lan` | 监听所有接口（`0.0.0.0`） | LAN/VPN/私有网络访问 |
| `tailnet` | 监听检测到的 Tailscale IP | 仅限 Tailscale 访问 |
| `custom` | 监听指定的主机/IP | 高级的特定接口配置 |

## 3. 安全策略

## `local_trusted`

- 仅绑定回环地址（loopback-only）
- 无需用户登录流程
- 针对最快的本地启动进行优化

## `authenticated + private`

- 需要登录
- 低摩擦的 URL 处理（`auto` 基础 URL 模式）
- 需要私有主机信任策略
- 绑定方式可以是 `loopback`、`lan`、`tailnet` 或 `custom`

## `authenticated + public`

- 需要登录
- 需要显式的公开 URL
- doctor 工具中有更严格的部署检查和失败提示
- 推荐绑定方式为 `loopback` 并置于反向代理之后；直接使用 `lan/custom` 属于高级操作

## 4. 引导体验合约（Onboarding UX Contract）

默认引导流程保持交互式且无需标志位：

```sh
pnpm paperclipai onboard
```

服务器提示行为：

1. 快速启动 `--yes` 默认为 `server.bind=loopback`，因此为 `local_trusted/private`
2. 高级服务器设置首先询问可达性：
- `Trusted local` → `bind=loopback`，`local_trusted/private`
- `Private network` → `bind=lan`，`authenticated/private`
- `Tailnet` → `bind=tailnet`，`authenticated/private`
- `Custom` → 手动输入模式/暴露策略/主机地址
3. 原始主机输入仅在 `Custom` 路径下需要
4. 显式公开 URL 仅在 `authenticated + public` 下需要

示例：

```sh
pnpm paperclipai onboard --yes
pnpm paperclipai onboard --yes --bind lan
pnpm paperclipai run --bind tailnet
```

`configure --section server` 遵循相同的交互行为。

## 5. Doctor 体验合约

默认 doctor 保持无标志位：

```sh
pnpm paperclipai doctor
```

Doctor 读取已配置的模式/暴露策略，并应用模式感知的检查。可选的覆盖标志位是次要的。

## 6. Board/用户集成合约

Board 身份必须由真实的数据库用户主体（DB user principal）表示，才能使基于用户的功能一致运作。

必需的集成点：

- `authUsers` 中为 Board 身份提供真实用户行
- `instance_user_roles` 条目用于 Board 管理员权限
- `company_memberships` 集成用于用户级别的任务分配和访问控制

这是因为用户分配路径会验证 `assigneeUserId` 的有效成员资格。

## 7. 本地信任 → 认证模式认领流程

当运行 `authenticated` 模式时，如果唯一的实例管理员是 `local-board`，Paperclip 会在启动时发出警告，并提供一次性的高熵认领 URL（claim URL）。

- URL 格式：`/board-claim/<token>?code=<code>`
- 预期用途：已登录的用户认领 Board 所有权
- 认领操作：
  - 将当前登录用户提升为 `instance_admin`
  - 降级 `local-board` 的管理员角色
  - 确保认领用户在现有公司中拥有活跃的所有者成员资格

这可以防止用户从长期运行的本地信任使用迁移到认证模式时被锁定。

## 8. 当前代码现状（截至 2026-02-23）

- 运行时值为 `local_trusted | authenticated`
- `authenticated` 使用 Better Auth 会话（sessions）和引导邀请流程
- `local_trusted` 确保在 `authUsers` 中存在真实的本地 Board 用户主体，并具有 `instance_user_roles` 管理员访问权限
- 公司创建确保创建者在 `company_memberships` 中拥有成员资格，从而使用户分配/访问流程保持一致

## 9. 命名与兼容性策略

- 规范命名为 `local_trusted` 和 `authenticated`，配合 `private/public` 暴露策略
- 对已废弃的命名变体不提供长期兼容性别名层

## 10. 与其他文档的关系

- 实现计划：`doc/plans/deployment-auth-mode-consolidation.md`
- V1 合约：`doc/04 实现规格 SPEC-implementation.md`
- 操作者工作流：`doc/05 开发指南 DEVELOPING.md` 和 `doc/09 命令行 CLI.md`
- 邀请/加入状态图：`doc/spec/邀请流程 invite-flow.md`
