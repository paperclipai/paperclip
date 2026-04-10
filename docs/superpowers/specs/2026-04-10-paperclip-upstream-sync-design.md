# Paperclip 中文企业版自动升级 PR 机制设计

## 背景

当前 `zh-enterprise` 已经承载了 Paperclip 的中文企业版改造，但升级上游版本仍然依赖人工执行。目标不是做“无人值守自动发版”，而是把升级过程做成类似 `n8n-i18n-chinese` 的节奏：**上游一更新，我们的 fork 很快自动生成一个可审、可测、可合并的升级 PR**。

和 n8n 不同，Paperclip 中文企业版并不只是语言包覆盖，还包含：

- UI copy/helper 与 locale runtime
- CLI / server 用户可见文案
- adapter 执行期 locale 透传
- transcript / run output 的安全显示层本地化

因此本项目不能直接复制“语言包 + 小 patch + 重编译产物”的模型，而应采用 **上游检测 + 自动重放提交栈 + 差量中文补齐 + 自动开 PR** 的方案。

## 目标

1. 自动检测 `paperclipai/paperclip` 上游新版本或新提交。
2. 在用户自己的 GitHub fork 中自动创建升级分支。
3. 在升级分支上自动重放 `zh-enterprise` 的中文企业版改造。
4. 自动运行现有校验流程，确保 PR 可审阅。
5. 对低风险新增英文文案自动补中文，对高风险文案给出人工复核清单。
6. 自动创建指向 `zh-enterprise` 的升级 PR。

## 非目标

1. 不自动直接 push `zh-enterprise`。
2. 不自动发布 Docker 镜像、tag 或 GitHub Release。
3. 不追求 100% 无人干预完成升级。
4. 不把 Paperclip 改造成纯语言包仓模式。

## 当前基线

- 官方仓库：`paperclipai/paperclip`
- 用户维护分支：`zh-enterprise`
- 当前中文企业版提交栈已经被整理为清晰的四个 commit：
  1. locale/runtime 基础设施
  2. 核心工作流 UI 汉化
  3. Agent / Runs / transcript 汉化
  4. locale 向 adapter runs 传播
- 仓库已经具备以下校验命令：
  - `pnpm --filter @paperclipai/ui typecheck`
  - `pnpm --filter @paperclipai/server typecheck`
  - `pnpm check:i18n`

## 选定方案

采用 **自动检测上游新版本并自动生成升级 PR** 方案。

该方案保留 n8n 项目的两个核心优点：

1. 用自动化持续跟踪上游版本。
2. 用“薄覆盖层”思路控制改动面。

同时避免直接套用 n8n 的两个不适合点：

1. 不把全部中文能力塞进单一语言包。
2. 不让机器人直接产生面向用户的发布产物。

## 仓库与分支模型

### GitHub 仓库

- `upstream`：`paperclipai/paperclip`
- `origin`：用户自己的 fork

### 分支职责

- `master`
  - 尽量贴近上游主线
  - 作为自动升级的基准参考之一
- `zh-enterprise`
  - 长期维护的中文企业版主分支
  - 只接受人工审核后的 PR 合并
- `bot-upgrade/<version-or-sha>`
  - 机器人临时升级分支
  - 只用于承载一次自动升级尝试

### 权限原则

- 机器人允许：
  - fetch `upstream`
  - push `bot-upgrade/*`
  - 创建 PR
  - 上传诊断 artifact
- 机器人禁止：
  - 直接 push `zh-enterprise`
  - 直接打 release tag
  - 直接创建用户可消费的正式发布

## 自动化架构

整体拆成两条 workflow：

1. **发现并开 PR**
2. **升级 PR 校验**

### 1. 发现并开 PR

建议文件：`.github/workflows/upstream-sync.yml`

触发方式：

- `schedule`
- `workflow_dispatch`

主要步骤：

1. checkout 用户 fork
2. 配置 `upstream` remote
3. fetch `upstream/master` 与 `origin/zh-enterprise`
4. 解析“待处理的最新 upstream 版本”
   - 初始实现使用 `upstream/master` 最新 SHA
   - 后续可增加“跟 release tag 对齐”的模式
5. 判断该版本是否已处理过
   - 若已存在对应 PR、标签或状态记录，则退出
6. 创建 `bot-upgrade/<short-sha-or-tag>` 分支
7. 基于最新 `upstream/master` 重放 `zh-enterprise` 提交栈
8. 运行中文差量补齐
9. 运行校验命令
10. 推送机器人分支并创建 PR 到 `zh-enterprise`

### 2. 升级 PR 校验

建议文件：`.github/workflows/upstream-sync-pr.yml`

触发方式：

- `pull_request`，目标分支为 `zh-enterprise`
- 限定来源分支匹配 `bot-upgrade/*`

主要步骤：

1. 安装依赖
2. 运行：
   - `pnpm --filter @paperclipai/ui typecheck`
   - `pnpm --filter @paperclipai/server typecheck`
   - `pnpm check:i18n`
3. 收集差量中文补齐报告
4. 上传冲突摘要、校验日志、扫描报告作为 artifact

## 升级算法

### 提交栈重放方式

采用 **从 `zh-enterprise` 自动提取自上次同步以来的维护提交，并按顺序 cherry-pick 到最新 upstream 基线** 的方式。

算法：

1. 计算 `merge-base(upstream/master, zh-enterprise)`
2. 用 `git rev-list --reverse <merge-base>..origin/zh-enterprise` 取出维护提交栈
3. 从最新 `upstream/master` 创建 `bot-upgrade/*`
4. 按顺序 cherry-pick 这些提交

这样做的原因：

- 不会改写 `zh-enterprise`
- 不依赖手工维护 commit SHA 列表
- 与当前已经整理出的提交栈兼容
- 一旦上游改动导致冲突，容易定位到具体 commit 和具体层级

### 冲突处理

若 cherry-pick 过程冲突：

1. workflow 立即停止
2. 收集：
   - 冲突文件列表
   - 当前 `git status`
   - 失败的 commit SHA
3. 创建失败 issue 或工作流总结
4. 上传完整诊断 artifact
5. 不创建“看起来成功但实际上未完成”的 PR

## 差量中文补齐策略

自动补齐分三层：

### 低风险层：允许自动补齐

适用对象：

- `ui/src/lib/*copy*.ts`
- 文档中文页
- 已集中管理的 locale helper / 文案表

处理方式：

1. 扫描英文新增 key 或英文值变更
2. 自动生成中文候选
3. 写回对应资源文件
4. 在 PR 中列出自动补齐项

### 中风险层：允许生成候选补丁

适用对象：

- 页面级 helper 接线
- adapter display copy
- 安全文案格式化器

处理方式：

1. 只在已有模式内追加 key 或规则
2. 如果无法确定落点，则不自动改代码
3. 记录为人工复核项

### 高风险层：只提醒，不盲翻

适用对象：

- server runtime 行为文案
- adapter 执行逻辑
- transcript / tool output 的模式识别规则
- 非集中资源的散落英文

处理方式：

1. 扫描新增英文或失败的 `check:i18n`
2. 在 PR 描述中列出“需人工复核”
3. 不自动做可能影响逻辑的文本替换

核心原则是：**低风险自动补，高风险自动提醒。**

## 版本去重与状态记录

为避免重复开 PR，需要一个可机器读取的状态记录。

初始实现建议优先使用最轻量方案：

- 通过 PR 标题或分支名记录已处理版本，例如：
  - `bot-upgrade/2026-04-10-<sha>`
- workflow 查询当前 open / merged PR
- 如果相同 upstream SHA 已有 PR，则退出

如果后续需要更强状态管理，再增加一个专用状态文件，例如：

- `.github/upstream-sync-state.json`

但初版不引入额外持久化文件。

## PR 规范

自动创建的 PR 应至少包含：

- 上游基线 SHA 或 tag
- 自动重放结果
- 是否发生冲突
- 自动补齐的中文文件列表
- `check:i18n` 结果摘要
- 人工复核清单

PR 默认设为非自动合并，由维护者手动审查和 merge。

## Secrets 与配置

必需：

- `GITHUB_TOKEN` 或等价 repo 写权限 token

可选：

- LLM API key，用于低风险差量中文补齐
- 通知 webhook，用于把失败结果推送到飞书或邮件

如果没有 LLM key，流程仍应继续，只是跳过“自动补齐中文”，改为只生成缺失清单。

## 失败处理

任何失败都必须显式暴露，不能静默退出。

失败场景包括：

- fetch upstream 失败
- cherry-pick 冲突
- 依赖安装失败
- typecheck 失败
- `check:i18n` 失败

统一处理方式：

1. 在 workflow summary 中输出摘要
2. 上传诊断 artifact
3. 可选创建 issue 或通知
4. 不修改 `zh-enterprise`

## 成功标准

这套机制上线后，成功标准定义为：

1. upstream 出现新版本或新提交后，24 小时内自动出现升级 PR。
2. 升级 PR 必须通过：
   - `pnpm --filter @paperclipai/ui typecheck`
   - `pnpm --filter @paperclipai/server typecheck`
   - `pnpm check:i18n`
3. 自动补齐的中文内容必须和人工复核清单同时出现在 PR 中。
4. 任何失败都能定位到具体 commit、具体文件和具体步骤。

## 为什么不直接复制 n8n 方案

`n8n-i18n-chinese` 的成功前提是：

- 上游已有稳定 i18n 入口
- 汉化层主要是语言包
- patch 面很薄
- 产物是 editor-ui 构建输出

Paperclip 当前不满足这些前提。若强行复制，会带来两个问题：

1. 中文改动被压成不透明 patch，冲突时难定位
2. adapter / server / transcript 这类逻辑相关本地化会被过度自动化

因此本设计选择学习它的“节奏与机制”，而不是复制它的“实现形态”。

## 结论

Paperclip 中文企业版应采用：

**fork 内自动检测 upstream 更新 → 机器人重放 `zh-enterprise` 提交栈 → 差量补齐低风险中文 → 自动创建升级 PR 到 `zh-enterprise` → 人工审核合并**

这套设计既能接近 n8n 的及时更新体验，又能保留 Paperclip 当前多层本地化架构所需的工程安全边界。
