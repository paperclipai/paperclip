# 在Docker中運行OpenClaw（本地開發）

如何在 Docker 容器中運行 OpenClaw 以進行本地開發和測試 Paperclip OpenClaw 適配器整合。

## 自動加入冒煙測試（推薦優先）

Paperclip 包含端對端連接煙霧安全帶：

```bash
pnpm smoke:openclaw-join
```

此線束可自動執行以下操作：

- 邀請創建（`allowedJoinTypes=agent`）
- OpenClaw 智能體加入請求 (`adapterType=openclaw`)
- 董事會批准
- 一次性API關鍵索賠（包括無效/重播索賠檢查）
- 喚醒回呼傳遞到 dockerized OpenClaw 風格的 webhook 接收器

預設情況下，這使用預先配置的 Docker 接收器映像 (`docker/openclaw-smoke`)，因此運行是確定性的，不需要手動 OpenClaw 配置編輯。

權限說明：

- 此線束執行董事會管理的操作（邀請創建、加入批准、喚醒新智能體）。
- 在身份驗證模式下，提供板/操作員身份驗證，否則運行會提前退出並出現明確權限錯誤。

## 一鍵 OpenClaw 閘道 UI（手動 Docker 流程）

要在 Docker 中啟動 OpenClaw 並透過一個指令列印主機瀏覽器控制台 URL：

```bash
pnpm smoke:openclaw-docker-ui
```

預設行為是零標誌：您可以按原樣執行命令，而不使用與配對相關的環境變數。

該命令的作用：

- 在 `/tmp/openclaw-docker` 中克隆/更新 `openclaw/openclaw`
- 建構`openclaw:local`（除非`OPENCLAW_BUILD=0`）
- 在`~/.openclaw-paperclip-smoke/openclaw.json`和Docker `.env`下寫入隔離煙配置
- 腳位智能體機型預設為 OpenAI（`openai/gpt-5.2` 與 OpenAI 後備）
- 透過 Compose 啟動 `openclaw-gateway`（需要 `/tmp` tmpfs 覆蓋）
- 偵測並列印可從 OpenClaw Docker 內部存取的 Paperclip 主機 URL
- 等待健康並列印：
  - `http://127.0.0.1:18789/#token=...`
- 預設情況下停用控制 UI 裝置配對以實現本地煙霧人體工學

環境旋鈕：

- `OPENAI_API_KEY`（必需；從 env 或 `~/.secrets` 載入）
- `OPENCLAW_DOCKER_DIR`（預設`/tmp/openclaw-docker`）
- `OPENCLAW_GATEWAY_PORT`（預設`18789`）
- `OPENCLAW_GATEWAY_TOKEN`（預設為隨機）
- `OPENCLAW_BUILD=0` 跳過重建
- `OPENCLAW_OPEN_BROWSER=1` 在 macOS 上自動開啟 URL
- `OPENCLAW_DISABLE_DEVICE_AUTH=1`（預設）停用本地煙霧的控制 UI 裝置配對
- `OPENCLAW_DISABLE_DEVICE_AUTH=0` 保持配對啟用狀態（然後使用 `devices` CLI 指令核准瀏覽器）
- `OPENCLAW_MODEL_PRIMARY`（預設`openai/gpt-5.2`）
- `OPENCLAW_MODEL_FALLBACK`（預設`openai/gpt-5.2-chat-latest`）
- `OPENCLAW_CONFIG_DIR`（預設`~/.openclaw-paperclip-smoke`）
- `OPENCLAW_RESET_STATE=1`（預設）在每次運行時重置煙霧智能體狀態，以避免過時的身份驗證/會話漂移
- `PAPERCLIP_HOST_PORT`（預設`3100`）
- `PAPERCLIP_HOST_FROM_CONTAINER`（預設`host.docker.internal`）

### 認證模式

如果您的 Paperclip 部署是 `authenticated`，請提供身分驗證情境：

```bash
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
# or
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

### 網路拓撲提示- 本機同主機煙霧：預設回呼使用`http://127.0.0.1:<port>/webhook`。
- 在 OpenClaw Docker 內部，`127.0.0.1` 指向容器本身，而不是您的主機 Paperclip 伺服器。
- 對於 Docker 中的 OpenClaw 使用的邀請/加入 URL，請使用腳本列印的 Paperclip URL（通常為 `http://host.docker.internal:3100`）。
- 如果 Paperclip 由於主機名稱錯誤而拒絕容器可見主機，請從主機允許它：

```bash
pnpm paperclipai allowed-hostname host.docker.internal
```

然後重新啟動 Paperclip 並重新執行煙霧腳本。
- Docker/遠端 OpenClaw：偏好可存取的主機名稱（Docker 主機別名、Tailscale 主機名稱或公共網域）。
- 驗證/私有模式：確保需要時主機名稱位於允許清單中：

```bash
pnpm paperclipai allowed-hostname <host>
```

## 前置條件

- **Docker 桌面版 v29+** （支援 Docker 沙箱）
- **2 GB+ RAM** 可用於 Docker 映像構建
- `~/.secrets` 中的 **API 鍵**（至少為 `OPENAI_API_KEY`）

## 選項A：Docker 沙箱（建議）

Docker Sandbox 比 Docker Compose 提供更好的隔離（基於 microVM）和更簡單的設定。需使用 Docker 桌上型版 v29+ / Docker 沙箱 v0.12+。

```bash
# 1. Clone the OpenClaw repo and build the image
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker
docker build -t openclaw:local -f Dockerfile .

# 2. Create the sandbox using the built image
docker sandbox create --name openclaw -t openclaw:local shell ~/.openclaw/workspace

# 3. Allow network access to OpenAI API
docker sandbox network proxy openclaw \
  --allow-host api.openai.com \
  --allow-host localhost

# 4. Write the config inside the sandbox
docker sandbox exec openclaw sh -c '
mkdir -p /home/node/.openclaw/workspace /home/node/.openclaw/identity /home/node/.openclaw/credentials
cat > /home/node/.openclaw/openclaw.json << INNEREOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "sandbox-dev-token-12345"
    },
    "controlUi": { "enabled": true }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
INNEREOF
chmod 600 /home/node/.openclaw/openclaw.json
'

# 5. Start the gateway (pass your API key from ~/.secrets)
source ~/.secrets
docker sandbox exec -d \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -w /app openclaw \
  node dist/index.js gateway --bind loopback --port 18789

# 6. Wait ~15 seconds, then verify
sleep 15
docker sandbox exec openclaw curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# Should print: 200

# 7. Check status
docker sandbox exec -e OPENAI_API_KEY="$OPENAI_API_KEY" -w /app openclaw \
  node dist/index.js status
```

### 沙箱管理

```bash
# List sandboxes
docker sandbox ls

# Shell into the sandbox
docker sandbox exec -it openclaw bash

# Stop the sandbox (preserves state)
docker sandbox stop openclaw

# Remove the sandbox
docker sandbox rm openclaw

# Check sandbox version
docker sandbox version
```

## 選項 B：Docker 撰寫（後備）

如果 Docker 沙盒不可用（Docker 桌面 < v29），請使用此選項。

```bash
# 1. Clone the OpenClaw repo
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker

# 2. Build the Docker image (~5-10 min on first run)
docker build -t openclaw:local -f Dockerfile .

# 3. Create config directories
mkdir -p ~/.openclaw/workspace ~/.openclaw/identity ~/.openclaw/credentials
chmod 700 ~/.openclaw ~/.openclaw/credentials

# 4. Generate a gateway token
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $OPENCLAW_GATEWAY_TOKEN"

# 5. Create the config file
cat > ~/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "$OPENCLAW_GATEWAY_TOKEN"
    },
    "controlUi": {
      "enabled": true,
      "allowedOrigins": ["http://127.0.0.1:18789"]
    }
  },
  "env": {
    "OPENAI_API_KEY": "\${OPENAI_API_KEY}"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.2",
        "fallbacks": ["openai/gpt-5.2-chat-latest"]
      },
      "workspace": "/home/node/.openclaw/workspace"
    }
  }
}
EOF
chmod 600 ~/.openclaw/openclaw.json

# 6. Create the .env file (load API keys from ~/.secrets)
source ~/.secrets
cat > .env << EOF
OPENCLAW_CONFIG_DIR=$HOME/.openclaw
OPENCLAW_WORKSPACE_DIR=$HOME/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN
OPENCLAW_IMAGE=openclaw:local
OPENAI_API_KEY=$OPENAI_API_KEY
OPENCLAW_EXTRA_MOUNTS=
OPENCLAW_HOME_VOLUME=
OPENCLAW_DOCKER_APT_PACKAGES=
EOF

# 7. Add tmpfs to docker-compose.yml (required — see Known Issues)
# Add to BOTH openclaw-gateway and openclaw-cli services:
#   tmpfs:
#     - /tmp:exec,size=512M

# 8. Start the gateway
docker compose up -d openclaw-gateway

# 9. Wait ~15 seconds for startup, then get the dashboard URL
sleep 15
docker compose run --rm openclaw-cli dashboard --no-open
```

控制台 URL 將如下所示：`http://127.0.0.1:18789/#token=<your-token>`

### Docker 撰寫管理

```bash
cd /tmp/openclaw-docker

# Stop
docker compose down

# Start again (no rebuild needed)
docker compose up -d openclaw-gateway

# View logs
docker compose logs -f openclaw-gateway

# Check status
docker compose run --rm openclaw-cli status

# Get dashboard URL
docker compose run --rm openclaw-cli dashboard --no-open
```

## 已知問題和修復

### 啟動容器時“設備上沒有剩餘空間”

Docker 桌面的虛擬磁碟可能已滿。

```bash
docker system df                   # check usage
docker system prune -f             # remove stopped containers, unused networks
docker image prune -f              # remove dangling images
```

### “無法建立後備 OpenClaw 暫存目錄：/tmp/openclaw-1000”（僅限 Compose）

容器無法寫入 `/tmp`。將 `tmpfs` 掛載新增至 `docker-compose.yml` 以用於**兩項**服務：

```yaml
services:
  openclaw-gateway:
    tmpfs:
      - /tmp:exec,size=512M
  openclaw-cli:
    tmpfs:
      - /tmp:exec,size=512M
```

此問題不影響 Docker 沙箱方法。

### 社群範本映像中的節點版本不匹配

一些社群建構的沙箱模板（例如 `olegselajev241/openclaw-dmr:latest`）附帶 Node 20，但 OpenClaw 需要 Node >=22.12.0。請使用我們本地建置的 `openclaw:local` 映像作為沙箱模板，其中包括 Node 22。

### 網關啟動後大約需要 15 秒才能回應

Node.js 閘道需要時間來初始化。等待 15 秒，然後再點選 `http://127.0.0.1:18789/`。

### CLAUDE_AI_SESSION_KEY 警告（僅限 Compose）

這些 Docker Compose 警告是無害的，可以忽略：
```
level=warning msg="The \"CLAUDE_AI_SESSION_KEY\" variable is not set. Defaulting to a blank string."
```

## 配置

設定檔：`~/.openclaw/openclaw.json`（JSON5格式）

按鍵設定：
- `gateway.auth.token` — Web UI 和 API 的身份驗證令牌
- `agents.defaults.model.primary` — AI 模型（使用 `openai/gpt-5.2` 或更新版本）
- `env.OPENAI_API_KEY` — 引用 `OPENAI_API_KEY` 環境變數（Compose 方法）API 金鑰儲存在 `~/.secrets` 中並透過環境變數傳遞到容器中。

## 參考

- [OpenClaw Docker 文件](https://docs.openclaw.ai/install/docker)
- [OpenClaw 設定參考](https://docs.openclaw.ai/gateway/configuration-reference)
- [Docker 部落格：在 Docker 沙箱中安全運行 OpenClaw](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Docker 沙箱文件](https://docs.docker.com/ai/sandboxes)
- [OpenAI 型號](https://platform.openai.com/docs/models) — 目前型號：gpt-5.2、gpt-5.2-chat-latest、gpt-5.2-pro