# Docker 快速入门

在Docker中运行Paperclip，本地无需安装Node或pnpm。

## 一行（构建 + 运行）

```sh
docker build -t paperclip-local . && \
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

开放：`http://localhost:3100`

数据持久化：

- 嵌入PostgreSQL数据
- 上传的资产
- 本地秘密密钥
- 本地智能体工作区数据

所有内容都保留在您的绑定挂载下（上例中的 `./data/docker-paperclip`）。

## 撰写快速入门

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

默认值：

- 主机端口：`3100`
- 持久数据目录：`./data/docker-paperclip`

可选覆盖：

```sh
PAPERCLIP_PORT=3200 PAPERCLIP_DATA_DIR=./data/pc docker compose -f docker-compose.quickstart.yml up --build
```

如果您更改主机端口或使用非本地域，请将 `PAPERCLIP_PUBLIC_URL` 设置为您将在浏览器/身份验证流程中使用的外部 URL。

## 经过身份验证的 Compose（单个公共 URL）

对于经过身份验证的部署，设置一个规范公共 URL 并让 Paperclip 派生身份验证/回调默认值：

```yaml
services:
  paperclip:
    environment:
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: https://desk.koker.net
```

`PAPERCLIP_PUBLIC_URL` 用作主要来源：

- 授权公共基础 URL
- 更好的身份验证基本 URL 默认值
- 引导邀请 URL 默认值
- 主机名白名单默认值（从 URL 中提取的主机名）

如果需要，粒度覆盖仍然可用（`PAPERCLIP_AUTH_PUBLIC_BASE_URL`、`BETTER_AUTH_URL`、`BETTER_AUTH_TRUSTED_ORIGINS`、`PAPERCLIP_ALLOWED_HOSTNAMES`）。

仅当您需要公共 URL 主机之外的其他主机名（例如 Tailscale/LAN 别名或多个私有主机名）时，才显式设置 `PAPERCLIP_ALLOWED_HOSTNAMES`。

## Claude + Codex Docker 中的本地适配器

图像预安装：

- `claude`（人类Claude Code CLI）
- `codex` (OpenAI Codex CLI)

如果您希望本地适配器在容器内运行，请在启动容器时传递 API 键：

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

注意事项：

- 没有API键，应用程序仍然正常运行。
- Paperclip 中的适配器环境检查将显示缺少 auth/CLI 前置条件。

## 板载冒烟测试（仅限 Ubuntu + npm）

当您想要模仿仅具有 Ubuntu + npm 的新机器并验证时，请使用此选项：

- `npx paperclipai onboard --yes` 完成
- 服务器绑定到 `0.0.0.0:3100`，以便主机访问正常
- 板载/运行横幅和启动日志在您的终端中可见

构建+运行：

```sh
./scripts/docker-onboard-smoke.sh
```

打开：`http://localhost:3131`（默认smoke主机端口）

有用的覆盖：

```sh
HOST_PORT=3200 PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private ./scripts/docker-onboard-smoke.sh
```

注意事项：- 持久数据默认挂载在`./data/docker-onboard-smoke`。
- 容器运行时用户 ID 默认为本地 `id -u`，因此挂载的数据目录保持可写，同时避免 root 运行时。
- Smoke 脚本默认为 `authenticated/private` 模式，因此 `HOST=0.0.0.0` 可以暴露给主机。
- Smoke 脚本默认主机端口为 `3131`，以避免与 `3100` 上的本地 Paperclip 发生冲突。
- Smoke 脚本还将 `PAPERCLIP_PUBLIC_URL` 默认为 `http://localhost:<HOST_PORT>`，因此引导邀请 URL 和身份验证回调使用可访问的主机端口，而不是容器的内部 `3100`。
- 在身份验证模式下，smoke 脚本默认为 `SMOKE_AUTO_BOOTSTRAP=true` 并自动驱动真实的引导路径：它注册真实用户，在容器内运行 `paperclipai auth bootstrap-ceo` 以创建真实的引导邀请，通过 HTTP 接受该邀请，并验证董事会会话访问。
- 在前台运行脚本以观察引导流程；验证后以 `Ctrl+C` 停止。
- 图像定义在`Dockerfile.onboard-smoke`中。