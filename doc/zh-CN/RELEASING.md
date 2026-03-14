# 释放Paperclip

维护者操作手册，用于跨 npm、GitHub 和面向网站的变更日志表面发布完整的 Paperclip 版本。

发布模型是分支驱动的：

1. 在`release/X.Y.Z`上启动发布列车
2. 起草该分支上的稳定变更日志
3. 从该分支发布一个或多个金丝雀
4. 从同一个分支头发布稳定版
5. 推送分支提交和标签
6. 创建 GitHub 版本
7. 将 `release/X.Y.Z` 合并回 `master`，无需压缩或变基

## 释放表面

每个版本都有四个独立的表面：

1. **验证** — 确切的 git SHA 通过类型检查、测试和构建
2. **npm** — `paperclipai` 和公共工作区包发布
3. **GitHub** — 稳定版本获得 git 标签和 GitHub 版本
4. **网站/公告** — 稳定变更日志对外发布并公布

仅当所有四个表面都被处理时才进行释放。

## 核心不变量

- `X.Y.Z` 的金丝雀和稳定版必须来自同一个 `release/X.Y.Z` 分支。
- 发布脚本必须从匹配的 `release/X.Y.Z` 分支运行。
- 一旦 `vX.Y.Z` 存在于本地、GitHub 或 npm 上，该发布列车就会被冻结。
- 不要将发布分支 PR 压缩合并或变基合并回 `master`。
- 稳定的变更日志始终为 `releases/vX.Y.Z.md`。切勿创建金丝雀变更日志文件。

合并规则的原因很简单：标签必须始终指向确切的已发布提交。挤压或变基会破坏该属性。

## 长篇大论；博士

### 1. 启动发布序列

使用它来计算下一个版本，创建或恢复分支，创建或恢复专用工作树，并将分支推送到 GitHub。

```bash
./scripts/release-start.sh patch
```

该脚本：

- 获取发布遥控器和标签
- 根据最新的 `v*` 标签计算下一个稳定版本
- 创建或恢复`release/X.Y.Z`
- 创建或恢复专用工作树
- 默认情况下将分支推送到远程
- 拒绝重复使用冷冻释放列车

### 2. 起草稳定变更日志

从发布工作树：

```bash
VERSION=X.Y.Z
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

### 3.验证并发布金丝雀

```bash
./scripts/release-preflight.sh canary patch
./scripts/release.sh patch --canary --dry-run
./scripts/release.sh patch --canary
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

用户安装金丝雀：

```bash
npx paperclipai@canary onboard
```

### 4. 发布稳定版

```bash
./scripts/release-preflight.sh stable patch
./scripts/release.sh patch --dry-run
./scripts/release.sh patch
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

然后打开一个从 `release/X.Y.Z` 到 `master` 的 PR，并在不压缩或变基的情况下合并。

## 发布分支

Paperclip 每个目标稳定版本使用一个发布分支：

- `release/0.3.0`
- `release/0.3.1`
- `release/1.0.0`

不要创建单独的每个金丝雀分支，例如 `canary/0.3.0-1`。金丝雀只是同一稳定列车的预发布快照。

## 脚本入口点- [`scripts/release-start.sh`](../scripts/release-start.sh) — 创建或恢复发布列车分支/工作树
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) — 验证分支、版本计划、git/npm 状态和验证门
- [`scripts/release.sh`](../scripts/release.sh) — 从发布分支发布金丝雀或稳定版
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) — 推送标签后创建或更新 GitHub 版本
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) — 将 `latest` 重新指向最后一个良好的稳定版本

## 详细工作流程

### 1. 启动或恢复发布序列

运行：

```bash
./scripts/release-start.sh <patch|minor|major>
```

有用的选项：

```bash
./scripts/release-start.sh patch --dry-run
./scripts/release-start.sh minor --worktree-dir ../paperclip-release-0.4.0
./scripts/release-start.sh patch --no-push
```

该脚本故意是幂等的：

- 如果 `release/X.Y.Z` 本地已存在，则重用它
- 如果远程分支已存在，则会在本地恢复它
- 如果分支已经在另一个工作树中签出，它会将您指向那里
- 如果 `vX.Y.Z` 已存在于本地、远程或 npm 上，则它拒绝重用该列车

### 2. 尽早编写稳定的变更日志

创建或更新：

- `releases/vX.Y.Z.md`

该文件用于最终的稳定版本。文件名或标题中不应包含 `-canary`。

推荐结构：

- `Breaking Changes` 需要时
- `Highlights`
- `Improvements`
- `Fixes`
- `Upgrade Guide` 需要时
- `Contributors` — 通过 GitHub 用户名@提及每个贡献者（无电子邮件）

包级 `CHANGELOG.md` 文件是作为发布机制的一部分生成的。它们不是主要的发布叙述。

### 3. 运行发布预检

从 `release/X.Y.Z` 工作树：

```bash
./scripts/release-preflight.sh canary <patch|minor|major>
# or
./scripts/release-preflight.sh stable <patch|minor|major>
```

现在，预检脚本在运行验证门之前会检查以下所有内容：

- 工作树是干净的，包括未跟踪的文件
- 当前分支与计算出的 `release/X.Y.Z` 匹配
- 释放列车未冻结
- 目标版本在 npm 上仍然免费
- 目标标签在本地或远程尚不存在
- 远程发布分支是否已经存在
- `releases/vX.Y.Z.md`是否存在

然后它运行：

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

### 4. 发布一个或多个金丝雀

运行：

```bash
./scripts/release.sh <patch|minor|major> --canary --dry-run
./scripts/release.sh <patch|minor|major> --canary
```

结果：

- npm 在 dist-tag `canary` 下获得预发布，例如 `1.2.3-canary.0`
- `latest` 不变
- 没有创建 git 标签
- 未创建 GitHub 版本
- 脚本完成后工作树恢复干净

护栏：

- 脚本拒绝从错误的分支运行
- 剧本拒绝在结冰的火车上发布
- 金丝雀始终源自下一个稳定版本
- 如果稳定的注释文件丢失，脚本会在您忘记之前发出警告

具体例子：

- 如果最新的稳定版本是 `0.2.7`，则金丝雀补丁的目标是 `0.2.8-canary.0`
- `0.2.7-canary.N` 无效，因为 `0.2.7` 已经稳定

### 5. 对金丝雀进行烟雾测试

运行Docker中的实际安装路径：

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```有用的孤立变体：

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

如果您想从当前提交的参考而不是 npm 进行入职操作，请使用：

```bash
./scripts/clean-onboard-ref.sh
PAPERCLIP_PORT=3234 ./scripts/clean-onboard-ref.sh
./scripts/clean-onboard-ref.sh HEAD
```

最低限度检查：

- `npx paperclipai@canary onboard` 安装
- 引导完成且没有崩溃
- 服务器启动
- 用户界面加载
- 基本的公司创建和控制台加载工作

如果冒烟测试失败：

1. 停止稳定版本
2. 修复同一`release/X.Y.Z`分支上的问题
3. 发布另一个金丝雀
4. 重新运行冒烟测试

### 6. 从同一发布分支发布稳定版

分支负责人经过审查后，运行：

```bash
./scripts/release.sh <patch|minor|major> --dry-run
./scripts/release.sh <patch|minor|major>
```

稳定发布：

- 在 `latest` 下将 `X.Y.Z` 发布到 npm
- 创建本地发布提交
- 创建本地标签 `vX.Y.Z`

在以下情况下，稳定发布将拒绝继续：

- 当前分支不是 `release/X.Y.Z`
- 远程发布分支尚不存在
- 稳定的注释文件丢失
- 目标标签已存在于本地或远程
- npm 上已经存在稳定版本

这些检查会在稳定发布后故意冻结列车。

### 7. 推送稳定分支提交和标签

稳定发布成功后：

```bash
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

GitHub 发行说明来自：

- `releases/vX.Y.Z.md`

### 8.将release分支合并回`master`

打开 PR：

- 底座：`master`
- 头：`release/X.Y.Z`

合并规则：

- 允许：合并提交或快进
- 禁止：挤压合并
- 禁止：变基合并

合并后验证：

```bash
git fetch public-gh --tags
git merge-base --is-ancestor "vX.Y.Z" "public-gh/master"
```

该命令必须成功。如果失败，则无法从 `master` 到达已发布的标记提交，这意味着合并策略错误。

### 9. 完成外表面

GitHub正确后：

- 在网站上发布变更日志
- 撰写并发送公告副本
- 确保公共文档和安装指南指向稳定版本

## GitHub 行动发布

[`.github/workflows/release.yml`](../.github/workflows/release.yml) 上还有手动工作流程。

从相关 `release/X.Y.Z` 分支的“操作”选项卡中使用它：

1. 选择`Release`
2. 选择`channel`：`canary`或`stable`
3. 选择`bump`：`patch`、`minor` 或`major`
4. 选择是否为`dry_run`
5. 从release分支运行，而不是从`master`运行

工作流程：

- 重新运行 `typecheck`、`test:run` 和 `build`
- 盖茨在 `npm-release` 环境后面发布
- 可以在不接触`latest`的情况下发布金丝雀
- 可以发布稳定版，推送稳定版分支提交和标签，并创建 GitHub 版本

它不会为您将发布分支合并回 `master`。

## 发布清单

### 在任何发布之前- [ ] 发布列车存在于 `release/X.Y.Z`
- [ ] 工作树是干净的，包括未跟踪的文件
- [ ] 如果包清单发生更改，则 CI 拥有的 `pnpm-lock.yaml` 刷新已在火车被切断之前合并到 `master` 上
- [ ] 所需的验证门已通过您要发布的确切分支头
- [ ] 凹凸类型对于用户可见的影响是正确的
- [ ] 稳定的变更日志文件存在或已准备好，位于 `releases/vX.Y.Z.md`
- [ ] 你知道如果需要的话你会回滚到哪个以前的稳定版本

### 在稳定之前

- [ ] 候选人已通过冒烟测试
- [ ] 远程`release/X.Y.Z`分支存在
- [ ] 你准备好在npm发布后立即推送稳定分支提交和标记
- [ ] 推送后即可立即创建 GitHub Release
- [ ] 您已准备好打开PR回`master`

### 稳定后

- [ ] `npm view paperclipai@latest version` 匹配新稳定版本
- [ ] GitHub 上存在 git 标签
- [ ] GitHub 版本存在并使用 `releases/vX.Y.Z.md`
- [ ] `vX.Y.Z` 可从 `master` 访问
- [ ] 网站变更日志已更新
- [ ] 公告副本匹配稳定版本，而不是金丝雀版本

## 失败手册

### 如果金丝雀发布但冒烟测试失败

不要发布稳定版。

相反：

1. 修复`release/X.Y.Z`的问题
2. 发布另一个金丝雀
3. 重新运行冒烟测试

### 如果稳定的 npm 发布成功，但推送或 GitHub 版本创建失败

这是部分版本。 npm 已经上线。

立即执行此操作：

1. 修复同一结帐中的git或GitHub问题
2. 推送稳定分支提交和标签
3. 创建GitHub版本

请勿重新发布相同版本。

### 如果`latest`在稳定发布后被破坏

预览：

```bash
./scripts/rollback-latest.sh X.Y.Z --dry-run
```

回滚：

```bash
./scripts/rollback-latest.sh X.Y.Z
```

这不会取消发布任何内容。它只会将 `latest` dist-tag 移回到最后一个良好的稳定版本。

然后通过新的补丁版本进行修复。

### 如果 GitHub 发行说明有误

重新运行：

```bash
./scripts/create-github-release.sh X.Y.Z
```

如果版本已存在，脚本将更新它。

## 相关文档

- [doc/PUBLISHING.md](PUBLISHING.md) — 低级 npm 构建和打包内部结构
- [技能/发布/SKILL.md](../skills/release/SKILL.md) — 智能体发布协调工作流程
- [skills/release-changelog/SKILL.md](../skills/release-changelog/SKILL.md) — 稳定的变更日志起草工作流程