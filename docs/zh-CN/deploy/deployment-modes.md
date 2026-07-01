---
title: 部署模式 (Deployment Modes)
summary: local_trusted 模式与 authenticated (包括 private/public) 模式的详解
---

Paperclip 在运行时支持两种拥有不同安全权限侧重点的管理模式。

## `local_trusted` (本地受信任模式)

系统的默认模式。专门为单人操作使用且仅跑在本地物理机上的使用场景做了大幅极简优化。

- **宿主绑定 (Host binding)**: 只能从环回地址访问 (localhost)
- **身份验证 (Authentication)**: 根本不需要登录
- **使用场景 (Use case)**: 本地常规开发，个人实验性质跑着玩
- **董事会身份 (Board identity)**: 系统自动生成一个本地虚拟董事会超管用户

```sh
# 在基础引导阶段设定
pnpm paperclipai onboard
# 选择 "local_trusted" 选项
```

## `authenticated` (鉴权模式)

强制需要登录。内部细分为两种不同级别的暴露策略 (exposure policies)。

### `authenticated` + `private` (鉴权 + 私有模式)

适用于私有网络内部进行访问使用（如：Tailscale, VPN, 内网 LAN）。

- **身份验证**: 强制系统使用 Better Auth 框架索要登录
- **URL 的判定**: 使用自动 base URL 识别判定模式（降低需要写死写配配置的门槛阻力）
- **主机信任 (Host trust)**: 需要强制满足针对私有主机的信任策略约束

```sh
pnpm paperclipai onboard
# 选择 "authenticated" -> "private" 选项
```

如果使用非常用命名的主机域名，需允许白名单放行你自行命名的 Tailscale private hostname 主机网关名称：

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public` (鉴权 + 对外公开模式)

用于那些直接面向广域网互联网彻底暴露的正式开放站点。

- **身份验证**: 强制要求安全登录
- **URL 的判定**: 必须在启动前显式地把公开外部可访问的 URL 提供锁死去
- **安全检查 (Security)**: 系统 doctor 在执行全量体检时将会适用执行最严苛的一批校验条款

```sh
pnpm paperclipai onboard
# 选择 "authenticated" -> "public"
```

## 会员申领认领流程 (Board Claim Flow)

当你要在生产环境中把系统从早先松散的 `local_trusted` 模式升格切换并迁移到严谨的 `authenticated` 时，Paperclip 在启动时将会单独在终端里吐出一条一次性专属使用的认领声明链接 URL (claim URL):

```
/board-claim/<token>?code=<code>
```

一旦有一个已正常注册登录的合法用户访问跳转并吃掉这个独家链接来当面申明“这个董事会是我的”：

- 则会立即提拔升格该当前操作用户成为实例的高级总权限管理员
- 同时即刻永久剥夺褫夺那个早先曾被系统偷偷建出来兜底用的假本地虚空管理员的一切实权
- 该声明申领的人员也会立刻补登注销拿到属于这整个当前第一顺位活动公司 (active company) 的专属席位会籍身份

## 随时切换与变更部署模式 (Changing Modes)

重写修改保存更新部署配置策略的方法：

```sh
pnpm paperclipai configure --section server
```

你甚至可以在平时日常起服务时临时在命令行前头直接用环境变量当做越权开关重写：

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```
