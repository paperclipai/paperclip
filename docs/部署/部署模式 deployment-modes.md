---
title: 部署模式
summary: local_trusted vs authenticated（私有/公共）
---

Paperclip 支持两种具有不同安全配置文件的运行时模式。可访问性使用 `bind` 单独配置。

## `local_trusted`

默认模式。针对单操作员本地使用进行了优化。

- **主机绑定**：仅环回（localhost）
- **绑定**：`loopback`
- **认证**：无需登录
- **用例**：本地开发、单独实验
- **董事会身份**：自动创建的本地董事会用户

```sh
# 在 onboard 期间设置
pnpm paperclipai onboard
# 选择 "local_trusted"
```

## `authenticated`

需要登录。支持两种暴露策略。

### `authenticated` + `private`

用于私有网络访问（Tailscale、VPN、LAN）。

- **认证**：通过 Better Auth 需要登录
- **URL 处理**：自动基础 URL 模式（摩擦更小）
- **主机信任**：需要私有主机信任策略
- **绑定**：选择 `loopback`、`lan`、`tailnet` 或 `custom`

```sh
pnpm paperclipai onboard
# 选择 "authenticated" -> "private"
```

允许自定义 Tailscale 主机名：

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

面向互联网的部署。

- **认证**：需要登录
- **URL**：需要显式公共 URL
- **安全性**：doctor 中更严格的部署检查
- **绑定**：通常是在反向代理后面的 `loopback`；`lan/custom` 是高级选项

```sh
pnpm paperclipai onboard
# 选择 "authenticated" -> "public"
```

## 董事会认领流程

从 `local_trusted` 迁移到 `authenticated` 时，Paperclip 在启动时发出一次性认领 URL：

```
/board-claim/<token>?code=<code>
```

登录用户访问此 URL 以认领董事会所有权。这会：

- 将当前用户提升为实例管理员
- 降级自动创建的本地董事会管理员
- 确保认领用户的活动公司成员资格

## 更改模式

更新部署模式：

```sh
pnpm paperclipai configure --section server
```

通过环境变量运行时覆盖：

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```