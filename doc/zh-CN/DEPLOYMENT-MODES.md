# 部署模式

状态：规范部署和身份验证模式模型
日期：2026-02-23

## 1. 目的

Paperclip 支持两种运行模式：

1. `local_trusted`
2. `authenticated`

`authenticated` 支持两种曝光策略：

1. `private`
2. `public`

这保留了一个经过身份验证的身份验证堆栈，同时仍将低摩擦专用网络默认设置与面向互联网的强化要求分开。

## 2. 规范模型

|运行时模式 |曝光|人类授权|主要用途 |
|---|---|---|---|
| `local_trusted` |不适用 |无需登录 |单操作员本地机器工作流程 |
| `authenticated` | `private` |需要登录 |专网访问（例如Tailscale/VPN/LAN）|
| `authenticated` | `public` |需要登录 |面向互联网/云部署 |

## 3. 安全策略

## `local_trusted`

- 仅环回主机绑定
- 无需人工登录流程
- 针对最快的本地启动进行了优化

## `authenticated + private`

- 需要登录
- 低摩擦 URL 处理（`auto` 基本 URL 模式）
- 需要私有主机信任策略

## `authenticated + public`

- 需要登录
- 需要明确的公共 URL
- 更严格的部署检查和医生的失败

## 4. 入职用户体验合同

默认加入保持交互式且无标志：

```sh
pnpm paperclipai onboard
```

服务器提示行为：

1. 询问模式，默认`local_trusted`
2. 选项复制：
- `local_trusted`：“最简单的本地设置（无需登录，仅限本地主机）”
- `authenticated`：“需要登录；用于专用网络或公共托管”
3. 如果是`authenticated`，询问曝光：
- `private`：“专用网络访问（例如Tailscale），降低设置难度”
- `public`：“面向互联网部署，安全要求更严格”
4. 仅针对 `authenticated + public` 询问显式公共 URL

`configure --section server` 遵循相同的交互行为。

## 5. 博士用户体验合同

默认医生保持无旗状态：

```sh
pnpm paperclipai doctor
```

医生读取配置的模式/曝光并应用模式感知检查。可选的覆盖标志是次要的。

## 6. 董事会/用户集成合同

董事会身份必须由真实的数据库用户主体代表，以便基于用户的功能能够一致地工作。

所需的集成点：

- `authUsers` 中的真实用户行用于董事会身份
- `instance_user_roles` 论坛管理员权限入口
- `company_memberships` 集成，用于用户级任务分配和访问

这是必需的，因为用户分配路径验证 `assigneeUserId` 的活动成员资格。

## 7. 本地可信 -> 经过身份验证的声明流程

运行 `authenticated` 模式时，如果唯一的实例管理员是 `local-board`，则 Paperclip 会发出带有一次性高熵声明 URL 的启动警告。- 网址格式：`/board-claim/<token>?code=<code>`
- 预期用途：已登录的人类索赔委员会所有权
- 索赔行动：
  - 将当前登录用户升级为`instance_admin`
  - 降级 `local-board` 管理员角色
  - 确保现有公司中声明用户的活跃所有者成员资格

当用户从长期运行的本地可信使用迁移到身份验证模式时，这可以防止锁定。

## 8. 当前代码现实（截至 2026-02-23）

- 运行时值为 `local_trusted | authenticated`
- `authenticated` 使用更好的身份验证会话和引导邀请流程
- `local_trusted` 确保 `authUsers` 中真正的本地董事会用户主体具有 `instance_user_roles` 管理员访问权限
- 公司创建确保创建者在 `company_memberships` 中的成员资格，以便用户分配/访问流程保持一致

## 9. 命名和兼容性政策

- 规范命名为 `local_trusted` 和 `authenticated`，其中 `private/public` 曝光
- 没有用于废弃命名变体的长期兼容性别名层

## 10. 与其他文档的关系

- 实施计划：`doc/plans/deployment-auth-mode-consolidation.md`
- V1合约：`doc/SPEC-implementation.md`
- 操作员工作流程：`doc/DEVELOPING.md` 和 `doc/CLI.md`