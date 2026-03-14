---
title: Tailscale 私人訪問
summary: 透過 Tailscale 友善的主機綁定運行 Paperclip 並從其他裝置連接
---
當您想要透過 Tailscale（或專用 LAN/VPN）而不是僅透過 `localhost` 存取 Paperclip 時，請使用此選項。

## 1.以私密認證模式啟動Paperclip

```sh
pnpm dev --tailscale-auth
```

這配置：

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_AUTH_BASE_URL_MODE=auto`
- `HOST=0.0.0.0`（在所有介面上綁定）

等效標誌：

```sh
pnpm dev --authenticated-private
```

## 2.找到您可到達的Tailscale位址

從運行 Paperclip 的機器：

```sh
tailscale ip -4
```

您也可以使用 Tailscale MagicDNS 主機名稱（例如 `my-macbook.tailnet.ts.net`）。

## 3.從其他裝置開啟Paperclip

使用 Tailscale IP 或 MagicDNS 主機以及 Paperclip 連接埠：

```txt
http://<tailscale-host-or-ip>:3100
```

範例：

```txt
http://my-macbook.tailnet.ts.net:3100
```

## 4. 需要時允許自訂私有主機名

如果您使用自訂私有主機名稱存取 Paperclip，請將其新增至白名單：

```sh
pnpm paperclipai allowed-hostname my-macbook.tailnet.ts.net
```

## 5. 驗證伺服器是否可達

從遠端 Tailscale 連接的設備：

```sh
curl http://<tailscale-host-or-ip>:3100/api/health
```

預期結果：

```json
{"status":"ok"}
```

## 故障排除

- 私有主機名稱上的登入或重新導向錯誤：使用 `paperclipai allowed-hostname` 新增它。
- 應用程式僅適用於`localhost`：確保您從`--tailscale-auth`開始（或在私人模式下設定`HOST=0.0.0.0`）。
- 可以本地連接，但不能遠端連接：驗證兩個設備是否位於同一 Tailscale 網路上，並且連接埠 `3100` 是否可達。