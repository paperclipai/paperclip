---
title: 部署概览
summary: 部署模式一目了然
---

Paperclip 支持三种部署配置，从零摩擦本地到面向互联网的生产。

## 部署模式

| 模式 | 认证 | 最适合 |
|------|------|----------|
| `local_trusted` | 无需登录 | 单操作员本地机器 |
| `authenticated` + `private` | 需要登录 | 私有网络（Tailscale、VPN、LAN） |
| `authenticated` + `public` | 需要登录 | 面向互联网的云部署 |

## 快速比较

### 本地信任（默认）

- 仅环回主机绑定（localhost）
- 无需人工登录流程
- 最快的本地启动
- 最适合：单独开发和实验

### 已认证 + 私有

- 通过 Better Auth 需要登录
- 绑定到所有接口以进行网络访问
- 自动基础 URL 模式（摩擦更小）
- 最适合：通过 Tailscale 或本地网络进行团队访问

### 已认证 + 公共

- 需要登录
- 需要显式公共 URL
- 更严格的安全检查
- 最适合：云托管、面向互联网的部署

## 选择模式

- **只是尝试 Paperclip？** 使用 `local_trusted`（默认）
- **在私有网络上与团队共享？** 使用 `authenticated` + `private`
- **部署到云？** 使用 `authenticated` + `public` — 参见 [AWS ECS Fargate 指南](<AWS ECS Fargate aws-ecs.md>)

在入门期间设置模式：

```sh
pnpm paperclipai onboard
```

或者稍后更新：

```sh
pnpm paperclipai configure --section server
```