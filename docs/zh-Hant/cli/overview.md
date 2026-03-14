---
title: CLI 概述
summary: CLI 安裝與設置
---
Paperclip CLI 處理實例設定、診斷和控制平面操作。

## 用法

```sh
pnpm paperclipai --help
```

## 全域選項

所有命令都支援：

|旗幟|描述 |
|------|-------------|
| `--data-dir <path>` |本地 Paperclip 資料根（與 `~/.paperclip` 隔離）|
| `--api-base <url>` | API 基本網址 |
| `--api-key <token>` | API 驗證令牌 |
| `--context <path>` |上下文檔案路徑 |
| `--profile <name>` |上下文設定檔名稱 |
| `--json` |輸出為 JSON |

公司範圍的命令也接受 `--company-id <id>`。

對於乾淨的本機實例，請在執行的命令上傳遞 `--data-dir`：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
```

## 上下文設定檔

儲存預設值以避免重複標誌：

```sh
# Set defaults
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <id>

# View current context
pnpm paperclipai context show

# List profiles
pnpm paperclipai context list

# Switch profile
pnpm paperclipai context use default
```

為了避免在上下文中儲存機密，請使用環境變數：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

上下文儲存在`~/.paperclip/context.json`。

## 命令類別

CLI 有兩個類別：

1. **[設定指令](/zh-Hant/cli/setup-commands)** — 實例引導、診斷、配置
2. **[控制平面指令](/zh-Hant/cli/control-plane-commands)** — 問題、智能體、批准、活動