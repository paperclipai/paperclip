# 在Docker中运行OpenClaw（本地开发）

如何在 Docker 容器中运行 OpenClaw 以进行本地开发和测试 Paperclip OpenClaw 适配器集成。

## 自动加入冒烟测试（推荐优先）

Paperclip 包括端到端连接烟雾安全带：

```bash
pnpm smoke:openclaw-join
```

该线束可自动执行以下操作：

- 邀请创建（`allowedJoinTypes=agent`）
- OpenClaw 智能体加入请求 (`adapterType=openclaw`)
- 董事会批准
- 一次性API关键索赔（包括无效/重放索赔检查）
- 唤醒回调传递到 dockerized OpenClaw 风格的 webhook 接收器

默认情况下，这使用预配置的 Docker 接收器映像 (`docker/openclaw-smoke`)，因此运行是确定性的，不需要手动 OpenClaw 配置编辑。

权限说明：

- 该线束执行董事会管理的操作（邀请创建、加入批准、唤醒新智能体）。
- 在身份验证模式下，提供板/操作员身份验证，否则运行会提前退出并出现显式权限错误。

## 一键 OpenClaw 网关 UI（手动 Docker 流程）

要在 Docker 中启动 OpenClaw 并通过一个命令打印主机浏览器控制台 URL：

```bash
pnpm smoke:openclaw-docker-ui
```

默认行为是零标志：您可以按原样运行命令，而不使用与配对相关的环境变量。

该命令的作用：

- 在 `/tmp/openclaw-docker` 中克隆/更新 `openclaw/openclaw`
- 构建`openclaw:local`（除非`OPENCLAW_BUILD=0`）
- 在`~/.openclaw-paperclip-smoke/openclaw.json`和Docker `.env`下写入隔离烟雾配置
- 引脚智能体模型默认为 OpenAI（`openai/gpt-5.2` 与 OpenAI 后备）
- 通过 Compose 启动 `openclaw-gateway`（需要 `/tmp` tmpfs 覆盖）
- 探测并打印可从 OpenClaw Docker 内部访问的 Paperclip 主机 URL
- 等待健康并打印：
  - `http://127.0.0.1:18789/#token=...`
- 默认情况下禁用控制 UI 设备配对以实现本地烟雾人体工程学

环境旋钮：

- `OPENAI_API_KEY`（必需；从 env 或 `~/.secrets` 加载）
- `OPENCLAW_DOCKER_DIR`（默认`/tmp/openclaw-docker`）
- `OPENCLAW_GATEWAY_PORT`（默认`18789`）
- `OPENCLAW_GATEWAY_TOKEN`（默认随机）
- `OPENCLAW_BUILD=0` 跳过重建
- `OPENCLAW_OPEN_BROWSER=1` 在 macOS 上自动打开 URL
- `OPENCLAW_DISABLE_DEVICE_AUTH=1`（默认）禁用本地烟雾的控制 UI 设备配对
- `OPENCLAW_DISABLE_DEVICE_AUTH=0` 保持配对启用状态（然后使用 `devices` CLI 命令批准浏览器）
- `OPENCLAW_MODEL_PRIMARY`（默认`openai/gpt-5.2`）
- `OPENCLAW_MODEL_FALLBACK`（默认`openai/gpt-5.2-chat-latest`）
- `OPENCLAW_CONFIG_DIR`（默认`~/.openclaw-paperclip-smoke`）
- `OPENCLAW_RESET_STATE=1`（默认）在每次运行时重置烟雾智能体状态，以避免过时的身份验证/会话漂移
- `PAPERCLIP_HOST_PORT`（默认`3100`）
- `PAPERCLIP_HOST_FROM_CONTAINER`（默认`host.docker.internal`）

### 认证模式

如果您的 Paperclip 部署是 `authenticated`，请提供身份验证上下文：

```bash
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
# or
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

### 网络拓扑提示- 本地同主机烟雾：默认回调使用`http://127.0.0.1:<port>/webhook`。
- 在 OpenClaw Docker 内部，`127.0.0.1` 指向容器本身，而不是您的主机 Paperclip 服务器。
- 对于 Docker 中的 OpenClaw 使用的邀请/加入 URL，请使用脚本打印的 Paperclip URL（通常为 `http://host.docker.internal:3100`）。
- 如果 Paperclip 由于主机名错误而拒绝容器可见主机，请从主机允许它：

```bash
pnpm paperclipai allowed-hostname host.docker.internal
```

然后重新启动 Paperclip 并重新运行烟雾脚本。
- Docker/远程 OpenClaw：更喜欢可访问的主机名（Docker 主机别名、Tailscale 主机名或公共域）。
- 身份验证/私有模式：确保需要时主机名位于允许列表中：

```bash
pnpm paperclipai allowed-hostname <host>
```

## 前置条件

- **Docker 桌面版 v29+** （支持 Docker 沙箱）
- **2 GB+ RAM** 可用于 Docker 映像构建
- `~/.secrets` 中的 **API 键**（至少为 `OPENAI_API_KEY`）

## 选项A：Docker 沙箱（推荐）

Docker Sandbox 比 Docker Compose 提供更好的隔离（基于 microVM）和更简单的设置。需要 Docker 桌面版 v29+ / Docker 沙箱 v0.12+。

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

## 选项 B：Docker 撰写（后备）

如果 Docker 沙盒不可用（Docker 桌面 < v29），请使用此选项。

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

控制台 URL 将如下所示：`http://127.0.0.1:18789/#token=<your-token>`

### Docker 撰写管理

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

## 已知问题和修复

### 启动容器时“设备上没有剩余空间”

Docker 桌面的虚拟磁盘可能已满。

```bash
docker system df                   # check usage
docker system prune -f             # remove stopped containers, unused networks
docker image prune -f              # remove dangling images
```

### “无法创建后备 OpenClaw 临时目录：/tmp/openclaw-1000”（仅限 Compose）

容器无法写入 `/tmp`。将 `tmpfs` 挂载添加到 `docker-compose.yml` 以用于**两项**服务：

```yaml
services:
  openclaw-gateway:
    tmpfs:
      - /tmp:exec,size=512M
  openclaw-cli:
    tmpfs:
      - /tmp:exec,size=512M
```

此问题不影响 Docker 沙箱方法。

### 社区模板镜像中的节点版本不匹配

一些社区构建的沙箱模板（例如 `olegselajev241/openclaw-dmr:latest`）附带 Node 20，但 OpenClaw 需要 Node >=22.12.0。请使用我们本地构建的 `openclaw:local` 映像作为沙箱模板，其中包括 Node 22。

### 网关启动后大约需要 15 秒才能响应

Node.js 网关需要时间来初始化。等待 15 秒，然后再点击 `http://127.0.0.1:18789/`。

### CLAUDE_AI_SESSION_KEY 警告（仅限 Compose）

这些 Docker Compose 警告是无害的，可以忽略：
```
level=warning msg="The \"CLAUDE_AI_SESSION_KEY\" variable is not set. Defaulting to a blank string."
```

## 配置

配置文件：`~/.openclaw/openclaw.json`（JSON5格式）

按键设置：
- `gateway.auth.token` — Web UI 和 API 的身份验证令牌
- `agents.defaults.model.primary` — AI 模型（使用 `openai/gpt-5.2` 或更新版本）
- `env.OPENAI_API_KEY` — 引用 `OPENAI_API_KEY` 环境变量（Compose 方法）API 密钥存储在 `~/.secrets` 中并通过环境变量传递到容器中。

## 参考

- [OpenClaw Docker 文档](https://docs.openclaw.ai/install/docker)
- [OpenClaw 配置参考](https://docs.openclaw.ai/gateway/configuration-reference)
- [Docker 博客：在 Docker 沙箱中安全运行 OpenClaw](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Docker 沙箱文档](https://docs.docker.com/ai/sandboxes)
- [OpenAI 型号](https://platform.openai.com/docs/models) — 当前型号：gpt-5.2、gpt-5.2-chat-latest、gpt-5.2-pro