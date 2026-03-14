# Docker 快速入門

在Docker中執行Paperclip，本地無需安裝Node或pnpm。

## 一行（建置 + 運行）

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

開放：`http://localhost:3100`

資料持久化：

- 嵌入PostgreSQL數據
- 上傳的資產
- 本機秘密金鑰
- 本地智能體工作區數據

所有內容都保留在您的綁定掛載下（上例中的 `./data/docker-paperclip`）。

## 撰寫快速入門

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

預設值：

- 主機連接埠：`3100`
- 持久性資料目錄：`./data/docker-paperclip`

可選覆蓋：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc docker compose -f docker-compose.quickstart.yml up --build
```

如果您變更主機連接埠或使用非本機網域，請將 `PAPERCLIP_PUBLIC_URL` 設定為您將在瀏覽器/驗證流程中使用的外部 URL。

## 經過身份驗證的 Compose（單一公用 URL）

對於經過驗證的部署，設定一個規範公共 URL 並讓 Paperclip 衍生驗證/回調預設值：

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` 作為主要來源：

- 授權公用基礎 URL
- 更好的身份驗證基本 URL 預設值
- 開機邀請 URL 預設值
- 主機名稱白名單預設值（從 URL 中提取的主機名稱）

如有需要，粒徑覆蓋仍然可用（`PAPERCLIP_AUTH_PUBLIC_BASE_URL`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`PAPERCLIP_ALLOWED_HOSTNAMES`）。

只有當您需要公用 URL 主機以外的其他主機名稱（例如 Tailscale/LAN 別名或多個私有主機名稱）時，才明確設定 `PAPERCLIP_ALLOWED_HOSTNAMES`。

## Claude + Codex Docker 中的本機轉接器

映像預安裝：

- `claude`（人類Claude Code CLI）
- `codex` (OpenAI Codex CLI)

如果您希望本機轉接器在容器內執行，請在啟動容器時傳遞 API 鍵：

```sh
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e OPENAI_API_KEY=... \
  -e ANTHROPIC_API_KEY=... \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

注意事項：

- 沒有API鍵，應用程式仍然正常運作。
- Paperclip 中的適配器環境檢查將顯示缺少 auth/CLI 前置條件。

## 板載冒煙測試（僅限 Ubuntu + npm）

當您想要模仿僅具有 Ubuntu + npm 的新機器並驗證時，請使用此選項：

- `npx paperclipai onboard --yes` 完成
- 伺服器綁定到 `0.0.0.0:3100`，以便主機存取正常
- 板載/運行橫幅和啟動日誌在您的終端中可見

建置+運行：

```sh
./scripts/docker-onboard-smoke.sh
```

開啟：`http://localhost:3131`（預設smoke主機連接埠）

有用的覆蓋：

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
```

注意事項：- 持久性資料預設掛載在`./data/docker-onboard-smoke`。
- 容器執行時間使用者 ID 預設為本機 `id -u`，因此掛載的資料目錄保持可寫，同時避免 root 執行時間。
- Smoke 腳本預設為 `authenticated/private` 模式，因此 `HOST=0.0.0.0` 可以暴露給主機。
- Smoke 腳本預設主機連接埠為 `3131`，以避免與 `3100` 上的本機 Paperclip 發生衝突。
- Smoke 腳本還將 `PAPERCLIP_PUBLIC_URL` 預設為 `http://localhost:<HOST_PORT>`，因此引導邀請 URL 和身份驗證回調使用可訪問的主機端口，而不是容器的內部 `3100`。
- 在身份驗證模式下，smoke 腳本預設為 `SMOKE_AUTO_BOOTSTRAP=true` 並自動驅動真實的引導路徑：它註冊真實用戶，在容器內運行 `paperclipai auth bootstrap-ceo` 以創建真實的引導邀請，通過 HTTP 接受該邀請，並驗證董事會會話訪問。
- 在前台執行腳本以觀察引導流程；驗證後以 `Ctrl+C` 停止。
- 影像定義在`Dockerfile.onboard-smoke`中。