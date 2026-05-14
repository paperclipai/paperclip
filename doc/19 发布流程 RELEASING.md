# 发布 Paperclip

维护者操作手册，用于通过 npm、GitHub 和面向网站的变更日志（Changelog）渠道发布 Paperclip。

发布模型现已改为提交驱动（commit-driven）：

1. 每次推送到 `master` 分支都会自动发布一个金丝雀版本（Canary）。
2. 稳定版本（Stable）从选定的已测试提交或金丝雀标签中手动提升发布。
3. 稳定版本的发布说明存放在 `releases/vYYYY.MDD.P.md` 中。
4. 只有稳定版本才会创建 GitHub Release。

## 版本号模型

Paperclip 使用符合语义化版本（semver）语法的日历版本号：

- 稳定版：`YYYY.MDD.P`
- 金丝雀版：`YYYY.MDD.P-canary.N`

示例：

- 2026 年 3 月 18 日的第一个稳定版：`2026.318.0`
- 2026 年 3 月 18 日的第二个稳定版：`2026.318.1`
- `2026.318.1` 线的第四个金丝雀版：`2026.318.1-canary.3`

重要约束：

- 中间的数字段为 `MDD`，其中 `M` 是 UTC 月份，`DD` 是零填充的 UTC 日期
- 3 月 3 日应使用 `2026.303.0`，而非 `2026.33.0`
- 不要使用前导零，如 `2026.0318.0`
- 不要使用四个数字段，如 `2026.3.18.1`
- 符合 semver 规范的金丝雀版本格式为 `2026.318.0-canary.1`

## 发布渠道

每个稳定版本都有四个独立的发布渠道：

1. **验证** — 确切的 git SHA 通过类型检查、测试和构建
2. **npm** — 发布 `paperclipai` 和公开的工作区包（Workspace Packages）
3. **GitHub** — 稳定版本获得 git 标签和 GitHub Release
4. **网站/公告** — 稳定版变更日志对外发布并发出公告

只有当所有四个渠道都处理完毕后，稳定版本才算发布完成。

金丝雀版本仅覆盖前两个渠道，外加一个内部可追溯性标签。

## 核心不变量

- 金丝雀版本从 `master` 分支发布
- 稳定版本从明确指定的源引用（Source Ref）发布
- 标签指向原始的源提交，而非生成的发布提交
- 稳定版说明始终为 `releases/vYYYY.MDD.P.md`
- 金丝雀版本永不创建 GitHub Release
- 金丝雀版本永不需要生成变更日志

## 速览

### 金丝雀版本（Canary）

每次推送到 `master` 都会在 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 中运行金丝雀发布流程。

该流程会：

- 验证推送的提交
- 计算当前 UTC 日期对应的金丝雀版本号
- 使用 npm dist-tag `canary` 进行发布
- 验证 `canary` 解析到刚刚发布的版本，且已发布的内部依赖在 npm 上存在
- 如果 npm 将 `latest` 指向了金丝雀版本，默认会失败；仅当该状态是有意为之时才使用 `--allow-canary-latest`
- 创建 git 标签 `canary/vYYYY.MDD.P-canary.N`

用户通过以下命令安装金丝雀版本：

```bash
npx paperclipai@canary onboard
# 或
npx paperclipai@canary onboard --data-dir "$(mktemp -d /tmp/paperclip-canary.XXXXXX)"
```

### 稳定版本（Stable）

在 Actions 标签页中使用 [`.github/workflows/release.yml`](../.github/workflows/release.yml)，通过手动 `workflow_dispatch` 输入参数触发。

[点击此处运行 Action](https://github.com/paperclipai/paperclip/actions/workflows/release.yml)

输入参数：

- `source_ref`
  - 提交 SHA、分支或标签
- `stable_date`
  - 可选的 UTC 日期覆盖，格式为 `YYYY-MM-DD`
  - 输入日期如 `2026-03-18`，而非版本号如 `2026.318.0`
- `dry_run`
  - 为 true 时仅预览

运行稳定版发布前：

1. 选择你信任的金丝雀提交或标签
2. 通过 `./scripts/release.sh stable --date "$(date +%F)" --print-version` 解析目标稳定版本号
3. 在该源引用上创建或更新 `releases/vYYYY.MDD.P.md`
4. 从该源引用运行稳定版工作流

示例：

- `source_ref`：`master`
- `stable_date`：`2026-03-18`
- 生成的稳定版本号：`2026.318.0`

该工作流会：

- 重新验证确切的源引用
- 计算所选 UTC 日期的下一个稳定版补丁位（Patch Slot）
- 使用 npm dist-tag `latest` 发布 `YYYY.MDD.P`
- 创建 git 标签 `vYYYY.MDD.P`
- 根据 `releases/vYYYY.MDD.P.md` 创建或更新 GitHub Release

## 本地命令

### 本地预览金丝雀版本

```bash
./scripts/release.sh canary --dry-run
```

### 本地预览稳定版本

```bash
./scripts/release.sh stable --dry-run
```

### 本地发布稳定版本

此方式主要用于紧急/手动场景。常规路径应使用 GitHub 工作流。

```bash
./scripts/release.sh stable
git push public-gh refs/tags/vYYYY.MDD.P
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P
```

## 稳定版变更日志工作流

稳定版变更日志文件存放于：

- `releases/vYYYY.MDD.P.md`

金丝雀版本没有变更日志文件。

推荐的本地生成流程：

```bash
VERSION="$(./scripts/release.sh stable --date 2026-03-18 --print-version)"
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

仓库有意不通过 GitHub Actions 运行此流程，原因如下：

- 金丝雀版本发布过于频繁
- 稳定版说明是唯一需要 LLM 辅助的公开叙述性渠道
- 维护者的 LLM 令牌不应存放在 Actions 中

## 冒烟测试（Smoke Testing）

金丝雀版本：

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

当前稳定版：

```bash
PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

实用的隔离变体：

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

自动化浏览器冒烟测试也可用：

```bash
gh workflow run release-smoke.yml -f paperclip_version=canary
gh workflow run release-smoke.yml -f paperclip_version=latest
```

最低检查项：

- `npx paperclipai@canary onboard` 安装成功
- 引导流程（Onboarding）无崩溃地完成
- 使用冒烟测试凭据进行身份验证登录正常
- 浏览器在全新实例上进入引导流程
- 公司创建成功
- 第一个 CEO 代理（Agent）被创建
- 第一次 CEO 心跳运行被触发

## 回滚（Rollback）

回滚不会取消已发布的版本。

它仅将 `latest` dist-tag 移回之前的稳定版本：

```bash
./scripts/rollback-latest.sh 2026.318.0 --dry-run
./scripts/rollback-latest.sh 2026.318.0
```

然后通过新的稳定版补丁位或发布日期进行正向修复。

## 故障应对手册

### 如果金丝雀版本发布成功但冒烟测试失败

不要运行稳定版发布。

而是：

1. 在 `master` 上修复问题
2. 合并修复
3. 等待下一个自动金丝雀版本
4. 重新运行冒烟测试

### 如果稳定版 npm 发布成功但标签推送或 GitHub Release 创建失败

这属于部分发布。npm 已经上线。

请立即执行：

1. 推送缺失的标签
2. 重新运行 `PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P`
3. 验证 GitHub Release 说明指向 `releases/vYYYY.MDD.P.md`

不要重新发布相同的版本。

### 如果稳定版发布后 `latest` 损坏

回滚 dist-tag：

```bash
./scripts/rollback-latest.sh YYYY.MDD.P
```

然后通过新的稳定版发布进行正向修复。

## 相关文件

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
