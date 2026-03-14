---
title: 本地開發
summary: 設定Paperclip進行本地開發
---
本地運行 Paperclip，外部依賴為零。

## 前置條件

- Node.js 20+
- pnpm 9+

## 啟動開發伺服器

```sh
pnpm install
pnpm dev
```

這開始：

- **API 伺服器** `http://localhost:3100`
- **UI** 由 API 伺服器以開發中介軟體模式提供服務（同源）

無需 Docker 或外部資料庫。 Paperclip 自動使用嵌入的 PostgreSQL。

## 單一命令引導

對於首次安裝：

```sh
pnpm paperclipai run
```

這會：

1. 如果配置遺失則自動啟動
2. 運行 `paperclipai doctor` 並啟用修復
3. 檢查通過後啟動伺服器

## Tailscale/私有授權開發模式

以`authenticated/private`模式運作進行網路存取：

```sh
pnpm dev --tailscale-auth
```

這樣就可以將伺服器綁定到`0.0.0.0`上，實現私人網路存取。

別名：

```sh
pnpm dev --authenticated-private
```

允許其他私有主機名稱：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

有關完整設定和故障排除，請參閱 [Tailscale 私人訪問](/zh-Hant/deploy/tailscale-private-access)。

## 健康檢查

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## 重置開發數據

要擦除本地資料並重新開始：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 資料位置

|資料|路徑|
|------|------|
|配置 | `~/.paperclip/instances/default/config.json` |
|資料庫| `~/.paperclip/instances/default/db` |
|儲存| `~/.paperclip/instances/default/data/storage` |
|秘密鑰匙| `~/.paperclip/instances/default/secrets/master.key` |
|日誌| `~/.paperclip/instances/default/logs` |

使用環境變數覆蓋：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```