# 开发中

该项目可以在本地开发中完全运行，无需手动设置 PostgreSQL。

## 部署模式

有关模式定义和预期的 CLI 行为，请参阅 `doc/DEPLOYMENT-MODES.md`。

目前实施情况：

- 规范型号：`local_trusted` 和 `authenticated`（`private/public` 曝光）

## 前置条件

- Node.js 20+
- pnpm 9+

## 依赖锁文件策略

GitHub 炬力拥有 `pnpm-lock.yaml`。

- 不要在拉取请求中提交 `pnpm-lock.yaml`。
- 拉取请求 CI 在清单更改时验证依赖项解析。
- 推送到`master`，用`pnpm install --lockfile-only --no-frozen-lockfile`重新生成`pnpm-lock.yaml`，如果需要的话提交回来，然后用`--frozen-lockfile`运行验证。

## 开始开发

从仓库根目录：

```sh
pnpm install
pnpm dev
```

这开始：

- API 服务器：`http://localhost:3100`
- UI：由API服务器以开发中间件模式提供服务（与API同源）

`pnpm dev` 在监视模式下运行服务器，并在工作区包（包括适配器包）发生更改时重新启动。使用`pnpm dev:once`运行，无需查看文件。

Tailscale/private-auth 开发模式：

```sh
pnpm dev --tailscale-auth
```

这将 dev 作为 `authenticated/private` 运行，并将服务器绑定到 `0.0.0.0` 以进行私网访问。

允许其他私有主机名（例如自定义 Tailscale 主机名）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## 单命令本地运行

对于首次本地安装，您可以在一个命令中引导并运行：

```sh
pnpm paperclipai run
```

`paperclipai run` 的作用是：

1. 如果配置丢失则自动加载
2. `paperclipai doctor` 已启用修复
3. 检查通过后启动服务器

## Docker 快速入门（无本地节点安装）

在Docker中构建并运行Paperclip：

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

或者使用撰写：

```sh
docker compose -f docker-compose.quickstart.yml up --build
```

有关 API 密钥接线 (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) 和持久性详细信息，请参阅 `doc/DOCKER.md`。

## Dev 中的数据库（自动处理）

对于本地开发，请保留 `DATABASE_URL` 未设置。
服务器将自动使用嵌入的 PostgreSQL 并将数据保存在：

- `~/.paperclip/instances/default/db`

覆盖主目录和实例：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

此模式不需要 Docker 或外部数据库。

## Dev 中的存储（自动处理）

对于本地开发，默认存储提供程序是 `local_disk`，它将上传的图像/附件保存在：

- `~/.paperclip/instances/default/data/storage`

配置存储提供商/设置：

```sh
pnpm paperclipai configure --section storage
```

## 默认智能体工作区

当本地智能体运行没有已解析的项目/会话工作区时，Paperclip 会回退到实例根目录下的智能体主工作区：

- `~/.paperclip/instances/default/workspaces/<agent-id>`

此路径在非默认设置中遵循 `PAPERCLIP_HOME` 和 `PAPERCLIP_INSTANCE_ID`。

## 工作树本地实例

当从多个 git 工作树进行开发时，请勿将两个 Paperclip 服务器指向同一嵌入式 PostgreSQL 数据目录。相反，创建一个存储库本地 Paperclip 配置以及工作树的隔离实例：

```sh
paperclipai worktree init
# or create the git worktree and initialize it in one step:
pnpm paperclipai worktree:make paperclip-pr-432
```

这个命令：

- 在 `.paperclip/config.json` 和 `.paperclip/.env` 处写入存储库本地文件
- 在`~/.paperclip-worktrees/instances/<worktree-id>/`下创建一个隔离实例
- 当在链接的 git 工作树中运行时，将有效的 git 挂钩镜像到该工作树的私有 git 目录中
- 选择免费的应用程序端口和嵌入式 PostgreSQL 端口
- 默认情况下，通过逻辑 SQL 快照从主实例以 `minimal` 模式播种隔离数据库

种子模式：

- `minimal` 保留核心应用程序状态，如公司、项目、问题、评论、批准和身份验证状态，保留所有表的架构，但忽略繁重操作历史记录中的行数据，如心跳运行、唤醒请求、活动日志、运行时服务和智能体会话状态
- `full` 对源实例进行完整逻辑克隆
- `--no-seed` 创建一个空的隔离实例

在 `worktree init` 之后，服务器和 CLI 在该工作树内运行时都会自动加载存储库本地 `.paperclip/.env`，因此 `pnpm dev`、`paperclipai doctor` 和 `paperclipai db:backup` 等普通命令的作用域仍为工作树实例。

该 repo-local env 还设置 `PAPERCLIP_IN_WORKTREE=true`，服务器可以将其用于特定于工作树的 UI 行为，例如备用图标。

需要时显式打印 shell 导出：

```sh
paperclipai worktree env
# or:
eval "$(paperclipai worktree env)"
```

有用的选项：

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode minimal
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

对于项目执行工作树，Paperclip 在创建或重用隔离的 git 工作树后还可以运行项目定义的配置命令。在项目的执行工作区策略 (`workspaceStrategy.provisionCommand`) 上配置此项。该命令在派生工作树内运行并接收 `PAPERCLIP_WORKSPACE_*`、`PAPERCLIP_PROJECT_ID`、`PAPERCLIP_AGENT_ID` 和 `PAPERCLIP_ISSUE_*` 环境变量，因此每个存储库都可以根据需要自行引导。

## 快速健康检查

在另一个终端中：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

预计：

- `/api/health` 返回 `{"status":"ok"}`
- `/api/companies` 返回 JSON 数组

## 重置本地开发数据库

要擦除本地开发数据并重新开始：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 可选：使用外部 Postgres

如果您设置 `DATABASE_URL`，服务器将使用它而不是嵌入的 PostgreSQL。

## 自动数据库备份

Paperclip 可以在计时器上运行自动数据库备份。默认值：

- 启用
- 每 60 分钟一班
- 保留30天
- 备份目录：`~/.paperclip/instances/default/data/backups`

在以下位置配置这些：

```sh
pnpm paperclipai configure --section database
```

手动运行一次性备份：

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

环境覆盖：

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`

## 开发中的秘密

智能体环境变量现在支持秘密引用。默认情况下，秘密值使用本地加密存储，并且只有秘密引用保留在智能体配置中。- 默认本地密钥路径：`~/.paperclip/instances/default/secrets/master.key`
- 直接覆盖密钥材料：`PAPERCLIP_SECRETS_MASTER_KEY`
- 覆盖密钥文件路径：`PAPERCLIP_SECRETS_MASTER_KEY_FILE`

严格模式（推荐在本地可信机器之外）：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

启用严格模式时，敏感环境键（例如 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）必须使用秘密引用而不是内联纯值。

CLI 配置支持：

- `pnpm paperclipai onboard` 写入默认的 `secrets` 配置部分（`local_encrypted`，严格模式关闭，密钥文件路径设置）并在需要时创建本地密钥文件。
- `pnpm paperclipai configure --section secrets` 允许您更新提供商/严格模式/密钥路径并在需要时创建本地密钥文件。
- `pnpm paperclipai doctor` 验证机密适配器配置，并可以使用 `--repair` 创建丢失的本地密钥文件。

现有内联环境机密的迁移助手：

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## 公司删除切换

公司删除旨在作为开发/调试功能，可以在运行时禁用：

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

默认行为：

- `local_trusted`：已启用
- `authenticated`：已禁用

## CLI 客户端操作

Paperclip CLI 现在除了设置命令之外还包括客户端控制平面命令。

简单示例：

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

使用上下文配置文件设置默认值一次：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

然后运行命令而不重复标志：

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

请参阅 `doc/CLI.md` 中的完整命令参考。

## OpenClaw 邀请加入端点

面向智能体的邀请加入现在公开机器可读的 API 文档：

- `GET /api/invites/:token` 返回邀请摘要以及入门和技能索引链接。
- `GET /api/invites/:token/onboarding` 返回加入清单详细信息（注册端点、声明端点模板、技能安装提示）。
- `GET /api/invites/:token/onboarding.txt` 返回适用于人工操作员和智能体的纯文本入职文档（llm.txt 样式切换），包括可选的邀请者消息和建议的网络主机候选者。
- `GET /api/skills/index` 列出可用的技能文档。
- `GET /api/skills/paperclip` 返回Paperclip 心跳技能降价。

## OpenClaw 加入冒烟测试

运行端到端 OpenClaw 连接烟雾线束：

```sh
pnpm smoke:openclaw-join
```

它验证什么：

- 邀请创建仅智能体加入
- 使用 `adapterType=openclaw` 的智能体加入请求
- 董事会批准+一次性API关键索赔语义
- 唤醒时回调传递到 Docker 化的 OpenClaw 风格的 webhook 接收器

所需权限：

- 此脚本执行董事会管理的操作（创建邀请、批准加入、唤醒另一个智能体）。
- 在身份验证模式下，通过 `PAPERCLIP_AUTH_HEADER` 或 `PAPERCLIP_COOKIE` 进行板身份验证运行。

可选的身份验证标志（用于身份验证模式）：

- `PAPERCLIP_AUTH_HEADER`（例如`Bearer ...`）
- `PAPERCLIP_COOKIE`（会话cookie头值）

## OpenClaw Docker UI 单命令脚本要在 Docker 中启动 OpenClaw 并通过一个命令打印主机浏览器控制台 URL：

```sh
pnpm smoke:openclaw-docker-ui
```

该脚本位于 `scripts/smoke/openclaw-docker-ui.sh`，并自动克隆/构建/配置/启动基于 Compose 的本地 OpenClaw UI 测试。

此烟雾脚本的配对行为：

- 默认 `OPENCLAW_DISABLE_DEVICE_AUTH=1`（本地烟雾没有控制 UI 配对提示；不需要额外的配对环境变量）
- 设置 `OPENCLAW_DISABLE_DEVICE_AUTH=0` 要求标准设备配对

此烟雾脚本的模型行为：

- 默认为 OpenAI 模型（`openai/gpt-5.2` + OpenAI 后备），因此默认情况下不需要人工验证

此烟雾脚本的状态行为：

- 默认为独立配置目录 `~/.openclaw-paperclip-smoke`
- 默认情况下每次运行时都会重置烟雾剂状态（`OPENCLAW_RESET_STATE=1`）以避免过时的提供程序/身份验证漂移

此烟雾脚本的网络行为：

- 自动检测并打印可从 OpenClaw Docker 内部访问的 Paperclip 主机 URL
- 默认容器端主机别名是 `host.docker.internal` （用 `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT` 覆盖）
- 如果 Paperclip 在身份验证/私有模式下拒绝容器主机名，则通过 `pnpm paperclipai allowed-hostname host.docker.internal` 允许 `host.docker.internal` 并重新启动 Paperclip