---
title: 部署模式
summary: local_trusted 与经过身份验证的（私有/公共）
---
Paperclip 支持两种具有不同安全配置文件的运行模式。

## `local_trusted`

默认模式。针对单操作员本地使用进行了优化。

- **主机绑定**：仅环回（本地主机）
- **身份验证**：无需登录
- **用例**：本地开发、单独实验
- **董事会身份**：自动创建的本地董事会用户

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

需要登录。支持两种曝光策略。

### `authenticated` + `private`

用于专用网络访问（Tailscale、VPN、LAN）。

- **身份验证**：需要通过 Better Auth 登录
- **URL 处理**：自动基本 URL 模式（较低摩擦）
- **主机信任**：需要私有主机信任策略

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

允许自定义 Tailscale 主机名：

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

用于面向互联网的部署。

- **身份验证**：需要登录
- **URL**：需要明确的公共 URL
- **安全**：对医生进行更严格的部署检查

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## 董事会索赔流程

从 `local_trusted` 迁移到 `authenticated` 时，Paperclip 在启动时发出一次性声明 URL：

```
/board-claim/<token>?code=<code>
```

登录用户访问此 URL 即可声明论坛所有权。这个：

- 将当前用户提升为实例管理员
- 降级自动创建的本地板管理员
- 确保声明用户拥有活跃的公司会员资格

## 改变模式

更新部署模式：

```sh
pnpm paperclipai configure --section server
```

通过环境变量覆盖运行时：

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```