---
name: paperclip-dev
required: false
description: >
  开发与运维本地 Paperclip 实例——启停服务、同步 master、构建与测试、worktree、数据库备份与排障。
  适用于在本仓库上做 Paperclip 本体开发或保持实例可用。
---

**中文名：** 本地 Paperclip 开发与运维（源码仓库里跑实例）  
**系统 id：** `paperclip-dev`

# 本地 Paperclip 开发与运维

日常围绕「本地 Paperclip 开发与运维」的流程。假定你在 Paperclip 源码仓库，`origin` 指向 `git@github.com:paperclipai/paperclip.git`。

> **开源卫生：**仓库对外公开。视作 **推送到 `origin` 的一切内容都可公开发布**。永远不要提交密钥、令牌、私密日志、个人身份信息、客户数据或只适合本机的配置。也别把试错分支的检查点随意推送到上游。

> **强制：**跑任何 CLI、编译、测试、worktree **之前**必读仓库内 `doc/05 开发指南 DEVELOPING.md`。那是 `paperclipai` CLI 全部子命令与参数、构建/测试、迁移、实例与诊断的**单一权威**。不要去猜命令行参数。

## 常用命令备忘

更全的选项表同样在 `doc/05 开发指南 DEVELOPING.md`。

| 任务 | 命令 |
|------|------|
| 启动服务（首次或日常） | `npx paperclipai run` |
| 开发（受管 runner；Windows 优先一条龙） | `scripts/start-paperclip-dev-external.ps1` 或 `pnpm dev` |
| 停开发服 | `pnpm dev:stop` |
| 构建 | `pnpm build` |
| 类型检查 | `pnpm typecheck` |
| 测试 | `pnpm test` |
| 迁移数据库 | `pnpm db:migrate` |
| 重新生成 Drizzle | `pnpm db:generate` |
| 备份数据库 | `npx paperclipai db:backup` |
| 健康自检/修复建议 | `npx paperclipai doctor --repair` |
| 打印实例环境 | `npx paperclipai env` |
| 触发某智能体心跳 | `npx paperclipai heartbeat run --agent-id <id>` |
| 安装智能体所需本地技能 CLI | `npx paperclipai agent local-cli <agent> --company-id <id>` |

## 从 master 拉取

```bash
git fetch origin && git pull origin master
pnpm install && pnpm build
```

若有 schema PR 并进，补上 `pnpm db:generate && pnpm db:migrate`。

## Worktree（多工作树实例）

Paperclip worktree = git worktree **+** 独立的 Paperclip 实例（端口、嵌入式 DB、环境种子互相隔离）。

> **强制：**建/删/洗 worktree 之前读 `doc/05 开发指南 DEVELOPING.md`「Worktree-local Instances」「Worktree CLI Reference」小节。

### 何时用 worktree

- 某功能分支需要一整套独立 Paperclip；
- 多路 agent 并行但不想弄脏主实例；
- 先在隔离环境合并前验证宿主改动。

### 命令一览

CLI 分两档能力（仍以 `doc/05 开发指南 DEVELOPING.md` 详表为准）：

| 命令 | 用途 |
|---------|--------|
| `worktree:make <name>` | 一步到位建 worktree + 实例 |
| `worktree:list` | 列出 worktrees 与 Paperclip 状态 |
| `worktree:merge-history` | 预览/导入事务历史 |
| `worktree:cleanup <name>` | 删分支、实例与数据 |
| `worktree init` | 已在 git worktree 里时补全引导 |
| `worktree env` | 打印需 `eval` 的 shell 导出 |
| `worktree reseed` | 用另一实例数据库快照刷新 |
| `worktree repair` | 修补损坏或缺失的实例元数据 |

### 典型操作流程

```bash
npx paperclipai worktree:make my-feature --start-point origin/main
cd <worktree-path>
eval "$(npx paperclipai worktree env)"
npx paperclipai run
# ... work ...
npx paperclipai worktree:merge-history --from paperclip-my-feature --to current --apply
npx paperclipai worktree:cleanup my-feature
```

## 优先使用个人 fork —— 推送到你的 fork

若用户配置了个人 fork 远程，应将 feature branches **推到 fork**，避免污染主干 remote 分支列表。

### 辨认 fork remote

```bash
git remote -v
```

若 URL 指向 `github.com:<user>/paperclip`（或 `.git` 形式）且用户名不是组织的默认上游，就把它当 fork。仍指向 `paperclipai/paperclip` 的 `origin/upstream` 是 canonical upstream——**fork 还存在时别把 feature branch 无脑推给它**。

### 推到 fork

```bash
git push -u <fork-remote> HEAD
gh pr create --repo paperclipai/paperclip --head <fork-owner>:<branch-name> ...
```

`gh pr create` 在无上游跟踪分支时常能自动推断 head；不可靠时用显式 `--head owner:branch`。

### 没有 fork

若只看到组织仓库 remote，照旧推 `origin`。**不要在未经用户同意的情形下代建新 fork**。

### 上游同步

upstream 可能被命名为 `origin` 或 `upstream`，需自行判断 fetch 的那份：

```bash
UPSTREAM_REMOTE=$(git remote -v | awk '/paperclipai\/paperclip.*\(fetch\)/{print $1; exit}')
git fetch "$UPSTREAM_REMOTE"
git push <fork-remote> "${UPSTREAM_REMOTE}/master:master"
```

## 合并请求（PR）

> **提交前必读：**任何 `gh pr create` **之前**，必须读过下面三份文件，并逐项对照 PR 正文：

1. `.github/PULL_REQUEST_TEMPLATE.md`
2. `CONTRIBUTING.md`
3. `.github/workflows/pr.yml`

### 正文自检

- `## Thinking Path` — 引用块；5–8 步推演
- `## What Changed` — 具体要点列表
- `## Verification`
- `## Risks`
- `## Model Used`
- `## Checklist`

缺块就不要交 PR。

### 创建 PR

只在上一步完成后提交；不要用随意段落换掉模板结构。

## 硬规则——禁止旁路操作

Agents 曾因 CLI failure 手写 SQL 造成严重事故。**逐字遵守：**

1. **Worktree / 数据库只允许走 CLI。**禁止：
   - 直接调用 `pg_dump`/`psql`/手工 `createdb`…
   - 把某个实例的 `DATABASE_URL` 改成指向隔壁实例嵌入式 DB；
   - 对 `.paperclip`、`.paperclip-worktrees`、`db/` 目录 `rm -rf`；
   - 手写嵌入式 Postgres 目录；乱 kill postgres PID。

2. **CLI 报错就停并报障。**不要做「我以为我能手工替代」：`worktree:make|reseed|init|cleanup…`失败 → 在事务评论中原样贴报错 → `blocked` → 提议 `doctor --repair` 或删了重来。

3. **绝对禁止实例间共用 DB**。每个 worktree embed DB 只属于自己。

4. **在 worktree 起 dev server 必须先 eval env。**正确顺序参见原文档代码块节选（`pnpm install/build`→`paperclipai run`，坏掉就停）。

5. **Seeding/reseed** 只允许通过文档列出的 CLI 指令；禁止 dump 二进制互相拷。

## 常驻开发服务（人工手测）

需要心跳结束之后仍常驻时，必须用 **detach session（`tmux`）**；心跳 shell 的直系子进程会随会话结束而退出。

参见原文命令：`tmux new-session -d -s … 'pnpm dev'`、查看 `capture-pane`、`kill-session`、以及 `curl`/`lsof` 确认端口。**禁止**只靠 `nohup`、`&`。测完关掉会话。

## 常见翻车点

表格（意译）：服务起不来就跑 `doctor --repair`；忘记 source worktree 环境；pull 后未 `pnpm install/build`；schema 脱节；cleanup 前有未推送提交；基准测试打到错误实例端口；CLI 报错还去手搓数据库；心跳短命 dev 服务——改用 tmux；该推 fork 却推组织远程——见上文 Fork 节。

（与英文原版表格逐项语义等价。）
