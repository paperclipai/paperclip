---
title: Tailscale 私人访问
summary: 通过 Tailscale 友好的主机绑定运行 Paperclip 并从其他设备连接
---
当您想通过 Tailscale（或专用 LAN/VPN）而不是仅通过 `localhost` 访问 Paperclip 时，请使用此选项。

## 1.以私密认证模式启动Paperclip

```sh
pnpm dev --tailscale-auth
```

这配置：

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_AUTH_BASE_URL_MODE=auto`
- `HOST=0.0.0.0`（在所有接口上绑定）

等效标志：

```sh
pnpm dev --authenticated-private
```

## 2.找到您可到达的Tailscale地址

从运行 Paperclip 的机器：

```sh
tailscale ip -4
```

您还可以使用 Tailscale MagicDNS 主机名（例如 `my-macbook.tailnet.ts.net`）。

## 3.从其他设备打开Paperclip

使用 Tailscale IP 或 MagicDNS 主机以及 Paperclip 端口：

```txt
http://<tailscale-host-or-ip>:3100
```

示例：

```txt
http://my-macbook.tailnet.ts.net:3100
```

## 4. 需要时允许自定义私有主机名

如果您使用自定义私有主机名访问 Paperclip，请将其添加到白名单中：

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. 验证服务器是否可达

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
- 应用程序仅适用于`localhost`：确保您从`--tailscale-auth`开始（或在私人模式下设置`HOST=0.0.0.0`）。
- 可以本地连接，但不能远程连接：验证两个设备是否位于同一 Tailscale 网络上，并且端口 `3100` 是否可达。