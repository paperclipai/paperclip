---
title: 部署概览 (Deployment Overview)
summary: 部署模式一览
---

Paperclip 官方支持三种部署配置模式：从零摩擦的本地启动，到面向互联网的云端生产环境。

## 部署模式 (Deployment Modes)

| 模式 | 身份验证机制 | 最适用场景 |
|------|------|----------|
| `local_trusted` (本地受信任模式) | 无需登录 | 个人开发者的单机工作站本地环境 |
| `authenticated` + `private` (鉴权 + 私有模式) | 强制需要登录 | 私有内部网络 (Tailscale 组网, VPN, 局域网 LAN 等) |
| `authenticated` + `public` (鉴权 + 对外公开模式) | 强制需要登录 | 面向互联网对外直接暴露的云端部署环境 |

## 快速对比 (Quick Comparison)

### 本地受信任模式 Local Trusted (系统默认选项)

- 绑定的 Host 仅限环回地址 (localhost)
- 完全没有供人类用户登录验证的授权流程
- 本地启动速度最快
- 适用场景：个人开发、测试实验把玩

### 鉴权 + 私有模式 Authenticated + Private

- 强制使用 Better Auth 进行登录鉴权
- 绑定到所有网络接口 (0.0.0.0)，以便能够跨网访问
- 采取自动探针形式的 base URL 探测模式 (显著降低配置摩擦)
- 适用场景：由小团队通过 Tailscale 组网或在某个局域网下共同协作访问

### 鉴权 + 对外公开模式 Authenticated + Public

- 强制需要登录
- 强制要求显式地提供公网 URL 地址
- 会执行更加严格的各种安全性校验
- 适用场景：云端服务器托管、直接面向公网互联网暴露的正式部署环境

## 如何选择模式？

- **仅仅是想先试试看 Paperclip？** 毫无疑问使用 `local_trusted` (这个也是缺省默认选项)
- **想在一个私密团队网络内群发共享使用？** 请使用 `authenticated` + `private`
- **需要正式上云对外开放？** 请使用 `authenticated` + `public`

在上机向导期间设定该模式：

```sh
pnpm paperclipai onboard
```

或者随后随时去去更改它：

```sh
pnpm paperclipai configure --section server
```
