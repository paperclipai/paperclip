# 开发指南（Developing）

> **路径（path）**：`doc/05 开发指南 DEVELOPING.md`。命令、端口、环境变量、JSON 与路径示例保持英文，便于复制执行。

本地开发可**完全不手工安装 PostgreSQL** 而完整运行本项目。

## 部署模式（Deployment Modes）

模式定义与预期 CLI 行为见 `doc/07 部署模式 DEPLOYMENT-MODES.md`。

当前实现状态：

- 规范模型：`local_trusted` 与 `authenticated`（配合 `private` / `public` **曝光 exposure**）

## 前置要求（Prerequisites）

- Node.js 20+  
- pnpm 9+

## 依赖锁文件策略（Dependency Lockfile Policy）

`pnpm-lock.yaml` 由 GitHub Actions **拥有/维护**。

- **不要**在 pull request 里提交 `pnpm-lock.yaml`。  
- 当 manifest 变更时，PR CI 会校验依赖解析。  
- 推送到 `master` 会用 `pnpm install --lockfile-only --no-frozen-lockfile` 重新生成 `pnpm-lock.yaml`，必要时提交回去，再用 `--frozen-lockfile` 跑校验。

## 启动开发（Start Dev）

本地模式 **A/B/C**（嵌入库、容器库、全容器）统一检查清单与 3100 追查：**[doc/23 本地开发部署模式检查清单.md](23%20本地开发部署模式检查清单.md)**。

在仓库根目录：

```sh
pnpm install
pnpm dev:once
```

将启动：

- API：`http://localhost:3100`  
- UI：由 API 在 dev **middleware（中间件）** 模式同机提供（与 API 同源）

**dev-runner 两种入口：** 仓库根 **`pnpm dev:once`**（以及 Windows **`pwsh -NoProfile -File scripts/start-paperclip-dev-external.ps1`** 一条龙，内部同为 `dev:once`）**不**安装后端目录轮询与空闲自动重启；改代码后需**自行**在前台停止再启动。需要「检测后端变更 / 待处理迁移并在空闲时自动重启子服务」时用 **`pnpm dev`**（仍**无**基于 tsx 的 file-watch，详见实现）。

二者默认在启动开发服务器**前**尝试应用待处理本地迁移。

对应当前仓库与实例，`pnpm dev` / `pnpm dev:once` 具**幂等**：若匹配的 Paperclip dev runner 已在运行，会报告已有进程而不是再起一份。

Issue 执行亦可使用项目的 **execution workspace（执行工作区）** 策略与 **workspace runtime services（工作区运行时服务）**（每项目 worktree、预览服、受管 dev 命令）。应在项目 workspace/runtime 界面配置，而不是在任务需要可复用服务时再手工起长期无人看管进程。

## Storybook（Storybook）

Board UI 的 Storybook 将 stories 与配置放在 `ui/storybook/`，以免评审用例混进应用路由源码。

```sh
pnpm storybook
pnpm build-storybook
```

会在端口 `6006` 跑 `@paperclipai/ui` 的 Storybook，并把静态产物输出到 `ui/storybook-static/`。

查看或停止当前仓库受管的 dev runner：

```sh
pnpm dev:list
pnpm dev:stop
```

### 停止开发服务（优雅停止 + 验证）

1. **前台终端** — 若在同一窗口起的 `pnpm dev` / `pnpm dev:once`，按一次 **Ctrl+C** 并等待进程退出。
2. **受管 runner（任意终端，仓库根）** — 运行 `pnpm dev:list`，再 `pnpm dev:stop`。会停止**为本仓库注册**的进程（如 `paperclip-dev-watch`、`paperclip-dev-once`）并清除本地注册表项。
3. **孤儿 API 仍占用 3100** — `pnpm dev:stop` 只认识已注册 runner。若 `pnpm dev:list` 为空但 `http://127.0.0.1:3100/api/health` 仍响应，或新启动报 **address in use**，可能是别处起的 `node`/`tsx` 在跑 `server/src/index.ts` 却未注册。请查端口 **3100** 的 owning PID，看命令行，只结束你确认要关的 Paperclip 服务。Windows PowerShell 示例：

   ```powershell
   Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue | Select-Object OwningProcess
   (Get-CimInstance Win32_Process -Filter 'ProcessId=<PID>').CommandLine
   ```

4. **嵌入式 Postgres（Embedded Postgres）** — 停止 dev 未必立刻拆掉内嵌 `postgres` 子进程；若遇 `postmaster.pid` / 端口 **54329** 问题，见本文数据库清理说明及中文运维摘要 [**运维-回形针本地.md**](../docs/项目计划/最佳实践/001-运维-回形针本地.md)。

`pnpm dev` 会跟踪后端相关文件变更与待处理迁移。当前启动已过期时，Board UI 会显示 **Restart Required**（需要重启）横幅。也可在 `Instance Settings > Experimental` 开启**有保护的自动重启**，会等队列中/运行中的本地 agent run 结束后再重启 dev 服务。`pnpm dev:once` 与一条龙脚本不启用上述轮询与空闲自动重启。

Tailscale / private-auth 开发模式：

```sh
pnpm dev --bind lan
```

以 `authenticated` / `private` 与私网绑定预设运行 dev。

仅在检测到的 tailnet 地址上可达：

```sh
pnpm dev --bind tailnet
```

旧别名仍映射到旧的宽泛私网行为：

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

允许额外私网主机名（例如自定义 Tailscale 主机名）：

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

## 测试命令（Test Commands）

除非你在专门做浏览器流程，否则用默认的廉价本地测试：

```sh
pnpm test
```

`pnpm test` 只跑 Vitest。交互式 watch：

```sh
pnpm test:watch
```

浏览器相关套件单独跑：

```sh
pnpm test:e2e
pnpm test:release-smoke
```

这些面向本地定点验证与 CI，不是默认的 agent/人类日常测试命令。

平常改 issue，先用**最小范围**能证明改动的检查。全仓库 typecheck/build/test 留给 PR 交付或改动面大到窄检查不够覆盖时。

## 一键本地运行（One-Command Local Run）

首次本地安装可一条命令启动：

```sh
pnpm paperclipai run
```

`paperclipai run` 会：

1. 若缺配置则自动 **onboard（入驻引导）**
2. 带修复地跑 `paperclipai doctor`
3. 检查通过后启动服务器

## Docker 快速开始（无本机 Node）

构建并运行 Paperclip：

```sh
docker build -t paperclip-local .
docker run --name paperclip \
  -p 3100:3100 \
  -e HOST=0.0.0.0 \
  -e PAPERCLIP_HOME=/paperclip \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  paperclip-local
```

或用 Compose：

```sh
docker compose -f docker/docker-compose.quickstart.yml up --build
```

API key 与环境变量持久化等见 `doc/08 容器部署 DOCKER.md`（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 等）。

## 不可信 PR 评审用 Docker（Docker For Untrusted PR Review）

需要单独评审容器、把 `codex`/`claude` 登录态放在 Docker volume、并把 PR checkout 到隔离 scratch 工作区时，见 `doc/UNTRUSTED-PR-REVIEW.md`。

## 本地实例目录（Local Instance Layout）

每个本地安装把运行时状态放在所选 **instance root（实例根）**下：

```text
~/.paperclip/instances/default/                  # instance root
  config.json                                    # runtime config
  .env                                           # instance env file
  db/                                            # embedded PostgreSQL data
  data/
    storage/                                     # local_disk uploads
    backups/                                     # automatic DB backups
  logs/
  secrets/master.key                             # local_encrypted master key
  workspaces/<agent-id>/                         # default agent workspaces
  projects/                                      # project execution workspaces
  companies/<company-id>/codex-home/             # per-company codex_local home
```

`PAPERCLIP_HOME` 与 `PAPERCLIP_INSTANCE_ID` 覆盖 home 根与 instance id。`paperclipai onboard` 会在横幅里打印解析结果（`Local home: <home> | instance: <id> | config: <path>`），便于确认状态将落盘何处。

## 开发中的数据库（自动处理）

本地开发请**不要设置** `DATABASE_URL`。  
服务器会自动使用嵌入式 PostgreSQL，数据在：

- `~/.paperclip/instances/default/db`

覆盖 home 或 instance：

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

该模式不需要 Docker 或外部数据库。

## 开发中的存储（自动处理）

本地默认存储 provider 为 `local_disk`，上传的图片/附件在：

- `~/.paperclip/instances/default/data/storage`

配置存储 provider：

```sh
pnpm paperclipai configure --section storage
```

## 默认 Agent 工作区（Default Agent Workspaces）

本地 agent run 若未解析到 project/session workspace，Paperclip 回退到实例根下的 agent home：

- `~/.paperclip/instances/default/workspaces/<agent-id>`

该路径在非默认 setup 下也尊重 `PAPERCLIP_HOME` / `PAPERCLIP_INSTANCE_ID`。

对 `codex_local`，Paperclip 还在实例根下按 **company** 管理 Codex home，并从共享 Codex 登录/配置 home（`$CODEX_HOME` 或 `~/.codex`）做种子：

- `~/.paperclip/instances/default/companies/<company-id>/codex-home`

若未安装 `codex` 或不在 `PATH`，`codex_local` 会在执行时报清晰的 adapter 错误。**Quota（配额）轮询会起短生命周期 `codex app-server` 子进程：无法 spawn `codex` 时，该 provider 在聚合配额结果里报告 `ok: false`，API 服务器不得**因此退出。

本地适配器需要本机装好对应 CLI/会话。外部适配器经 adapter/plugin 流程安装，不应在 `server/` 或 `ui/` 硬编码 import。

## Worktree 本地实例（Worktree-local Instances）

多个 git worktree 开发时，**不要**让两个 Paperclip 服务器指向同一嵌入式 PostgreSQL 数据目录。

应创建**仓库内** Paperclip 配置 + 为 worktree **隔离**的 instance：

```sh
paperclipai worktree init
# 或一步创建 git worktree 并初始化：
pnpm paperclipai worktree:make paperclip-pr-432
```

该命令会：

- 写入仓库内 `.paperclip/config.json` 与 `.paperclip/.env`  
- 在 `~/.paperclip-worktrees/instances/<worktree-id>/` 下创建隔离 instance  
- 若在已链接的 git worktree 内运行，会把有效 git hooks 镜像到该 worktree 的私有 git 目录  
- 挑选空闲 app 端口与嵌入式 PostgreSQL 端口  
- 默认以 `minimal` 模式从当前有效 Paperclip instance/config（优先仓库内 worktree 配置，否则 default）通过**逻辑 SQL 快照**做 DB **seed（播种/复制）**

**Seed 模式（Seed modes）**：

- `minimal`：保留 company、project、issue、评论、审批、auth 等核心应用状态，所有表 schema 保留，但省略重运营历史行（如 heartbeat runs、wake requests、activity logs、runtime services、agent session state 等）  
- `full`：对源 instance 做完整逻辑克隆  
- `--no-seed`：创建空隔离 instance

播种后的 worktree instance 默认会**隔离**复制来的「仍在执行」的状态：`minimal` 与 `full` 都会在恢复流程里关掉复制的 agent 定时 heartbeat、把复制时 `running` 的 agent 重置为 `idle`、阻塞并取消复制来的 agent 持有的 `in_progress` issue、并取消复制来的 agent 持有的 `todo`/`in_review` 指派。这样新 worktree 启动后不会替源实例继续跑 agent。只有在你**有意**让隔离 worktree 接续复制指派时，才传 `--preserve-live-work`。

`worktree init` 之后，在该 worktree 内起服务器与 CLI 会自动加载仓库内 `.paperclip/.env`，因此 `pnpm dev`、`paperclipai doctor`、`paperclipai db:backup` 等都 scoped 到该 worktree instance。

`pnpm dev` 在已链接的 git worktree 若缺少 `.paperclip/.env` 会 **fail fast**，而不是悄悄用 default instance/端口。若发生，请先在 worktree 内运行 `paperclipai worktree init`。

已 provision 的 git worktree 默认还会**暂停**隔离 worktree 数据库里仍带启用调度 trigger 的 **routines（例行任务）**，避免复制的每日/cron routine 在新 workspace instance 里意外触发；不会默认关掉仅 webhook/API 的 routine。

该仓库内 `.env` 还设置：

- `PAPERCLIP_IN_WORKTREE=true`  
- `PAPERCLIP_WORKTREE_NAME=<worktree-name>`  
- `PAPERCLIP_WORKTREE_COLOR=<hex-color>`

服务器/UI 用这些做 worktree 品牌（顶栏横幅、动态 favicon 等）。**authenticated** 的 worktree 服务器还用 `PAPERCLIP_INSTANCE_ID` 限定 Better Auth 的 cookie 名。浏览器 cookie 按 host 共享而非端口，因此可避免登录 `127.0.0.1:<port>` 的一个 worktree 覆盖另一个 worktree 的 session cookie。

需要显式打印 shell export 时：

```sh
paperclipai worktree env
# 或：
eval "$(paperclipai worktree env)"
```

### Worktree CLI 参考（Worktree CLI Reference）

`**pnpm paperclipai worktree init [options]**` — 为当前 worktree 写仓库内 config/env，并创建隔离 instance。


| 选项                       | 说明                                                      |
| ------------------------ | ------------------------------------------------------- |
| `--name <name>`          | 显示名，用于推导 instance id                                    |
| `--instance <id>`        | 显式指定隔离 instance id                                      |
| `--home <path>`          | worktree instance 的 home 根（默认：`~/.paperclip-worktrees`） |
| `--from-config <path>`   | 播种来源 `config.json`                                      |
| `--from-data-dir <path>` | 推导来源 config 时用的来源 `PAPERCLIP_HOME`                      |
| `--from-instance <id>`   | 来源 instance id（默认：`default`）                            |
| `--server-port <port>`   | 首选服务端口                                                  |
| `--db-port <port>`       | 首选嵌入式 Postgres 端口                                       |
| `--seed-mode <mode>`     | 播种配置：`minimal` 或 `full`（默认：`minimal`）                   |
| `--no-seed`              | 跳过从来源 instance 播种数据库                                    |
| `--force`                | 覆盖已有仓库内 config 与隔离 instance 数据                          |


示例：

```sh
paperclipai worktree init --no-seed
paperclipai worktree init --seed-mode full
paperclipai worktree init --from-instance default
paperclipai worktree init --from-data-dir ~/.paperclip
paperclipai worktree init --force
```

修复已创建的、由 repo 管理的 worktree，并从主 default 安装重新播种其隔离 instance。`--from-config` 指向 instance 配置：

```sh
cd /path/to/paperclip/.paperclip/worktrees/PAP-884-ai-commits-component
pnpm paperclipai worktree init --force --seed-mode minimal \
  --name PAP-884-ai-commits-component \
  --from-config ~/.paperclip/instances/default/config.json
```

会重写 worktree 本地 `.paperclip/config.json` + `.paperclip/.env`，在 `~/.paperclip-worktrees/instances/<worktree-id>/` 重建隔离 instance，**git worktree 内容本身保留**。

若 worktree 已存在，你希望 CLI 判断是重建缺失元数据还是仅重播数据库，用 `worktree repair`。

`**pnpm paperclipai worktree repair [options]`** — 默认修复当前已链接 worktree；传 `--branch` 时创建/修复 `.paperclip/worktrees/` 下命名 worktree。**绝不**指向主 checkout，除非显式传 `--branch`。


| 选项                       | 说明                                                         |
| ------------------------ | ---------------------------------------------------------- |
| `--branch <name>`        | 选择已有 branch/worktree 修复，或要在 `.paperclip/worktrees` 下创建的分支名 |
| `--home <path>`          | worktree instance home 根（默认：`~/.paperclip-worktrees`）      |
| `--from-config <path>`   | 播种来源 `config.json`                                         |
| `--from-data-dir <path>` | 推导来源 config 用的来源 `PAPERCLIP_HOME`                          |
| `--from-instance <id>`   | 推导来源 config 的 source instance id（默认：`default`）             |
| `--seed-mode <mode>`     | `minimal` 或 `full`（默认：`minimal`）                           |
| `--no-seed`              | 仅 bootstrap 缺失 worktree 配置时只修元数据、不播种                       |
| `--allow-live-target`    | 覆盖「目标 worktree DB 须先停止」的保护                                 |


示例：

```sh
# 在已链接 worktree 内，重建缺失 .paperclip 元数据并从 default instance 播种。
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree repair

# 在主 checkout，为某 branch 创建或修复 `.paperclip/worktrees/` 下 worktree。
cd /path/to/paperclip
pnpm paperclipai worktree repair --branch PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
```

若只想保留现有仓库内 config/env，**只覆盖**隔离数据库，用 `worktree reseed`。请先停掉目标 worktree 的 Paperclip 服务，以便安全替换 DB。

`**pnpm paperclipai worktree reseed [options]`** — 在保留目标 worktree 当前 config、端口与 instance 身份的前提下，从另一个 Paperclip instance 或 worktree **重新播种**。


| 选项                       | 说明                                     |
| ------------------------ | -------------------------------------- |
| `--from <worktree>`      | 来源：worktree 路径、目录名、branch 名或 `current` |
| `--to <worktree>`        | 目标：同上（默认 `current`）                    |
| `--from-config <path>`   | 播种来源 `config.json`                     |
| `--from-data-dir <path>` | 来源 `PAPERCLIP_HOME`                    |
| `--from-instance <id>`   | 来源 instance id                         |
| `--seed-mode <mode>`     | `minimal` 或 `full`（默认：`full`）          |
| `--yes`                  | 跳过破坏性确认                                |
| `--allow-live-target`    | 覆盖「目标须先停止」保护                           |


示例：

```sh
# 在主仓库，把某 worktree 从当前 default/master instance 重播种。
cd /path/to/paperclip
pnpm paperclipai worktree reseed \
  --from current \
  --to PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat \
  --seed-mode full \
  --yes

# 在 worktree 内，从 default instance 配置重播种。
cd /path/to/paperclip/.paperclip/worktrees/PAP-1132-assistant-ui-pap-1131-make-issues-comments-be-like-a-chat
pnpm paperclipai worktree reseed \
  --from-instance default \
  --seed-mode full
```

`**pnpm paperclipai worktree:make <name> [options]**` — 创建 `~/NAME` 为 git worktree，并在其中初始化隔离 Paperclip instance。等价 `git worktree add` + `worktree init` 一步。


| 选项                       | 说明                                  |
| ------------------------ | ----------------------------------- |
| `--start-point <ref>`    | 新 branch 基于的远端 ref（如 `origin/main`） |
| `--instance <id>`        | 显式 instance id                      |
| `--home <path>`          | worktree instance home 根            |
| `--from-config <path>`   | 播种来源 `config.json`                  |
| `--from-data-dir <path>` | 来源 `PAPERCLIP_HOME`                 |
| `--from-instance <id>`   | 来源 instance id（默认：`default`）        |
| `--server-port <port>`   | 首选服务端口                              |
| `--db-port <port>`       | 首选嵌入式 Postgres 端口                   |
| `--seed-mode <mode>`     | `minimal` 或 `full`（默认：`minimal`）    |
| `--no-seed`              | 不播种                                 |
| `--force`                | 覆盖已有仓库内 config 与隔离数据                |


示例：

```sh
pnpm paperclipai worktree:make paperclip-pr-432
pnpm paperclipai worktree:make my-feature --start-point origin/main
pnpm paperclipai worktree:make experiment --no-seed
```

`**pnpm paperclipai worktree env [options]**` — 打印当前 worktree 本地 instance 的 shell export。


| 选项                    | 说明                      |
| --------------------- | ----------------------- |
| `-c, --config <path>` | 配置文件路径                  |
| `--json`              | 输出 JSON 而非 shell export |


示例：

```sh
paperclipai worktree env
paperclipai worktree env --json
eval "$(pnpm paperclipai worktree env)"
```

对项目执行用 worktree，Paperclip 也可在创建/复用隔离 git worktree 后运行项目定义的 **provision（预置）** 命令。配置在项目 **execution workspace** 策略的 `workspaceStrategy.provisionCommand`。命令在派生 worktree 内执行，并注入 `PAPERCLIP_WORKSPACE_`*、`PAPERCLIP_PROJECT_ID`、`PAPERCLIP_AGENT_ID`、`PAPERCLIP_ISSUE_`* 等环境变量，便于各仓库自举。

## 快速健康检查（Quick Health Checks）

另开终端：

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

预期：

- `/api/health` 返回 `{"status":"ok"}`  
- `/api/companies` 返回 JSON 数组

## 重置本地开发数据库（Reset Local Dev Database）

清空本地开发数据并重来：

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 可选：使用外部 Postgres（Optional: Use External Postgres）

若设置 `DATABASE_URL`，服务器会改用该连接，而不用嵌入式 PostgreSQL。

## 自动数据库备份（Automatic DB Backups）

Paperclip 可按定时器跑自动**逻辑数据库备份**，覆盖非系统 schema、迁移历史与插件 schema。默认：

- 启用  
- 每 60 分钟  
- 保留 30 天  
- 目录：`~/.paperclip/instances/default/data/backups`

配置：

```sh
pnpm paperclipai configure --section database
```

手动一次备份：

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

DB 备份**不是**完整实例文件系统备份。完整本地灾备还需备份本地存储文件与本地加密 secrets 密钥（若启用相关 provider）。

## 开发中的 Secrets（Secrets in Dev）

Agent 环境变量现支持 **secret references（秘钥引用）**。默认秘钥用本地加密存储，持久化的 agent 配置里只留引用。

- 默认本地密钥：`~/.paperclip/instances/default/secrets/master.key`  
- 直接覆盖密钥材料：`PAPERCLIP_SECRETS_MASTER_KEY`  
- 覆盖密钥文件路径：`PAPERCLIP_SECRETS_MASTER_KEY_FILE`  
- 备份需同时备份密钥文件与数据库，缺一不可恢复本地加密 secrets。

**strict mode（严格模式）**（本地受信机以外推荐）：

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

开启后，敏感 env 键（如 `*_API_KEY`、`*_TOKEN`、`*_SECRET`）须用秘钥引用，不能直接内联明文。authenticated 部署默认开启 strict，除非显式覆盖。

CLI 支持：

- `pnpm paperclipai onboard` 写默认 `secrets` 段（`local_encrypted`、strict 关闭、密钥路径），需要时创建密钥文件。  
- `pnpm paperclipai configure --section secrets` 更新 provider/strict/密钥路径并创建密钥文件。  
- `pnpm paperclipai doctor` 校验 secrets adapter，可用 `--repair` 创建缺失本地密钥文件；选 AWS Secrets Manager 时报告缺失的 bootstrap 环境变量。  
- Provider 健康：`GET /api/companies/:companyId/secret-providers/health`，含本地密钥权限告警与备份提示。

各公司的 provider vault 在 Board `Company Settings → Secrets → Provider vaults` 配置，对应 `/api/companies/{companyId}/secret-provider-configs`。CLI 目前不拥有 vault 生命周期；运维模型见 `docs/部署/08 密钥管理 secrets.md` 的 `Provider Vaults` 一节。

内联 env 秘钥迁移辅助：

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # 应用迁移
```

## 公司删除开关（Company Deletion Toggle）

删除 **company** 面向 dev/debug，可在运行时关闭：

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

默认：

- `local_trusted`：启用  
- `authenticated`：禁用

## CLI 控制面操作（CLI Client Operations）

Paperclip CLI 除 setup 命令外，还包含客户端 **control plane（控制面）** 命令。

快速示例：

```sh
pnpm paperclipai issue list --company-id <company-id>
pnpm paperclipai issue create --company-id <company-id> --title "Investigate checkout conflict"
pnpm paperclipai issue update <issue-id> --status in_progress --comment "Started triage"
```

用 **context profile** 设默认上下文，避免重复传 flag：

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
```

之后可直接：

```sh
pnpm paperclipai issue list
pnpm paperclipai dashboard get
```

完整命令表见 `doc/09 命令行 CLI.md`。

## OpenClaw 邀请入驻端点（OpenClaw Invite Onboarding Endpoints）

面向 agent 的邀请入驻暴露机器可读 API：

- `GET /api/invites/:token` — 摘要 + onboarding 与 skills 索引链接  
- `GET /api/invites/:token/onboarding` — onboarding manifest（注册端点、claim 模板、skill 安装提示）  
- `GET /api/invites/:token/onboarding.txt` — 纯文本 onboarding，给人与 agent（llm.txt 风格），含可选邀请者消息与建议的 network host 候选  
- `GET /api/skills/index` — 可用 skill 文档列表（**可能未列全**仓库 `skills/` 下全部技能；完整清单与中文说明见仓库根 `[skills/README.md](../skills/README.md)`）  
- `GET /api/skills/paperclip` — Paperclip heartbeat skill 的 Markdown（其它 `name` 见 `skills/README.md` 与源码白名单）

## OpenClaw Join 冒烟测试（OpenClaw Join Smoke Test）

端到端 OpenClaw join 冒烟：

```sh
pnpm smoke:openclaw-join
```

验证内容：

- 创建仅 agent 加入用 invite  
- 使用 `adapterType=openclaw` 的 agent join 请求  
- board 审批 + 一次性 API key claim 语义  
- 向 docker 化 OpenClaw 风格 webhook 接收器投递 wakeup **callback（回调）**

权限要求：

- 脚本执行受 board 治理的动作（创建 invite、批准 join、唤醒另一 agent）。  
- authenticated 模式下通过 `PAPERCLIP_AUTH_HEADER` 或 `PAPERCLIP_COOKIE` 传 board 身份。

可选鉴权 flag（authenticated）：

- `PAPERCLIP_AUTH_HEADER`（如 `Bearer ...`）  
- `PAPERCLIP_COOKIE`（session cookie header 值）

## OpenClaw Docker UI 一键脚本（OpenClaw Docker UI One-Command Script）

Docker 启动 OpenClaw 并打印主机浏览器 dashboard URL：

```sh
pnpm smoke:openclaw-docker-ui
```

脚本在 `scripts/smoke/openclaw-docker-ui.sh`，自动化基于 Compose 的本地 OpenClaw UI 测试。

该冒烟脚本的配对行为：

- 默认 `OPENCLAW_DISABLE_DEVICE_AUTH=1`（本地 smoke 无需 Control UI 配对提示）  
- 设 `OPENCLAW_DISABLE_DEVICE_AUTH=0` 则要求标准设备配对

模型行为：

- 默认 OpenAI 模型（`openai/gpt-5.2` + OpenAI 回退），默认不要求 Anthropic 认证

状态行为：

- 默认隔离配置目录 `~/.openclaw-paperclip-smoke`  
- 默认每轮重置 smoke agent 状态（`OPENCLAW_RESET_STATE=1`）

网络行为：

- 自动检测并打印 OpenClaw 容器内可达的 Paperclip host URL  
- 容器侧默认 host 别名为 `host.docker.internal`（可用 `PAPERCLIP_HOST_FROM_CONTAINER` / `PAPERCLIP_HOST_PORT` 覆盖）  
- 若 authenticated/private 模式拒绝容器主机名，可 `pnpm paperclipai allowed-hostname host.docker.internal` 并重启 Paperclip

