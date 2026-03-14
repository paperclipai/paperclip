# CLI 參考

Paperclip CLI 現在支援：

- 實例設定/診斷（`onboard`、`doctor`、`configure`、`env`、`allowed-hostname`）
- 控制平面客戶端操作（問題、核准、智能體、活動、控制台）

## 基本用法

在開發中使用repo腳本：

```sh
pnpm paperclipai --help
```

首次本地引導+運行：

```sh
pnpm paperclipai run
```

選擇本地實例：

```sh
pnpm paperclipai run --instance dev
```

## 部署模式

模式分類和設計意圖記錄在 `doc/DEPLOYMENT-MODES.md` 中。

目前 CLI 行為：

- `paperclipai onboard` 和 `paperclipai configure --section server` 在設定中設定部署模式
- 運作時可以使用 `PAPERCLIP_DEPLOYMENT_MODE` 覆蓋模式
- `paperclipai run` 和 `paperclipai doctor` 尚未公開直接 `--mode` 標誌

目標行為（計劃的）記錄在 `doc/DEPLOYMENT-MODES.md` 第 5 節。

允許經過驗證的/私有主機名稱（例如自訂 Tailscale DNS）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

所有客戶端命令都支援：

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

公司範圍的命令也支援 `--company-id <id>`。

在任何 CLI 指令上使用 `--data-dir` 將所有預設本機狀態（config/context/db/logs/storage/secrets）與 `~/.paperclip` 隔離：

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## 上下文設定檔

將本地預設值儲存在 `~/.paperclip/context.json` 中：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

為了避免在上下文中儲存機密，請設定 `apiKeyEnvVarName` 並將金鑰保留在 env 中：

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## 連隊命令

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

範例：

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

注意事項：

- 刪除由 `PAPERCLIP_ENABLE_COMPANY_DELETION` 伺服器控制。
- 透過智能體身份驗證，公司刪除僅限於公司範圍。使用目前公司 ID/前綴（例如透過 `--company-id` 或 `PAPERCLIP_COMPANY_ID`），而不是其他公司。

## 發出命令

```sh
pnpm paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
```

## 智能體命令

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

`agent local-cli` 是作為 Paperclip 智能體手動運行本地 Claude/Codex 的最快方法：

- 建立一個新的長期智能體 API 金鑰
- 將缺少的 Paperclip 技能安裝到 `~/.codex/skills` 和 `~/.claude/skills` 中
- 列印 `PAPERCLIP_API_URL`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_AGENT_ID` 和 `PAPERCLIP_API_KEY` 的 `export ...` 行

基於短名稱的本機設定範例：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## 批准命令

```sh
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## 活動指令

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
```

## 控制台指令

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## 心跳命令

`heartbeat run` 現在也支援上下文/api-key 選項並使用共用客戶端堆疊：

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## 本機儲存預設值

預設本機實例根目錄為 `~/.paperclip/instances/default`：

- 設定：`~/.paperclip/instances/default/config.json`
- 嵌入式資料庫：`~/.paperclip/instances/default/db`
- 日誌：`~/.paperclip/instances/default/logs`
- 儲存：`~/.paperclip/instances/default/data/storage`
- 金鑰：`~/.paperclip/instances/default/secrets/master.key`

使用環境變數覆寫基本主目錄或實例：

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## 儲存配置

配置儲存提供者和設定：

```sh
pnpm paperclipai configure --section storage
```

支援的提供者：- `local_disk`（預設；本機單一使用者安裝）
- `s3`（S3相容的物件儲存）