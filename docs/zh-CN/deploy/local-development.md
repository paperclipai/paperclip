---
title: 本地开发部署 (Local Development)
summary: 在本地为开发环境部署起你的 Paperclip
---

让 Paperclip 完全实现“零外部依赖”无痛地在您自己的本地机器上拉起运行。

## 前置环境要求 (Prerequisites)

- Node.js 20 及以上版本
- pnpm 9 及以上版本

## 启动开发服务器 (Start Dev Server)

```sh
pnpm install
pnpm dev
```

该命令将直接启动并在后台挂载：

- 访问在 `http://localhost:3100` 端口上的 **API 后端服务**
- 运行在开发者中间件模式下的 **UI 图形前端**（它与后端服务器共享相同的 origin 源源）

您根本不需要费劲周折再去安装或者起什么 Docker 以及外部的数据库组件。Paperclip 出厂自带并会自动采用内嵌版本的 PostgreSQL（即 PGlite）。

## 一键式向导启动 (One-Command Bootstrap)

如果是第一次全新的安装运行体验：

```sh
pnpm paperclipai run
```

这一条命令大包大揽：

1. 如果发现系统配置文件缺失，则会自动开启指引向导 (Auto-onboards)
2. 运行 `paperclipai doctor` 执行全面诊断并自带自动修正修复补丁
3. 一旦所有检查项均通过放行，正式打火启动后台服务器

## Tailscale 及私有鉴权开发模式 (Tailscale/Private Auth Dev Mode)

要使用 `authenticated/private`（鉴权/私密网络）模式以便外网能够连入访问：

```sh
pnpm dev --tailscale-auth
```

这种模式会将服务器暴露并绑定在 `0.0.0.0` 接口上，允许私有组网内直接网络访问打通。

同义指令的别称写法 (Alias)：

```sh
pnpm dev --authenticated-private
```

允许白名单放行特定额外附加使用的私有主机名域 (hostname)：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

如需查阅关于此方面的全套完整设置及故障排除排障手册，请参阅专门的[利用 Tailscale 进行私有组网访问](/deploy/tailscale-private-access)指南。

## 健康检查接口 (Health Checks)

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## 清空重置全部本地开发数据 (Reset Dev Data)

如果玩坏了想要“删库跑路”彻底重来：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 各类核心数据落盘位置存放表 (Data Locations)

| 数据类别 | 落盘目录路径 |
|------|------|
| 配置文件 (Config) | `~/.paperclip/instances/default/config.json` |
| 数据库文件 (Database) | `~/.paperclip/instances/default/db` |
| 存储块 (Storage) | `~/.paperclip/instances/default/data/storage` |
| 机密母钥匙环 (Secrets key) | `~/.paperclip/instances/default/secrets/master.key` |
| 日志归档 (Logs) | `~/.paperclip/instances/default/logs` |

可以在拉起时通过向其塞入环境变量来强行覆写重定向它们的位置：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
