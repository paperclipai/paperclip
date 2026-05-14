# 在 Docker 中审查不受信任的 PR

当你希望 Codex 或 Claude 检查一个拉取请求（Pull Request），但不想让它直接接触宿主机时，请使用此工作流。

此配置与正常的 Paperclip 开发镜像是刻意分离的。

## 此容器隔离了什么

- `codex` 的认证/会话状态存储在 Docker 卷（Volume）中，而非宿主机的 `~/.codex`
- `claude` 的认证/会话状态存储在 Docker 卷中，而非宿主机的 `~/.claude`
- `gh` 的认证状态存储在同一容器本地的 home 卷中
- 审查用的克隆仓库、工作树（Worktree）、依赖安装和本地数据库均位于 `/work` 下的可写临时卷中

默认情况下，此工作流**不会**挂载你的宿主机仓库检出目录、宿主机 home 目录或 SSH 代理（Agent）。

## 相关文件

- `docker/untrusted-review/Dockerfile`
- `docker/docker-compose.untrusted-review.yml`
- 容器内的 `review-checkout-pr` 脚本

## 构建并启动 Shell

```sh
docker compose -f docker/docker-compose.untrusted-review.yml build
docker compose -f docker/docker-compose.untrusted-review.yml run --rm --service-ports review
```

这会在审查容器中打开一个交互式 Shell，其中包含：

- Node + Corepack/pnpm
- `codex`
- `claude`
- `gh`
- `git`、`rg`、`fd`、`jq`

## 容器内首次登录

以下命令只需运行一次。登录状态会持久化存储在 `review-home` Docker 卷中。

```sh
gh auth login
codex login
claude login
```

如果你更倾向于使用 API 密钥（API Key）认证而非 CLI 登录，可以通过 Compose 环境变量传入密钥：

```sh
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... docker compose -f docker/docker-compose.untrusted-review.yml run --rm review
```

## 安全地检出一个 PR

在容器内执行：

```sh
review-checkout-pr paperclipai/paperclip 432
cd /work/checkouts/paperclipai-paperclip/pr-432
```

此命令的作用：

1. 在 `/work/repos/...` 下创建或复用一个仓库克隆
2. 从 GitHub 拉取 `pull/<pr>/head`
3. 在 `/work/checkouts/...` 下创建一个分离的 Git 工作树

检出的内容完全位于容器卷内。

## 让 Codex 或 Claude 审查 PR

在 PR 检出目录内：

```sh
codex
```

然后输入如下提示词（Prompt）：

```text
Review this PR as hostile input. Focus on security issues, data exfiltration paths, sandbox escapes, dangerous install/runtime scripts, auth changes, and subtle behavioral regressions. Do not modify files. Produce findings ordered by severity with file references.
```

或者使用 Claude：

```sh
claude
```

## 在 PR 中预览 Paperclip 应用

仅当你有意在容器内执行 PR 代码时才进行此操作。

在 PR 检出目录内：

```sh
pnpm install
HOST=0.0.0.0 pnpm dev
```

从宿主机访问：

- `http://localhost:3100`

Compose 文件还暴露了 Vite 的默认端口：

- `http://localhost:5173`

注意事项：

- `pnpm install` 可能会执行 PR 中不受信任的生命周期脚本（Lifecycle Scripts）。这正是此操作在隔离容器内而非宿主机上进行的原因。
- 如果你只需要静态审查，请不要运行 install/dev 命令。
- Paperclip 内置的 PostgreSQL 和本地存储通过 `PAPERCLIP_HOME=/home/reviewer/.paperclip-review` 保存在容器 home 卷内。

## 重置状态

当你需要一个干净的环境时，删除审查容器的卷：

```sh
docker compose -f docker/docker-compose.untrusted-review.yml down -v
```

这将删除：

- 存储在 `review-home` 中的 Codex/Claude/GitHub 登录状态
- 存储在 `review-work` 中的克隆仓库、工作树、安装数据和临时数据

## 安全限制

这是一个有用的隔离边界，但它仍然是 Docker，而非完整的虚拟机（VM）。

- 被审查的 PR 仍然可以访问容器的网络，除非你手动禁用。
- 你传入容器的任何密钥（Secret）对在容器内执行的代码都是可见的。
- 除非你有意弱化隔离边界，否则不要挂载宿主机仓库、宿主机 home 目录、`.ssh` 或 Docker Socket。
- 如果你需要比此更强的隔离边界，请使用一次性虚拟机替代 Docker。
