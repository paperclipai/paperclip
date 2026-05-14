# 在 Docker 中运行 OpenClaw（本地开发）

如何在 Docker 容器中运行 OpenClaw 以进行本地开发和测试 Paperclip OpenClaw 适配器集成。

## 自动加入冒烟测试（推荐首先）

Paperclip 包含一个端到端加入冒烟工具：

```bash
pnpm smoke:openclaw-join
```

该工具自动化：

- 邀请创建（`allowedJoinTypes=agent`）
- OpenClaw 智能体加入请求（`adapterType=openclaw`）
- 董事会批准
- 一次性 API 密钥认领（包括无效/重放认领检查）
- 唤醒回调传递到 Docker 化的 OpenClaw 样式 Webhook 接收器

默认情况下，这使用预配置的 Docker 接收器映像（`docker/openclaw-smoke`），因此运行是确定性的，无需手动 OpenClaw 配置编辑。

权限说明：

- 该工具执行董事会治理的操作（邀请创建、加入批准、新智能体的唤醒）。
- 在认证模式下，提供董事会/操作员身份验证，否则运行会提前退出并显示明确的权限错误。

## 单命令 OpenClaw 网关 UI（手动 Docker 流程）

在一个命令中启动 Docker 中的 OpenClaw 并打印主机浏览器仪表板 URL：

```bash
pnpm smoke:openclaw-docker-ui
```

默认行为是零标志：你可以按原样运行命令，无需配对相关的环境变量。

此命令的作用：

- 克隆/更新 `/tmp/openclaw-docker` 中的 `openclaw/openclaw`
- 构建 `openclaw:local`（除非 `OPENCLAW_BUILD=0`）
- 在 `~/.openclaw-paperclip-smoke/openclaw.json` 和 Docker `.env` 下写入隔离的冒烟配置
- 将智能体模型默认值固定为 OpenAI（`openai/gpt-5.2`，带 OpenAI 后备）
- 通过 Compose 启动 `openclaw-gateway`（需要 `/tmp` tmpfs 覆盖）
- 探测并打印从 OpenClaw Docker 内部可访问的 Paperclip 主机 URL
- 等待运行状况并打印：
  - `http://127.0.0.1:18789/#token=...`
- 默认情况下禁用控制 UI 设备配对以实现本地冒烟人机工程学

环境旋钮：

- `OPENAI_API_KEY`（必需；从 env 或 `~/.secrets` 加载）
- `OPENCLAW_DOCKER_DIR`（默认 `/tmp/openclaw-docker`）
- `OPENCLAW_GATEWAY_PORT`（默认 `18789`）
- `OPENCLAW_GATEWAY_TOKEN`（默认随机）
- `OPENCLAW_BUILD=0` 跳过重建
- `OPENCLAW_OPEN_BROWSER=1` 在 macOS 上自动打开 URL
- `OPENCLAW_DISABLE_DEVICE_AUTH=1`（默认）禁用控制 UI 设备配对以用于本地冒烟
- `OPENCLAW_DISABLE_DEVICE_AUTH=0` 保持配对启用（然后使用 `devices` CLI 命令批准浏览器）
- `OPENCLAW_MODEL_PRIMARY`（默认 `openai/gpt-5.2`）
- `OPENCLAW_MODEL_FALLBACK`（默认 `openai/gpt-5.2-chat-latest`）
- `OPENCLAW_CONFIG_DIR`（默认 `~/.openclaw-paperclip-smoke`）
- `OPENCLAW_RESET_STATE=1`（默认）每次运行时重置冒烟智能体状态以避免陈旧的认证/会话漂移
- `PAPERCLIP_HOST_PORT`（默认 `3100`）
- `PAPERCLIP_HOST_FROM_CONTAINER`（默认 `host.docker.internal`）

### 认证模式

如果你的 Paperclip 部署是 `authenticated`，请提供身份验证上下文：

```bash
PAPERCLIP_AUTH_HEADER="Bearer <token>" pnpm smoke:openclaw-join
# 或
PAPERCLIP_COOKIE="your_session_cookie=..." pnpm smoke:openclaw-join
```

### 网络拓扑提示

- 本地同一主机冒烟：默认回调使用 `http://127.0.0.1:<port>/webhook`。
- 在 OpenClaw Docker 内部，`127.0.0.1` 指向容器本身，而不是你的主机 Paperclip 服务器。
- 对于由 Docker 中的 OpenClaw 使用的邀请/入门 URL，请使用脚本打印的 Paperclip URL（通常是 `http://host.docker.internal:3100`）。
- 如果 Paperclip 拒绝容器可见的主机并显示主机名错误，请从主机允许它：

```bash
pnpm paperclipai allowed-hostname host.docker.internal
```

然后重新启动 Paperclip 并重新运行冒烟脚本。
- Docker/远程 OpenClaw：首选可访问的主机名（Docker 主机别名、Tailscale 主机名或公共域）。
- 认证/私有模式：确保需要时主机名在允许列表中：

```bash
pnpm paperclipai allowed-hostname <host>
```

## 先决条件

- **Docker Desktop v29+**（支持 Docker 沙箱）
- **2 GB+ 可用 RAM** 用于 Docker 映像构建
- `~/.secrets` 中的 **API 密钥**（至少 `OPENAI_API_KEY`）

## 选项 A：Docker 沙箱（推荐）

Docker 沙箱提供比 Docker Compose 更好的隔离（基于 microVM）和更简单的设置。需要 Docker Desktop v29+ / Docker Sandbox v0.12+。

```bash
# 1. 克隆 OpenClaw 仓库并构建映像
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker
docker build -t openclaw:local -f Dockerfile .

# 2. 使用构建的映像创建沙箱
docker sandbox create --name openclaw -t openclaw:local shell ~/.openclaw/workspace

# 3. 允许网络访问 OpenAI API
docker sandbox network proxy openclaw \
  --allow-host api.openai.com \
  --allow-host localhost

# 4. 在沙箱内写入配置
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

# 5. 启动网关（从 ~/.secrets 传递你的 API 密钥）
source ~/.secrets
docker sandbox exec -d \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -w /app openclaw \
  node dist/index.js gateway --bind loopback --port 18789

# 6. 等待约 15 秒，然后验证
sleep 15
docker sandbox exec openclaw curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18789/
# 应打印：200

# 7. 检查状态
docker sandbox exec -e OPENAI_API_KEY="$OPENAI_API_KEY" -w /app openclaw \
  node dist/index.js status
```

### 沙箱管理

```bash
# 列出沙箱
docker sandbox ls

# 进入沙箱
docker sandbox exec -it openclaw bash

# 停止沙箱（保留状态）
docker sandbox stop openclaw

# 删除沙箱
docker sandbox rm openclaw

# 检查沙箱版本
docker sandbox version
```

## 选项 B：Docker Compose（后备）

如果 Docker Sandbox 不可用（Docker Desktop < v29），请使用此方法。

```bash
# 1. 克隆 OpenClaw 仓库
git clone https://github.com/openclaw/openclaw.git /tmp/openclaw-docker
cd /tmp/openclaw-docker

# 2. 构建 Docker 映像（首次运行约 5-10 分钟）
docker build -t openclaw:local -f Dockerfile .

# 3. 创建配置目录
mkdir -p ~/.openclaw/workspace ~/.openclaw/identity ~/.openclaw/credentials
chmod 700 ~/.openclaw ~/.openclaw/credentials

# 4. 生成网关令牌
export OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Your gateway token: $OPENCLAW_GATEWAY_TOKEN"

# 5. 创建配置文件
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

# 6. 创建 .env 文件（从 ~/.secrets 加载 API 密钥）
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

# 7. 将 tmpfs 添加到 docker-compose.yml（必需 — 参见已知问题）
# 添加到 openclaw-gateway 和 openclaw-cli 服务：
#   tmpfs:
#     - /tmp:exec,size=512M

# 8. 启动网关
docker compose up -d openclaw-gateway

# 9. 等待约 15 秒启动，然后获取仪表板 URL
sleep 15
docker compose run --rm openclaw-cli dashboard --no-open
```

仪表板 URL 将类似于：`http://127.0.0.1:18789/#token=<your-token>`

### Docker Compose 管理

```bash
cd /tmp/openclaw-docker

# 停止
docker compose down

# 再次启动（无需重建）
docker compose up -d openclaw-gateway

# 查看日志
docker compose logs -f openclaw-gateway

# 检查状态
docker compose run --rm openclaw-cli status

# 获取仪表板 URL
docker compose run --rm openclaw-cli dashboard --no-open
```

## 已知问题和修复

### 启动容器时"设备上没有剩余空间"

Docker Desktop 的虚拟磁盘可能已满。

```bash
docker system df                   # 检查使用情况
docker system prune -f             # 删除停止的容器、未使用的网络
docker image prune -f              # 删除悬空映像
```

### "无法创建后备 OpenClaw 临时目录：/tmp/openclaw-1000"（仅限 Compose）

容器无法写入 `/tmp`。为**两个**服务在 `docker-compose.yml` 中添加 `tmpfs` 挂载：

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

### 社区模板映像中的 Node 版本不匹配

一些社区构建的沙箱模板（例如 `olegselajev241/openclaw-dmr:latest`）提供 Node 20，但 OpenClaw 需要 Node >=22.12.0。改为使用我们本地构建的 `openclaw:local` 映像作为沙箱模板，其中包含 Node 22。

### 网关启动后需要约 15 秒才能响应

Node.js 网关需要时间初始化。在访问 `http://127.0.0.1:18789/` 之前等待 15 秒。

### CLAUDE_AI_SESSION_KEY 警告（仅限 Compose）

这些 Docker Compose 警告是无害的，可以忽略：
```
level=warning msg="The \"CLAUDE_AI_SESSION_KEY\" variable is not set. Defaulting to a blank string."
```

## 配置

配置文件：`~/.openclaw/openclaw.json`（JSON5 格式）

关键设置：
- `gateway.auth.token` — Web UI 和 API 的认证令牌
- `agents.defaults.model.primary` — AI 模型（使用 `openai/gpt-5.2` 或更新版本）
- `env.OPENAI_API_KEY` — 引用 `OPENAI_API_KEY` 环境变量（Compose 方法）

API 密钥存储在 `~/.secrets` 中，并通过环境变量传递到容器中。

## 参考

- [OpenClaw Docker 文档](https://docs.openclaw.ai/install/docker)
- [OpenClaw 配置参考](https://docs.openclaw.ai/gateway/configuration-reference)
- [Docker 博客：在 Docker 沙箱中安全运行 OpenClaw](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Docker 沙箱文档](https://docs.docker.com/ai/sandboxes)
- [OpenAI 模型](https://platform.openai.com/docs/models) — 当前模型：gpt-5.2、gpt-5.2-chat-latest、gpt-5.2-pro