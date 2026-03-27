# 开发指南

本项目可以在不手动设置 PostgreSQL 的情况下完全在本地开发环境中运行。

## 部署模式

有关模式定义和预期的 CLI 行为，请参见 `doc/DEPLOYMENT-MODES.md`。

当前实施状态：

- 规范模型：`local_trusted` 和 `authenticated`（带有 `private/public` 暴露方式）

## 前提条件

- Node.js 20+
- pnpm 9+

## 依赖锁定文件策略

GitHub Actions 管理 `pnpm-lock.yaml`。

- 不要在 Pull Request 中提交 `pnpm-lock.yaml`。
- Pull Request CI 在清单更改时验证依赖解析。
- 推送到 `master` 时使用 `pnpm install --lockfile-only --no-frozen-lockfile` 重新生成 `pnpm-lock.yaml`，如需要则提交回去，然后使用 `--frozen-lockfile` 运行验证。

## 启动开发

从仓库根目录：

```sh
pnpm install
pnpm dev
```

这将启动：

- API 服务器：`http://localhost:3100`
- UI：由 API 服务器在开发中间件模式下提供（与 API 同源）

`pnpm dev` 以监视模式运行服务器，当工作区包（包括适配器包）发生变更时自动重启。使用 `pnpm dev:once` 运行而不进行文件监视。

`pnpm dev:once` 现在会追踪后端相关的文件变更和待处理的迁移。当当前启动过期时，董事会 UI 会显示 `Restart required` 横幅。你还可以在 `Instance Settings > Experimental` 中启用受保护的自动重启，它会等待排队/运行中的本地代理任务完成后再重启开发服务器。

Tailscale/私有认证开发模式：

```sh
pnpm dev --tailscale-auth
```

这将以 `authenticated/private` 模式运行开发，并将服务器绑定到 `0.0.0.0` 以允许私有网络访问。

允许额外的私有主机名（例如自定义 Tailscale 主机名）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## 一键本地运行

对于首次本地安装，你可以一条命令引导并运行：

```sh
pnpm paperclipai run
```

`paperclipai run` 执行以下操作：

1. 如果配置缺失则自动入门
2. 启用修复的 `paperclipai doctor`
3. 检查通过后启动服务器

## Docker 快速启动（无需本地安装 Node）

在 Docker 中构建和运行 Paperclip：

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

或使用 Compose：

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

有关 API 密钥配置（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）和持久化详情，请参见 `doc/DOCKER.md`。

## 用于不受信任 PR 审查的 Docker

如需一个单独的面向审查的容器，该容器将 `codex`/`claude` 登录状态保存在 Docker 卷中，并将 PR 检出到隔离的临时工作区中，请参见 `doc/UNTRUSTED-PR-REVIEW.md`。

## 开发中的数据库（自动处理）

对于本地开发，保持 `DATABASE_URL` 未设置。
服务器将自动使用嵌入式 PostgreSQL 并将数据持久化在：

- `~/.paperclip/instances/default/db`

覆盖主目录和实例：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

此模式不需要 Docker 或外部数据库。

## 开发中的存储（自动处理）

对于本地开发，默认存储提供者是 `local_disk`，将上传的图片/附件持久化在：

- `~/.paperclip/instances/default/data/storage`

配置存储提供者/设置：

```sh
pnpm paperclipai configure --section storage
```

## 默认代理工作区

当本地代理运行没有已解析的项目/会话工作区时，Paperclip 回退到实例根目录下的代理主工作区：

- `~/.paperclip/instances/default/workspaces/<agent-id>`

此路径在非默认设置中遵循 `PAPERCLIP_HOME` 和 `PAPERCLIP_INSTANCE_ID`。

对于 `codex_local`，Paperclip 还在实例根目录下管理每个公司的 Codex 主目录，并从共享的 Codex 登录/配置主目录（`$CODEX_HOME` 或 `~/.codex`）中初始化：

- `~/.paperclip/instances/default/companies/<company-id>/codex-home`

## 工作树本地实例

从多个 git 工作树开发时，不要将两个 Paperclip 服务器指向同一个嵌入式 PostgreSQL 数据目录。

相反，为工作树创建一个仓库本地的 Paperclip 配置和隔离实例：

```sh
paperclipai worktree init
# 或者一步创建 git 工作树并初始化：
pnpm paperclipai worktree:make paperclip-pr-432
```

此命令：

- 在 `.paperclip/config.json` 和 `.paperclip/.env` 中写入仓库本地文件
- 在 `~/.paperclip-worktrees/instances/<worktree-id>/` 下创建隔离实例
- 当在链接的 git 工作树中运行时，将有效的 git hooks 镜像到该工作树的私有 git 目录中
- 选择空闲的应用端口和嵌入式 PostgreSQL 端口
- 默认以 `minimal` 模式从当前有效的 Paperclip 实例/配置（存在仓库本地工作树配置时使用，否则使用默认实例）通过逻辑 SQL 快照初始化隔离数据库

初始化模式：

- `minimal` 保留核心应用状态如公司、项目、issues、评论、审批和认证状态，保留所有表的 schema，但省略心跳运行、唤醒请求、活动日志、运行时服务和代理会话状态等重操作历史数据
- `full` 对源实例进行完整的逻辑克隆
- `--no-seed` 创建空的隔离实例

`worktree init` 之后，服务器和 CLI 在该工作树中运行时会自动加载仓库本地的 `.paperclip/.env`，因此 `pnpm dev`、`paperclipai doctor` 和 `paperclipai db:backup` 等正常命令仍然限定在工作树实例范围内。

该仓库本地环境还设置了：

- `PAPERCLIP_IN_WORKTREE=true`
- `PAPERCLIP_WORKTREE_NAME=<worktree-name>`
- `PAPERCLIP_WORKTREE_COLOR=<hex-color>`

服务器/UI 使用这些值进行工作树特定的品牌标识，如顶部横幅和动态着色的 favicon。

需要时显式打印 shell 导出：

```sh
paperclipai worktree env
# 或：
eval "$(paperclipai worktree env)"
```

### 工作树 CLI 参考

**`pnpm paperclipai worktree init [options]`** — 为当前工作树创建仓库本地配置/环境和隔离实例。

| 选项 | 描述 |
|---|---|
| `--name <name>` | 用于派生实例 ID 的显示名称 |
| `--instance <id>` | 显式隔离实例 ID |
| `--home <path>` | 工作树实例的主根目录（默认：`~/.paperclip-worktrees`） |
| `--from-config <path>` | 用于初始化的源 config.json |
| `--from-data-dir <path>` | 派生源配置时使用的源 PAPERCLIP_HOME |
| `--from-instance <id>` | 源实例 ID（默认：`default`） |
| `--server-port <port>` | 首选服务器端口 |
| `--db-port <port>` | 首选嵌入式 Postgres 端口 |
| `--seed-mode <mode>` | 初始化配置：`minimal` 或 `full`（默认：`minimal`） |
| `--no-seed` | 跳过从源实例初始化数据库 |
| `--force` | 替换现有仓库本地配置和隔离实例数据 |

示例：

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

修复已创建的仓库管理工作树并从主默认安装重新初始化其隔离实例：

```sh
cd ~/.paperclip/worktrees/PAP-884-ai-commits-component
pnpm paperclipai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.paperclip/instances/default/config.json
```

这将重写工作树本地的 `.paperclip/config.json` + `.paperclip/.env`，在 `~/.paperclip-worktrees/instances/<worktree-id>/` 下重新创建隔离实例，并保留 git 工作树内容本身。

**`pnpm paperclipai worktree:make <name> [options]`** — 将 `~/NAME` 创建为 git 工作树，然后在其中初始化隔离的 Paperclip 实例。这将 `git worktree add` 和 `worktree init` 合并为一个步骤。

| 选项 | 描述 |
|---|---|
| `--start-point <ref>` | 新分支基于的远程引用（例如 `origin/main`） |
| `--instance <id>` | 显式隔离实例 ID |
| `--home <path>` | 工作树实例的主根目录（默认：`~/.paperclip-worktrees`） |
| `--from-config <path>` | 用于初始化的源 config.json |
| `--from-data-dir <path>` | 派生源配置时使用的源 PAPERCLIP_HOME |
| `--from-instance <id>` | 源实例 ID（默认：`default`） |
| `--server-port <port>` | 首选服务器端口 |
| `--db-port <port>` | 首选嵌入式 Postgres 端口 |
| `--seed-mode <mode>` | 初始化配置：`minimal` 或 `full`（默认：`minimal`） |
| `--no-seed` | 跳过从源实例初始化数据库 |
| `--force` | 替换现有仓库本地配置和隔离实例数据 |

示例：

```sh
pnpm paperclipai worktree:make paperclip-pr-432
pnpm paperclipai worktree:make my-feature --start-point origin/main
pnpm paperclipai worktree:make experiment --no-seed
```

**`pnpm paperclipai worktree env [options]`** — 打印当前工作树本地 Paperclip 实例的 shell 导出。

| 选项 | 描述 |
|---|---|
| `-c, --config <path>` | 配置文件路径 |
| `--json` | 打印 JSON 而不是 shell 导出 |

示例：

```sh
pnpm paperclipai worktree env
pnpm paperclipai worktree env --json
eval "$(pnpm paperclipai worktree env)"
```

对于项目执行工作树，Paperclip 还可以在创建或复用隔离的 git 工作树后运行项目定义的配置命令。在项目的执行工作区策略（`workspaceStrategy.provisionCommand`）中配置。该命令在派生的工作树内运行，并接收 `PAPERCLIP_WORKSPACE_*`、`PAPERCLIP_PROJECT_ID`、`PAPERCLIP_AGENT_ID` 和 `PAPERCLIP_ISSUE_*` 环境变量，以便每个仓库可以按需引导自身。

## 快速健康检查

在另一个终端中：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

预期结果：

- `/api/health` 返回 `{"status":"ok"}`
- `/api/companies` 返回一个 JSON 数组

## 重置本地开发数据库

要清除本地开发数据并全新开始：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 可选：使用外部 Postgres

如果你设置了 `DATABASE_URL`，服务器将使用它而不是嵌入式 PostgreSQL。

## 自动数据库备份

Paperclip 可以按定时器运行自动数据库备份。默认值：

- 已启用
- 每 60 分钟
- 保留 30 天
- 备份目录：`~/.paperclip/instances/default/data/backups`

在以下位置配置：

```sh
pnpm paperclipai configure --section database
```

手动运行一次性备份：

```sh
pnpm paperclipai db:backup
# 或：
pnpm db:backup
```

环境变量覆盖：

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`

## 开发中的密钥

代理环境变量现在支持密钥引用。默认情况下，密钥值使用本地加密存储，只有密钥引用持久化在代理配置中。

- 默认本地密钥路径：`~/.paperclip/instances/default/secrets/master.key`
- 直接覆盖密钥材料：`PAPERCLIP_SECRETS_MASTER_KEY`
- 覆盖密钥文件路径：`PAPERCLIP_SECRETS_MASTER_KEY_FILE`

严格模式（建议在非本地受信机器上使用）：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

当严格模式启用时，敏感环境变量键（例如 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必须使用密钥引用而不是内联明文值。

CLI 配置支持：

- `pnpm paperclipai onboard` 写入默认的 `secrets` 配置节（`local_encrypted`，严格模式关闭，密钥文件路径已设置），并在需要时创建本地密钥文件。
- `pnpm paperclipai configure --section secrets` 允许你更新提供者/严格模式/密钥路径，并在需要时创建本地密钥文件。
- `pnpm paperclipai doctor` 验证密钥适配器配置，并可使用 `--repair` 创建缺失的本地密钥文件。

现有内联环境密钥的迁移助手：

```sh
pnpm secrets:migrate-inline-env         # 试运行
pnpm secrets:migrate-inline-env --apply # 应用迁移
```

## 公司删除开关

公司删除旨在作为开发/调试功能，可在运行时禁用：

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

默认行为：

- `local_trusted`：已启用
- `authenticated`：已禁用

## CLI 客户端操作

Paperclip CLI 现在除了设置命令外还包含客户端控制平面命令。

快速示例：

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

使用上下文配置一次性设置默认值：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

然后无需重复标志即可运行命令：

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

完整命令参考请参见 `doc/CLI.md`。

## OpenClaw 邀请入门端点

面向代理的邀请入门现在暴露机器可读的 API 文档：

- `GET /api/invites/:token` 返回邀请摘要以及入门和技能索引链接。
- `GET /api/invites/:token/onboarding` 返回入门清单详情（注册端点、声明端点模板、技能安装提示）。
- `GET /api/invites/:token/onboarding.txt` 返回面向人工操作员和代理的纯文本入门文档（llm.txt 风格交接），包含可选的邀请者消息和建议的网络主机候选。
- `GET /api/skills/index` 列出可用的技能文档。
- `GET /api/skills/paperclip` 返回 Paperclip 心跳技能 markdown。

## OpenClaw 加入冒烟测试

运行端到端 OpenClaw 加入冒烟测试工具：

```sh
pnpm smoke:openclaw-join
```

验证内容：

- 仅代理加入的邀请创建
- 使用 `adapterType=openclaw` 的代理加入请求
- 董事会审批 + 一次性 API 密钥声明语义
- 对容器化 OpenClaw 风格 webhook 接收器的唤醒回调交付

所需权限：

- 此脚本执行受董事会管理的操作（创建邀请、审批加入、唤醒另一个代理）。
- 在认证模式下，通过 `PAPERCLIP_AUTH_HEADER` 或 `PAPERCLIP_COOKIE` 使用董事会认证运行。

可选认证标志（用于认证模式）：

- `PAPERCLIP_AUTH_HEADER`（例如 `Bearer ...`）
- `PAPERCLIP_COOKIE`（会话 cookie 头值）

## OpenClaw Docker UI 一键脚本

要在 Docker 中启动 OpenClaw 并一条命令打印主机浏览器仪表盘 URL：

```sh
pnpm smoke:openclaw-docker-ui
```

此脚本位于 `scripts/smoke/openclaw-docker-ui.sh`，自动化基于 Compose 的本地 OpenClaw UI 测试的克隆/构建/配置/启动流程。

此冒烟脚本的配对行为：

- 默认 `OPENCLAW_DISABLE_DEVICE_AUTH=1`（本地冒烟测试无 Control UI 配对提示；不需要额外的配对环境变量）
- 设置 `OPENCLAW_DISABLE_DEVICE_AUTH=0` 以要求标准设备配对

此冒烟脚本的模型行为：

- 默认使用 OpenAI 模型（`openai/gpt-5.2` + OpenAI 回退），因此默认不需要 Anthropic 认证

此冒烟脚本的状态行为：

- 默认使用隔离的配置目录 `~/.openclaw-paperclip-smoke`
- 每次运行默认重置冒烟代理状态（`OPENCLAW_RESET_STATE=1`）以避免陈旧的提供者/认证漂移

此冒烟脚本的网络行为：

- 自动检测并打印从 OpenClaw Docker 内部可达的 Paperclip 主机 URL
- 默认容器端主机别名为 `host.docker.internal`（通过 `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT` 覆盖）
- 如果 Paperclip 在 authenticated/private 模式下拒绝容器主机名，通过 `pnpm paperclipai allowed-hostname host.docker.internal` 允许 `host.docker.internal` 并重启 Paperclip
