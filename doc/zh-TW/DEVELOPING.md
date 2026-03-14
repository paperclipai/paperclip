# 開發中

該專案可以在本地開發中完全運行，無需手動設定 PostgreSQL。

## 部署模式

有關模式定義和預期的 CLI 行為，請參閱 `doc/DEPLOYMENT-MODES.md`。

目前實施情形：

- 規格型號：`local_trusted` 和 `authenticated`（`private/public` 曝光）

## 前置條件

- Node.js 20+
- pnpm 9+

## 依賴鎖定檔策略

GitHub 炬力擁有 `pnpm-lock.yaml`。

- 不要在拉取請求中提交 `pnpm-lock.yaml`。
- 拉取請求 CI 在清單變更時驗證依賴項解析。
- 推送到`master`，用`pnpm install --lockfile-only --no-frozen-lockfile`重新產生`pnpm-lock.yaml`，如果需要的話提交回來，然後用`--frozen-lockfile`運行驗證。

## 開始開發

從倉庫根目錄：

```sh
pnpm install
pnpm dev
```

這開始：

- API 伺服器：`http://localhost:3100`
- UI：由API伺服器以開發中間件模式提供服務（與API同源）

`pnpm dev` 在監視模式下執行伺服器，並在工作區包（包括適配器包）發生變更時重新啟動。使用`pnpm dev:once`運行，無需查看檔案。

Tailscale/private-auth 開發模式：

```sh
pnpm dev --tailscale-auth
```

這將 dev 作為 `authenticated/private` 運行，並將伺服器綁定到 `0.0.0.0` 以進行私人網路存取。

允許其他私有主機名稱（例如自訂 Tailscale 主機名稱）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## 單一命令本地運行

對於首次本機安裝，您可以在一個命令中引導並執行：

```sh
pnpm paperclipai run
```

`paperclipai run` 的作用是：

1. 如果配置遺失則自動載入
2. `paperclipai doctor` 已啟用修復
3. 檢查通過後啟動伺服器

## Docker 快速入門（無本地節點安裝）

在Docker中建置並執行Paperclip：

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

或使用撰寫：

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

有關 API 密鑰接線 (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) 和持久性詳細信息，請參閱 `doc/DOCKER.md`。

## Dev 中的資料庫（自動處理）

對於本機開發，請保留 `DATABASE_URL` 未設定。
伺服器將自動使用嵌入的 PostgreSQL 並將資料保存在：

- `~/.paperclip/instances/default/db`

覆蓋主目錄和實例：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

此模式不需要 Docker 或外部資料庫。

## Dev 中的儲存（自動處理）

對於本機開發，預設儲存提供者是 `local_disk`，它將上傳的映像/附件保存在：

- `~/.paperclip/instances/default/data/storage`

配置儲存提供者/設定：

```sh
pnpm paperclipai configure --section storage
```

## 預設智能體工作區

當本機智能體程式執行沒有已解析的專案/會話工作區時，Paperclip 會回退到實例根目錄下的智能體主工作區：

- `~/.paperclip/instances/default/workspaces/<agent-id>`

此路徑在非預設設定中遵循 `PAPERCLIP_HOME` 和 `PAPERCLIP_INSTANCE_ID`。

## 工作樹本地實例

從多個 git 工作樹進行開發時，請勿將兩台 Paperclip 伺服器指向相同嵌入式 PostgreSQL 資料目錄。相反，建立一個儲存庫本機 Paperclip 配置以及工作樹的隔離實例：

```sh
paperclipai worktree init
# or create the git worktree and initialize it in one step:
pnpm paperclipai worktree:make paperclip-pr-432
```

這個命令：

- 在 `.paperclip/config.json` 和 `.paperclip/.env` 處寫入儲存庫本機文件
- 在`~/.paperclip-worktrees/instances/<worktree-id>/`下建立一個隔離實例
- 當在連結的 git 工作樹中執行時，將有效的 git 掛鉤鏡像到該工作樹的私有 git 目錄中
- 選擇免費的應用程式連接埠和嵌入式 PostgreSQL 端口
- 預設情況下，透過邏輯 SQL 快照從主實例以 `minimal` 模式播種隔離資料庫

種子模式：

- `minimal` 保留核心應用程式狀態，如公司、專案、問題、評論、批准和身份驗證狀態，保留所有表的架構，但忽略繁重操作歷史記錄中的行數據，如心跳運行、喚醒請求、活動日誌、運行時服務和智能體會話狀態
- `full` 對來源實例進行完整邏輯克隆
- `--no-seed` 建立一個空的隔離實例

繼 `worktree init` 之後，伺服器和 CLI 在該工作樹內運行時都會自動載入儲存庫本機 `.paperclip/.env`，因此 `pnpm dev`、`paperclipai doctor` 和 FQQQQQ31QQQ4Q4QpQQQQ4QQ4QQ4QQQQ4QQ4Q)的工作樹。

該 repo-local env 還設定 `PAPERCLIP_IN_WORKTREE=true`，伺服器可以將其用於特定於工作樹的 UI 行為，例如備用圖示。

需要時明確列印 shell 導出：

```sh
paperclipai worktree env
# or:
eval "$(paperclipai worktree env)"
```

有用的選項：

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode minimal
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

對於專案執行工作樹，Paperclip 在建立或重複使用隔離的 git 工作樹後也可以執行專案定義的設定指令。在專案的執行工作區策略 (`workspaceStrategy.provisionCommand`) 上設定此項目。此指令在衍生工作樹內運作並接收 `PAPERCLIP_WORKSPACE_*`、`PAPERCLIP_PROJECT_ID`、`PAPERCLIP_AGENT_ID` 和 `PAPERCLIP_ISSUE_*` 環境變量，因此每個儲存庫都可以根據需要自行引導。

## 快速健康檢查

在另一個終端中：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

預計：

- `/api/health` 返回 `{"status":"ok"}`
- `/api/companies` 傳回 JSON 數組

## 重置本機開發資料庫

若要擦除本機開發資料並重新開始：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 可選：使用外部 Postgres

如果您設定 `DATABASE_URL`，伺服器將使用它而不是嵌入的 PostgreSQL。

## 自動資料庫備份

Paperclip 可以在計時器上執行自動資料庫備份。預設值：

- 啟用
- 每 60 分鐘一班
- 保留30天
- 備份目錄：`~/.paperclip/instances/default/data/backups`

在以下位置配置這些：

```sh
pnpm paperclipai configure --section database
```

手動執行一次性備份：

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

環境覆蓋：

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`

## 開發中的秘密

智能體環境變數現在支援秘密引用。預設情況下，秘密值使用本地加密存儲，並且只有秘密引用保留在智能體配置中。- 預設本機金鑰路徑：`~/.paperclip/instances/default/secrets/master.key`
- 直接覆蓋金鑰材料：`PAPERCLIP_SECRETS_MASTER_KEY`
- 覆蓋金鑰檔案路徑：`PAPERCLIP_SECRETS_MASTER_KEY_FILE`

嚴格模式（建議在本地可信任機器之外）：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

啟用嚴格模式時，敏感環境鍵（例如 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必須使用秘密引用而非內聯純值。

CLI 設定支援：

- `pnpm paperclipai onboard` 寫入預設的 `secrets` 設定部分（`local_encrypted`，嚴格模式關閉，金鑰檔案路徑設定）並在需要時建立本機金鑰檔案。
- `pnpm paperclipai configure --section secrets` 可讓您更新提供者/嚴格模式/金鑰路徑並在需要時建立本機金鑰檔案。
- `pnpm paperclipai doctor` 驗證機密適配器配置，並可使用 `--repair` 建立遺失的本機金鑰檔案。

現有內聯環境機密的遷移助手：

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## 公司刪除切換

公司刪除旨在作為開發/調試功能，可以在運行時停用：

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

預設行為：

- `local_trusted`：已啟用
- `authenticated`：已停用

## CLI 用戶端操作

Paperclip CLI 現在除了設定指令之外還包括客戶端控制平面指令。

簡單範例：

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

使用上下文設定檔設定預設值一次：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

然後運行命令而不重複標誌：

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

請參閱 `doc/CLI.md` 中的完整指令參考。

## OpenClaw 邀請加入端點

面向智能體的邀請加入現在公開機器可讀的 API 文件：

- `GET /api/invites/:token` 返回邀請摘要以及入門和技能索引連結。
- `GET /api/invites/:token/onboarding` 傳回加入清單詳細資料（註冊端點、宣告端點範本、技能安裝提示）。
- `GET /api/invites/:token/onboarding.txt` 傳回適用於人工操作員和智能體程式的純文字入職文件（llm.txt 樣式切換），包括可選的邀請者訊息和建議的網路主機候選者。
- `GET /api/skills/index` 列出可用的技能文件。
- `GET /api/skills/paperclip` 返回Paperclip 心跳技能降價。

## OpenClaw 加入冒煙測試

運轉端對端 OpenClaw 連接煙霧線束：

```sh
pnpm smoke:openclaw-join
```

它驗證什麼：

- 邀請建立僅智能體加入
- 使用 `adapterType=openclaw` 的智能體程式加入請求
- 董事會批准+一次性API關鍵索賠語義
- 喚醒時回呼傳遞到 Docker 化的 OpenClaw 風格的 webhook 接收器

所需權限：

- 此腳本執行董事會管理的操作（建立邀請、批准加入、喚醒另一個智能體）。
- 在驗證模式下，透過 `PAPERCLIP_AUTH_HEADER` 或 `PAPERCLIP_COOKIE` 進行板驗證運作。

可選的身份驗證標誌（用於身份驗證模式）：

- `PAPERCLIP_AUTH_HEADER`（例如`Bearer ...`）
- `PAPERCLIP_COOKIE`（會話cookie頭值）

## OpenClaw Docker UI 單一命令腳本要在 Docker 中啟動 OpenClaw 並透過一個指令列印主機瀏覽器控制台 URL：

```sh
pnpm smoke:openclaw-docker-ui
```

腳本位於 `scripts/smoke/openclaw-docker-ui.sh`，並自動複製/建置/設定/啟動基於 Compose 的本機 OpenClaw UI 測試。

此煙霧腳本的配對行為：

- 預設 `OPENCLAW_DISABLE_DEVICE_AUTH=1`（本地煙霧沒有控制 UI 配對提示；不需要額外的配對環境變數）
- 設定 `OPENCLAW_DISABLE_DEVICE_AUTH=0` 要求標準配備配對

此煙霧腳本的模型行為：

- 預設為 OpenAI 模型（`openai/gpt-5.2` + OpenAI 後備），因此預設不需要人工驗證

此煙霧腳本的狀態行為：

- 預設為獨立配置目錄 `~/.openclaw-paperclip-smoke`
- 預設每次運行時都會重置煙霧劑狀態（`OPENCLAW_RESET_STATE=1`）以避免過時的提供者/身份驗證漂移

此煙霧腳本的網路行為：

- 自動偵測並列印可從 OpenClaw Docker 內部存取的 Paperclip 主機 URL
- 預設容器端主機別名為 `host.docker.internal` （以 `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT` 覆寫）
- 如果 Paperclip 在驗證/私有模式下拒絕容器主機名，則透過 `pnpm paperclipai allowed-hostname host.docker.internal` 允許 `host.docker.internal` 並重新啟動 Paperclip