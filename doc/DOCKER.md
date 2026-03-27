# Docker 快速入门

在 Docker 中运行 Paperclip，无需在本地安装 Node 或 pnpm。

## 一行命令（构建 + 运行）

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

打开：`http://localhost:3100`

数据持久化：

- 内嵌 PostgreSQL 数据
- 已上传的资源
- 本地密钥
- 本地代理工作区数据

所有数据都持久化在你的绑定挂载目录下（上面示例中的 `./data/docker-paperclip`）。

## Compose 快速入门

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

默认值：

- 主机端口：`3100`
- 持久化数据目录：`./data/docker-paperclip`

可选覆盖：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc docker compose -f docker-compose.quickstart.yml up --build
```

如果你更改了主机端口或使用非本地域名，请将 `PAPERCLIP_PUBLIC_URL` 设置为你将在浏览器/认证流程中使用的外部 URL。

## 认证模式 Compose（单一公共 URL）

对于认证部署，设置一个规范的公共 URL，让 Paperclip 自动推导认证/回调默认值：

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` 被用作以下内容的主要来源：

- 认证公共基础 URL
- Better Auth 基础 URL 默认值
- 引导邀请 URL 默认值
- 主机名允许列表默认值（从 URL 中提取主机名）

如果需要，仍可使用细粒度覆盖（`PAPERCLIP_AUTH_PUBLIC_BASE_URL`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`PAPERCLIP_ALLOWED_HOSTNAMES`）。

仅当你需要公共 URL 主机之外的额外主机名时（例如 Tailscale/LAN 别名或多个私有主机名），才需要显式设置 `PAPERCLIP_ALLOWED_HOSTNAMES`。

## Docker 中的 Claude 和 Codex 本地适配器

镜像预装了：

- `claude`（Anthropic Claude Code CLI）
- `codex`（OpenAI Codex CLI）

如果你想在容器内运行本地适配器，启动容器时传入 API 密钥：

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

注意：

- 不提供 API 密钥，应用仍然可以正常运行。
- Paperclip 中的适配器环境检查会提示缺少的认证/CLI 前置条件。

## 不可信 PR 审查容器

如果你想要一个独立的 Docker 环境，使用 `codex` 或 `claude` 审查不可信的拉取请求，请使用 `doc/UNTRUSTED-PR-REVIEW.md` 中的专用审查工作流。

该设置将 CLI 认证状态保存在 Docker 卷中，而非你的主机 home 目录，并使用独立的临时工作区进行 PR 检出和预览运行。

## 入门冒烟测试（Ubuntu + npm 环境）

当你想模拟一台只有 Ubuntu + npm 的全新机器并验证以下内容时使用：

- `npx paperclipai onboard --yes` 能顺利完成
- 服务器绑定到 `0.0.0.0:3100`，使主机可以访问
- 入门/运行横幅和启动日志在终端中可见

构建 + 运行：

```sh
./scripts/docker-onboard-smoke.sh
```

打开：`http://localhost:3131`（默认冒烟测试主机端口）

有用的覆盖参数：

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
SMOKE_DETACH=true SMOKE_METADATA_FILE=/tmp/paperclip-smoke.env PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

注意：

- 持久化数据默认挂载在 `./data/docker-onboard-smoke`。
- 容器运行时用户 ID 默认使用你本地的 `id -u`，这样挂载的数据目录保持可写，同时避免以 root 身份运行。
- 冒烟测试脚本默认使用 `authenticated/private` 模式，这样 `HOST=0.0.0.0` 可以暴露给主机。
- 冒烟测试脚本默认主机端口为 `3131`，以避免与本地 Paperclip 的 `3100` 端口冲突。
- 冒烟测试脚本还默认将 `PAPERCLIP_PUBLIC_URL` 设置为 `http://localhost:<HOST_PORT>`，这样引导邀请 URL 和认证回调使用可达的主机端口，而非容器内部的 `3100`。
- 在认证模式下，冒烟测试脚本默认设置 `SMOKE_AUTO_BOOTSTRAP=true`，并自动执行真实的引导流程：注册一个真实用户，在容器内运行 `paperclipai auth bootstrap-ceo` 生成真实的引导邀请，通过 HTTP 接受该邀请，并验证董事会会话访问。
- 在前台运行脚本以观察入门流程；验证后按 `Ctrl+C` 停止。
- 设置 `SMOKE_DETACH=true` 以保持容器运行用于自动化，并可选将 shell 可读的元数据写入 `SMOKE_METADATA_FILE`。
- 镜像定义在 `Dockerfile.onboard-smoke` 中。
