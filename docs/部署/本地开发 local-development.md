---
title: 本地开发
summary: 为本地开发设置 Paperclip
---

在本地运行 Paperclip，无需任何外部依赖。

## 先决条件

- Node.js 20+
- pnpm 9+

## 启动开发服务器

```sh
pnpm install
pnpm dev
```

这会启动：

- **API 服务器**在 `http://localhost:3100`
- **UI** 由 API 服务器在开发中间件模式下提供（同源）

无需 Docker 或外部数据库。Paperclip 自动使用嵌入式 PostgreSQL。

## 单命令引导

对于首次安装：

```sh
pnpm paperclipai run
```

这会执行：

1. 如果配置缺失，自动入门
2. 运行 `paperclipai doctor` 并启用修复
3. 当检查通过时启动服务器

## 开发中的绑定预设

默认的 `pnpm dev` 保持在 `local_trusted` 模式，仅绑定到环回。

要打开 Paperclip 到私有网络并启用登录：

```sh
pnpm dev --bind lan
```

对于在检测到的 tailnet 地址上仅绑定 Tailscale：

```sh
pnpm dev --bind tailnet
```

传统别名仍然有效，并映射到较旧的广泛私有网络行为：

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

允许其他私有主机名：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

有关完整设置和故障排除，请参阅 [Tailscale 私有访问](/部署/Tailscale%20私有访问%20tailscale-private-access)。

## 运行状况检查

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## 重置开发数据

要擦除本地数据并重新开始：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 数据位置

| 数据 | 路径 |
|------|------|
| 配置 | `~/.paperclip/instances/default/config.json` |
| 数据库 | `~/.paperclip/instances/default/db` |
| 存储 | `~/.paperclip/instances/default/data/storage` |
| 密钥密钥 | `~/.paperclip/instances/default/secrets/master.key` |
| 日志 | `~/.paperclip/instances/default/logs` |

通过环境变量覆盖：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```