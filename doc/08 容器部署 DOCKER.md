# Docker 快速入门

无需在本地安装 Node 或 pnpm，即可在 Docker 中运行 Paperclip。

以下所有命令均假设你在**项目根目录**（即包含 `package.json` 的目录）下执行，而非 `docker/` 目录内。

## 构建镜像（Building the image）

```sh
docker build -t paperclip-local .
```

Dockerfile 会安装常用的代理工具（`git`、`gh`、`curl`、`wget`、`ripgrep`、`python3`）以及 Claude、Codex 和 OpenCode CLI。

构建参数（Build arguments）：

| 参数 | 默认值 | 用途 |
|------|--------|------|
| `USER_UID` | `1000` | 容器内 `node` 用户的 UID（与宿主机 UID 匹配可避免绑定挂载的权限问题） |
| `USER_GID` | `1000` | 容器内 `node` 用户组的 GID |

```sh
docker build -t paperclip-local \
  --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
```

## 一键运行（构建 + 启动）

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

打开：`http://localhost:3100`

数据持久化（Data persistence）：

- 内嵌 PostgreSQL（Embedded PostgreSQL）数据
- 上传的资源文件
- 本地密钥（secrets key）
- 本地代理工作区数据

所有数据均持久化在绑定挂载目录下（上例中的 `./data/docker-paperclip`）。

## Docker Compose

### 快速启动（内嵌 SQLite）

单容器，无需外部数据库。数据通过绑定挂载（bind mount）持久化。

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

默认配置：

- 宿主机端口：`3100`
- 持久化数据目录：`./data/docker-paperclip`

可选覆盖：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

**注意：** `PAPERCLIP_DATA_DIR` 相对于 Compose 文件所在目录（`docker/`）解析，因此 `../data/pc` 对应项目根目录下的 `data/pc`。

如果更改了宿主机端口或使用非本地域名，请设置 `PAPERCLIP_PUBLIC_URL` 为浏览器/认证流程中使用的外部 URL。

传入 `OPENAI_API_KEY` 和/或 `ANTHROPIC_API_KEY` 可启用本地适配器（adapter）运行。

### 完整栈（含 PostgreSQL）

Paperclip 服务器 + PostgreSQL 17。数据库会通过健康检查（health check）后才启动服务器。

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL 数据持久化在命名 Docker 卷（named volume）`pgdata` 中。Paperclip 数据持久化在 `paperclip-data` 卷中。

### 不受信任的 PR 审查（Untrusted PR review）

用于在隔离容器中审查不受信任的 Pull Request，可使用 Codex 或 Claude 进行审查，无需暴露宿主机。完整工作流程见 `doc/UNTRUSTED-PR-REVIEW.md`。

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

## 认证 Compose 部署（单一公共 URL）

对于认证部署（authenticated deployment），设置一个规范的公共 URL，让 Paperclip 自动派生认证/回调默认值：

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` 作为以下配置的主要来源：

- 认证公共基础 URL（auth public base URL）
- Better Auth 基础 URL 默认值
- 引导邀请 URL（bootstrap invite URL）默认值
- 主机名白名单（hostname allowlist）默认值（从 URL 中提取主机名）

如需细粒度覆盖，仍可使用以下变量（`PAPERCLIP_AUTH_PUBLIC_BASE_URL`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`PAPERCLIP_ALLOWED_HOSTNAMES`）。

仅在需要超出公共 URL 主机名之外的额外主机名时（例如 Tailscale/局域网别名或多个私有主机名），才需显式设置 `PAPERCLIP_ALLOWED_HOSTNAMES`。

## Docker 中的 Claude + Codex 本地适配器

镜像预装了：

- `claude`（Anthropic Claude Code CLI）
- `codex`（OpenAI Codex CLI）

如果需要在容器内运行本地适配器，请在启动容器时传入 API 密钥：

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

说明：

- 即使不提供 API 密钥，应用仍可正常运行。
- Paperclip 中的适配器环境检查会提示缺少的认证/CLI 前置条件。

## Podman Quadlet（systemd）

`docker/quadlet/` 目录包含用于通过 Podman Quadlet 将 Paperclip + PostgreSQL 作为 systemd 服务运行的单元文件。

| 文件 | 用途 |
|------|------|
| `docker/quadlet/paperclip.pod` | Pod 定义 — 将容器组合到共享网络命名空间 |
| `docker/quadlet/paperclip.container` | Paperclip 服务器 — 加入 Pod，连接 `127.0.0.1` 上的 PostgreSQL |
| `docker/quadlet/paperclip-db.container` | PostgreSQL 17 — 加入 Pod，带健康检查 |

### 设置步骤

1. 构建镜像（参见上文）。

2. 将 Quadlet 文件复制到 systemd 目录：

   ```sh
   # 无 root 模式（推荐）
   cp docker/quadlet/*.pod docker/quadlet/*.container \
     ~/.config/containers/systemd/

   # 或 root 模式
   sudo cp docker/quadlet/*.pod docker/quadlet/*.container \
     /etc/containers/systemd/
   ```

3. 创建密钥环境文件（请勿纳入版本控制）：

   ```sh
   cat > ~/.config/containers/systemd/paperclip.env <<EOL
   BETTER_AUTH_SECRET=$(openssl rand -hex 32)
   POSTGRES_USER=paperclip
   POSTGRES_PASSWORD=paperclip
   POSTGRES_DB=paperclip
   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5432/paperclip
   # OPENAI_API_KEY=sk-...
   # ANTHROPIC_API_KEY=sk-...
   EOL
   ```

4. 创建数据目录并启动：

   ```sh
   mkdir -p ~/.local/share/paperclip
   systemctl --user daemon-reload
   systemctl --user start paperclip-pod
   ```

### Quadlet 管理

```sh
journalctl --user -u paperclip -f        # 应用日志
journalctl --user -u paperclip-db -f     # 数据库日志
systemctl --user status paperclip-pod    # Pod 状态
systemctl --user restart paperclip-pod   # 重启全部
systemctl --user stop paperclip-pod      # 停止全部
```

### Quadlet 注意事项

- **首次启动**：与 Docker Compose 的 `condition: service_healthy` 不同，Quadlet 的 `After=` 仅等待数据库单元*启动*，而非等待 PostgreSQL 就绪。在冷启动时，你可能会在 `journalctl --user -u paperclip` 中看到一两次重启尝试，这是 PostgreSQL 初始化过程中的正常现象，会通过 `Restart=on-failure` 自动恢复。
- 同一 Pod 内的容器共享 `localhost`，因此 Paperclip 通过 `127.0.0.1:5432` 连接 PostgreSQL。
- PostgreSQL 数据持久化在 `paperclip-pgdata` 命名卷中。
- Paperclip 数据持久化在 `~/.local/share/paperclip`。
- 对于 root 模式的 Quadlet 部署，请移除 `%h` 前缀并使用绝对路径。

## 入驻冒烟测试（Ubuntu + npm 环境）

当你想模拟一台仅有 Ubuntu + npm 的全新机器并验证以下内容时使用：

- `npx paperclipai onboard --yes` 能够完成
- 服务器绑定到 `0.0.0.0:3100`，宿主机可以访问
- 入驻/运行横幅和启动日志在终端中可见

构建 + 运行：

```sh
./scripts/docker-onboard-smoke.sh
```

打开：`http://localhost:3131`（默认冒烟测试宿主机端口）

常用覆盖参数：

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

说明：

- 持久化数据默认挂载在 `./data/docker-onboard-smoke`。
- 容器运行时用户 ID 默认为你本地的 `id -u`，以确保挂载的数据目录可写，同时避免以 root 运行。
- 冒烟脚本默认使用 `authenticated/private` 模式，以便将 `HOST=0.0.0.0` 暴露给宿主机。
- 冒烟脚本默认宿主机端口为 `3131`，避免与本地 `3100` 端口上的 Paperclip 冲突。
- 冒烟脚本同时将 `PAPERCLIP_PUBLIC_URL` 默认为 `http://localhost:<HOST_PORT>`，使引导邀请 URL 和认证回调使用可达的宿主机端口，而非容器内部的 `3100`。
- 在认证模式下，冒烟脚本默认 `SMOKE_AUTO_BOOTSTRAP=true`，自动执行真实的引导流程：注册真实用户、在容器内运行 `paperclipai auth bootstrap-ceo` 生成真实的引导邀请、通过 HTTP 接受该邀请，并验证董事会会话（board session）访问权限。
- 在前台运行脚本可观察入驻流程；验证完成后使用 `Ctrl+C` 停止。
- 设置 `SMOKE_DETACH=true` 可让容器持续运行以支持自动化，并可选择将 shell 可用的元数据写入 `SMOKE_METADATA_FILE`。
- 镜像定义位于 `docker/Dockerfile.onboard-smoke`。

## 通用说明

- `docker-entrypoint.sh` 会在启动时调整容器内 `node` 用户的 UID/GID，使其与通过 `USER_UID`/`USER_GID` 传入的值匹配，从而避免绑定挂载卷的权限问题。
- Paperclip 数据通过 Docker 卷/绑定挂载（Compose 模式）或 `~/.local/share/paperclip`（Quadlet 模式）持久化。
