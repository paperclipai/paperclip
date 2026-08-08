---
title: 本地开发
summary: 设置Paperclip进行本地开发
---
本地运行 Paperclip，外部依赖为零。

## 前置条件

- Node.js 20+
- pnpm 9+

## 启动开发服务器

```sh
pnpm install
pnpm dev
```

这开始：

- **API 服务器** `http://localhost:3100`
- **UI** 由 API 服务器以开发中间件模式提供服务（同源）

无需 Docker 或外部数据库。 Paperclip 自动使用嵌入的 PostgreSQL。

## 单命令启动

对于首次安装：

```sh
pnpm paperclipai run
```

这会：

1. 如果配置丢失则自动启动
2. 运行 `paperclipai doctor` 并启用修复
3. 检查通过后启动服务器

## Tailscale/私有授权开发模式

以`authenticated/private`模式运行进行网络访问：

```sh
pnpm dev --tailscale-auth
```

这样就可以将服务器绑定到`0.0.0.0`上，实现私网访问。

别名：

```sh
pnpm dev --authenticated-private
```

允许其他私有主机名：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

有关完整设置和故障排除，请参阅 [Tailscale 私人访问](/cn/deploy/tailscale-private-access)。

## 健康检查

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

|数据|路径|
|------|------|
|配置 | `~/.paperclip/instances/default/config.json` |
|数据库| `~/.paperclip/instances/default/db` |
|存储| `~/.paperclip/instances/default/data/storage` |
|秘密钥匙| `~/.paperclip/instances/default/secrets/master.key` |
|日志 | `~/.paperclip/instances/default/logs` |

使用环境变量覆盖：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```