# 发布自动化与版本号简化计划

## 背景

Paperclip 当前的发布流程记录在 `doc/RELEASING.md` 中，并通过以下内容实现：

- `.github/workflows/release.yml`
- `scripts/release-lib.sh`
- `scripts/release-start.sh`
- `scripts/release-preflight.sh`
- `scripts/release.sh`
- `scripts/create-github-release.sh`

目前的模式是：

1. 选择 `patch`、`minor` 或 `major`
2. 创建 `release/X.Y.Z`
3. 起草 `releases/vX.Y.Z.md`
4. 从该发布分支发布一个或多个 canary
5. 从同一分支发布稳定版
6. 推送标签 + 创建 GitHub Release
7. 将发布分支合并回 `master`

这是可行的，但恰好在应该低成本的地方造成了摩擦：

- 决定 `patch` vs `minor` vs `major`
- 切出和维护发布分支
- 手动发布 canary
- 考虑 canary 的变更日志生成
- 在公开仓库中安全处理 npm 凭证

本次讨论的目标状态更简单：

- 每次推送到 `master` 自动发布 canary
- 稳定版从经过验证的提交中刻意升级
- 版本号基于日期而非语义
- 即使在公开开源仓库中，稳定版发布也是安全的
- 变更日志生成仅在真正的稳定版发布时进行

## 一句话建议

将 Paperclip 迁移到 semver 兼容的日历版本号，从 `master` 自动发布 canary，从选定的经过测试的提交升级稳定版，并使用 npm 可信发布加 GitHub environments，这样就不需要长期有效的 npm 或 LLM token 存在于 Actions 中。

## 核心决策

### 1. 使用日历版本号，但保持 semver 语法

仓库和 npm 工具在许多地方仍假设 semver 形状的版本字符串。这并不意味着 Paperclip 必须保留 semver 作为产品策略。它确实意味着版本格式应保持 semver 有效。

推荐格式：

- 稳定版：`YYYY.MDD.P`
- canary：`YYYY.MDD.P-canary.N`

示例：

- 2026 年 3 月 17 日的第一个稳定版：`2026.317.0`
- `2026.317.0` 线上的第三个 canary：`2026.317.0-canary.2`

为什么使用此形态：

- 消除了 `patch/minor/major` 决策
- 是有效的 semver 语法
- 与 npm、dist-tag 和现有 semver 验证器兼容
- 接近你实际想要的格式

重要约束：

- 中间数字槽应为 `MDD`，其中 `M` 是月份，`DD` 是零填充的日期
- `2026.03.17` 不是要用的格式
  - 数字 semver 标识符不允许前导零
- `2026.3.17.1` 不是要用的格式
  - semver 有三个数字分量，不是四个
- 实用的 semver 安全等价物是 `2026.317.0-canary.8`

这实际上是在 semver 轨道上的 CalVer。

### 2. 接受 CalVer 改变了兼容性契约

这在精神上不再是 semver。它只在语法上是 semver。

对 Paperclip 来说这个权衡可能是可接受的，但应该明确：

- 消费者不再从 `major/minor/patch` 推断兼容性
- 发布说明成为兼容性信号
- 下游用户应优先使用精确版本固定或刻意升级

这对公共库包如 `@paperclipai/shared`、`@paperclipai/db` 和适配器包尤其相关。

### 3. 正常发布取消发布分支

如果每次合并到 `master` 都发布 canary，当前的 `release/X.Y.Z` 列车模式就变得仪式多于价值。

推荐替代方案：

- `master` 是唯一的 canary 列车
- 每次推送到 `master` 都可以发布 canary
- 稳定版从 `master` 上选定的提交或 canary 标签发布

这与你实际想要的工作流匹配：

- 持续合并
- 让 npm 始终有新鲜的 canary
- 后续选择一个已知良好的 canary 并将该提交升级为稳定版

### 4. 通过源码引用升级，而非"重命名" canary

这是最重要的机械约束。

npm 可以移动 dist-tag，但不允许重命名已发布的版本。这意味着：

- 你可以将 `latest` 移到 `paperclipai@1.2.3`
- 你不能将 `paperclipai@2026.317.0-canary.8` 变成 `paperclipai@2026.317.0`

所以"将 canary 升级为稳定版"实际上意味着：

1. 选择你信任的提交或 canary 标签
2. 从该精确提交重新构建
3. 用稳定版版本字符串再次发布

因此，稳定版工作流应接受源码引用，而不仅仅是 bump 类型。

推荐的稳定版输入：

- `source_ref`
  - 提交 SHA，或
  - canary git 标签，如 `canary/v2026.317.1-canary.8`

### 5. 只有稳定版获得发布说明、标签和 GitHub Release

canary 应保持轻量：

- 发布到 npm 的 `canary` 下
- 可选地创建轻量或注释 git 标签
- 不创建 GitHub Release
- 不需要 `releases/v*.md`
- 不消耗 LLM token

稳定版应保持为公共叙事界面：

- git 标签 `v2026.317.0`
- GitHub Release `v2026.317.0`
- 稳定版变更日志文件 `releases/v2026.317.0.md`

## 安全模型

### 建议

使用 npm 可信发布配合 GitHub Actions OIDC，然后禁用包的基于 token 的发布访问。

原因：

- 仓库或组织密钥中没有长期有效的 `NPM_TOKEN`
- Actions 中没有个人 npm token
- 仅在授权工作流中铸造短期凭证
- 公共仓库中的公共包自动获得 npm 出处

这是对开放仓库安全担忧的最干净回答。

### 具体控制

#### 1. 使用一个发布工作流文件

canary 和稳定版发布都使用一个工作流文件名：

- `.github/workflows/release.yml`

原因：

- npm 可信发布按工作流文件名配置
- npm 当前每个包只允许一个可信发布者配置
- GitHub environments 仍可在同一工作流内提供不同的 canary/稳定版审批规则

#### 2. 使用不同的 GitHub environments

推荐的 environments：

- `npm-canary`
- `npm-stable`

推荐策略：

- `npm-canary`
  - 允许分支：`master`
  - 不需要人工审核
- `npm-stable`
  - 允许分支：`master`
  - 启用必需审核者
  - 启用防止自我审核
  - 禁用管理员绕过

即使工作流是手动分发的，稳定版也应需要明确的第二人工门禁。

#### 3. 锁定工作流编辑

为以下路径添加或加强 `CODEOWNERS` 覆盖：

- `.github/workflows/*`
- `scripts/release*`
- `doc/RELEASING.md`

这很重要，因为可信发布授权了一个工作流文件。最大的剩余风险不是从 fork 中泄露密钥。而是对发布工作流本身的维护者批准的更改。

#### 4. OIDC 生效后移除传统 npm token 访问

可信发布验证后：

- 设置包发布访问为需要 2FA 且不允许 token
- 撤销任何遗留的自动化 token

这消除了"某人窃取了 npm token"这一类失败。

### 不应做的

- 不要将你的个人 Claude 或 npm token 放在 GitHub Actions 中
- 不要从 `pull_request_target` 运行发布逻辑
- 如果 OIDC 可以处理，不要让稳定版发布依赖仓库密钥
- 不要创建 canary GitHub Release

## 变更日志策略

### 建议

仅生成稳定版变更日志，目前将 LLM 辅助的变更日志生成排除在 CI 之外。

原因：

- canary 发生得太频繁
- canary 不需要精致的公开说明
- 将个人 Claude token 放入 Actions 不值得冒险
- 稳定版发布频率足够低，人在环中的步骤是可接受的

推荐的稳定版路径：

1. 选择一个 canary 提交或标签
2. 从可信机器本地运行变更日志生成
3. 提交 `releases/vYYYY.MDD.P.md`
4. 运行稳定版升级

如果说明还没准备好，回退是可接受的：

- 发布稳定版
- 创建最小化的 GitHub Release
- 之后立即更新 `releases/vYYYY.MDD.P.md`

但更好的稳态是在稳定版发布前提交稳定版说明。

### 未来选项

如果后续想要 CI 辅助的变更日志起草，可以用：

- 专用服务账号
- 仅限变更日志生成的范围 token
- 手动工作流
- 带必需审核者的专用 environment

这是第二阶段加固工作，不是第一阶段需求。

## 建议的未来工作流

### canary 工作流

触发器：

- `push` 到 `master`

步骤：

1. 检出合并的 `master` 提交
2. 在该精确提交上运行验证
3. 为当前 UTC 日期计算 canary 版本
4. 将公共包版本设为 `YYYY.MDD.P-canary.N`
5. 发布到 npm 的 `canary` dist-tag
6. 创建 canary git 标签用于可追溯性

推荐的 canary 标签格式：

- `canary/v2026.317.1-canary.4`

输出：

- npm canary 已发布
- git 标签已创建
- 无 GitHub Release
- 不需要变更日志文件

### 稳定版工作流

触发器：

- `workflow_dispatch`

输入：

- `source_ref`
- 可选 `stable_date`
- `dry_run`

步骤：

1. 检出 `source_ref`
2. 在该精确提交上运行验证
3. 为 UTC 日期或提供的覆盖值计算下一个稳定版补丁槽
4. 如果 `vYYYY.MDD.P` 已存在则失败
5. 要求 `releases/vYYYY.MDD.P.md`
6. 将公共包版本设为 `YYYY.MDD.P`
7. 发布到 npm 的 `latest`
8. 创建 git 标签 `vYYYY.MDD.P`
9. 推送标签
10. 从 `releases/vYYYY.MDD.P.md` 创建 GitHub Release

输出：

- 稳定版 npm 发布
- 稳定版 git 标签
- GitHub Release
- 干净的公开变更日志界面

## 实现指南

### 1. 用显式版本计算替换 bump 类型版本数学

当前发布脚本依赖：

- `patch`
- `minor`
- `major`

该逻辑应替换为：

- `compute_canary_version_for_date`
- `compute_stable_version_for_date`

例如：

- `next_stable_version(2026-03-17) -> 2026.317.0`
- `next_canary_for_utc_date(2026-03-17) -> 2026.317.0-canary.0`

### 2. 停止要求 `release/X.Y.Z`

这些当前不变量应从正常路径中移除：

- "必须从分支 `release/X.Y.Z` 运行"
- "`X.Y.Z` 的稳定版和 canary 来自同一发布分支"
- `release-start.sh`

替换为：

- canary 必须从 `master` 运行
- 稳定版可以从固定的 `source_ref` 运行

### 3. 仅在 Changesets 仍有帮助时保留

当前系统使用 Changesets 来：

- 重写包版本
- 维护包级 `CHANGELOG.md` 文件
- 发布包

使用 CalVer 后，Changesets 可能仍对发布编排有用，但不应再拥有版本选择。

推荐实现顺序：

1. 如果 `changeset publish` 与显式设置的版本配合工作则保留
2. 用一个小型显式版本脚本替换版本计算
3. 如果 Changesets 持续与模型冲突，则将其从发布发布中完全移除

Paperclip 的发布问题现在是"以一个显式版本发布整个固定包集"，而非"从人类意图推导下一个语义 bump"。

### 4. 添加专用版本脚本

推荐新脚本：

- `scripts/set-release-version.mjs`

职责：

- 在所有公共可发布包中设置版本
- 更新发布所需的任何内部精确版本引用
- 更新 CLI 版本字符串
- 避免跨无关文件的广泛字符串替换

这比保留面向 bump 的 changeset 流程然后强制其进入基于日期的方案更安全。

### 5. 保留基于 dist-tag 的回滚

`rollback-latest.sh` 应保留，但应停止假设超出语法之外的 semver 含义。

它应继续：

- 将 `latest` 重新指向先前的稳定版
- 绝不取消发布

## 权衡和风险

### 1. 稳定版补丁槽现在是版本契约的一部分

使用 `YYYY.MDD.P` 时，同日热修复是支持的，但稳定版补丁槽现在是可见版本格式的一部分。

这是正确的权衡，因为：

1. npm 仍获得 semver 有效的版本
2. 同日热修复仍然可能
3. 只要日期在 `MDD` 内零填充，时间顺序排序仍然有效

### 2. 公共包消费者失去 semver 意图信号

这是 CalVer 的主要缺点。

如果这成为问题，一个替代方案是：

- 仅对 CLI 包使用 CalVer
- 对库包保持 semver

这在运营上更复杂，所以除非包消费者确实需要，我不会从那里开始。

### 3. 自动 canary 意味着更多发布流量

每次 `master` 合并都发布意味着：

- 更多 npm 版本
- 更多 git 标签
- 更多注册表噪音

如果 canary 保持明确分离，这是可接受的：

- npm dist-tag `canary`
- 无 GitHub Release
- 无外部公告

## 上线计划

### 阶段 1：安全基础

1. 创建 `release.yml`
2. 为所有公共包配置 npm 可信发布者
3. 创建 `npm-canary` 和 `npm-stable` environments
4. 为发布文件添加 `CODEOWNERS` 保护
5. 验证 OIDC 发布是否工作
6. 禁用基于 token 的发布访问并撤销旧 token

### 阶段 2：canary 自动化

1. 在 `push` 到 `master` 时添加 canary 工作流
2. 添加显式的日历版本计算
3. 添加 canary git 标签
4. 从 canary 中移除变更日志要求
5. 更新 `doc/RELEASING.md`

### 阶段 3：稳定版升级

1. 添加带 `source_ref` 的手动稳定版工作流
2. 要求稳定版说明文件
3. 发布稳定版 + 标签 + GitHub Release
4. 更新回滚文档和脚本
5. 退役发布分支假设

### 阶段 4：清理

1. 从主路径中移除 `release-start.sh`
2. 从维护者文档中移除 `patch/minor/major`
3. 决定是否从发布中保留或移除 Changesets
4. 公开文档化 CalVer 兼容性契约

## 具体建议

Paperclip 应采用此模型：

- 稳定版版本：`YYYY.MDD.P`
- canary 版本：`YYYY.MDD.P-canary.N`
- canary 在每次推送到 `master` 时自动发布
- 稳定版从选定的经过测试的提交或 canary 标签手动升级
- 默认路径无发布分支
- 无 canary 变更日志文件
- 无 canary GitHub Release
- GitHub Actions 中无 Claude token
- GitHub Actions 中无 npm 自动化 token
- npm 可信发布加 GitHub environments 用于发布安全

这摆脱了 semver 的烦人部分而不与 npm 对抗，使 canary 低成本，保持稳定版刻意为之，并实质性改善了公开仓库的安全态势。

## 外部参考

- npm 可信发布：https://docs.npmjs.com/trusted-publishers/
- npm dist-tag：https://docs.npmjs.com/adding-dist-tags-to-packages/
- npm 语义版本指南：https://docs.npmjs.com/about-semantic-versioning/
- GitHub environments 和部署保护规则：https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- GitHub fork 的密钥行为：https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
