---
title: 設定命令
summary: 載入、運作、檢查和配置
---
實例設定和診斷命令。

## `paperclipai run`

一命令引導並啟動：

```sh
pnpm paperclipai run
```

是否：

1. 如果配置遺失則自動啟動
2. 運行 `paperclipai doctor` 並啟用修復
3. 檢查通過後啟動伺服器

選擇具體實例：

```sh
pnpm paperclipai run --instance dev
```

## `paperclipai onboard`

互動式首次設定：

```sh
pnpm paperclipai onboard
```

第一個提示：

1. `Quickstart`（建議）：本地預設（嵌入式資料庫，無LLM提供者，本地磁碟存儲，預設機密）
2. `Advanced setup`：全互動配置

入職後立即開始：

```sh
pnpm paperclipai onboard --run
```

非互動式預設值+立即啟動（在伺服器監聽上開啟瀏覽器）：

```sh
pnpm paperclipai onboard --yes
```

## `paperclipai doctor`

具有可選自動修復功能的健康檢查：

```sh
pnpm paperclipai doctor
pnpm paperclipai doctor --repair
```

驗證：

- 伺服器配置
- 資料庫連接
- 秘密適配器配置
- 儲存配置
- 缺少關鍵文件

## `paperclipai configure`

更新配置部分：

```sh
pnpm paperclipai configure --section server
pnpm paperclipai configure --section secrets
pnpm paperclipai configure --section storage
```

## `paperclipai env`

顯示已解決的環境配置：

```sh
pnpm paperclipai env
```

## `paperclipai allowed-hostname`

允許使用私有主機名稱進行身份驗證/私有模式：

```sh
pnpm paperclipai allowed-hostname my-tailscale-host
```

## 本機儲存路徑

|資料|預設路徑|
|------|-------------|
|配置 | `~/.paperclip/instances/default/config.json` |
|資料庫| `~/.paperclip/instances/default/db` |
|日誌| `~/.paperclip/instances/default/logs` |
|儲存| `~/.paperclip/instances/default/data/storage` |
|秘密鑰匙| `~/.paperclip/instances/default/secrets/master.key` |

覆蓋：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

或直接在任何指令上傳遞 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai doctor --data-dir ./tmp/paperclip-dev
```