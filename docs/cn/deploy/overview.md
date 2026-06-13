---
title: 部署概述
summary: 部署模式一览
---
Paperclip 支持三种部署配置，从零摩擦本地到面向互联网的生产。

## 部署模式

|模式|授权 |最适合 |
|------|------|----------|
| `local_trusted` |无需登录 |单操作员本地机 |
| `authenticated` + `private` |需要登录 |专用网络（Tailscale、VPN、LAN）|
| `authenticated` + `public` |需要登录 |面向互联网的云部署|

## 快速比较

### 本地可信（默认）

- 仅环回主机绑定 (localhost)
- 无需人工登录流程
- 最快的本地启动
- 最适合：单独开发和实验

### 已验证 + 私有

- 需要通过 Better Auth 登录
- 绑定到所有网络访问接口
- 自动基本 URL 模式（低摩擦）
- 最适合：通过 Tailscale 或本地网络进行团队访问

### 已验证 + 公开

- 需要登录
- 需要明确的公共 URL
- 更严格的安全检查
- 最适合：云托管、面向互联网的部署

## 选择模式

- **只是尝试 Paperclip？** 使用 `local_trusted` （默认）
- **与专用网络上的团队共享？** 使用 `authenticated` + `private`
- **部署到云端？** 使用 `authenticated` + `public`

在入职期间设置模式：

```sh
pnpm paperclipai onboard
```

或者稍后更新：

```sh
pnpm paperclipai configure --section server
```