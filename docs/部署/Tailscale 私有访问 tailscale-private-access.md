---
title: Tailscale 私有访问
summary: 使用 Tailscale 友好的绑定预设运行 Paperclip 并从其他设备连接
---

当你希望通过 Tailscale（或私有 LAN/VPN）而不是仅 `localhost` 访问 Paperclip 时，请使用此方法。

## 1. 在私有认证模式下启动 Paperclip

```sh
pnpm dev --bind tailnet
```

推荐行为：

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_BIND=tailnet`

如果你想要旧的广泛私有网络行为，请使用：

```sh
pnpm dev --bind lan
```

传统别名仍然映射到 `authenticated/private + bind=lan`：

```sh
pnpm dev --authenticated-private
pnpm dev --tailscale-auth
```

## 2. 查找可访问的 Tailscale 地址

从运行 Paperclip 的机器：

```sh
tailscale ip -4
```

你也可以使用你的 Tailscale MagicDNS 主机名（例如 `my-macbook.tailnet.ts.net`）。

## 3. 从另一台设备打开 Paperclip

使用 Tailscale IP 或 MagicDNS 主机名和 Paperclip 端口：

```txt
http://<tailscale-host-or-ip>:3100
```

示例：

```txt
http://my-macbook.tailnet.ts.net:3100
```

## 4. 需要时允许自定义私有主机名

如果你使用自定义私有主机名访问 Paperclip，请将其添加到允许列表：

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. 验证服务器是否可访问

从远程 Tailscale 连接的设备：

```sh
curl http://<tailscale-host-or-ip>:3100/api/health
```

预期结果：

```json
{"status":"ok"}
```

## 故障排除

- 私有主机名上的登录或重定向错误：使用 `paperclipai allowed-hostname` 添加它。
- 应用程序仅在 `localhost` 上工作：确保你使用 `--bind lan` 或 `--bind tailnet` 启动，而不是普通的 `pnpm dev`。
- 可以本地连接但不能远程连接：验证两台设备都在同一个 Tailscale 网络上，并且端口 `3100` 可访问。