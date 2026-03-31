# Paperclip CN 上游同步 Runbook

## 1. 目的

这份 runbook 用来指导 Paperclip CN 从上游 `paperclipai/paperclip` 同步代码，并在同步过程中保住三类长期差异：

- Paperclip CN 品牌边界
- UI 本地化与 locale 基础设施
- Windows 兼容层

目标不是“零冲突”，而是把同步工作收敛为一套稳定、可复盘、可 review 的流程。

## 2. 开始前必读

每次同步前至少先读：

1. `AGENTS.md`
2. `doc/DEVELOPING.md`
3. `doc/UI-LOCALIZATION.md`
4. `doc/UPSTREAM-MERGE-RUNBOOK.md`

如果本次同步涉及 schema、shared contract、server 行为，额外再读：

1. `doc/SPEC-implementation.md`
2. `doc/DATABASE.md`

## 3. 先确认远端角色

不要先假设谁是 `origin`、谁是 `upstream`。先看实际配置：

```sh
git remote -v
```

同步时只关心三个角色：

- `upstream remote`
  - 原始 Paperclip 仓库
- `fork remote`
  - Paperclip CN 自己的仓库
- `base branch`
  - Paperclip CN 最终要合回去的目标分支，通常是 `master`

常见布局：

- 布局 A
  - `origin` = 上游
  - `private` = Paperclip CN fork
- 布局 B
  - `origin` = Paperclip CN fork
  - `upstream` = 上游

后面所有命令都要先映射到这三个角色，不要机械照抄 remote 名。

## 4. 固定规则

### 4.1 分支规则

上游同步必须在工作分支上完成，不允许直接留在 `master`：

- 工作分支命名：`codex/upstream-sync-YYYYMMDD`
- 安全分支命名：`codex/upstream-sync-YYYYMMDD-safety`
- 不要在本地 `master` 上做 merge、冲突解决、提交和推送
- 最终必须推送工作分支，并通过 PR 合回 Paperclip CN 的 `master`

### 4.2 同步策略

长期 fork 默认使用 merge，不默认使用 rebase：

```sh
git merge origin/master
```

如果你的仓库布局里 `upstream/master` 才代表真正上游，就替换成：

```sh
git merge upstream/master
```

默认偏向 merge 的原因只有一个：它更适合把“这是一轮上游同步”保留成清晰历史。

### 4.3 长期保留差异

#### 品牌边界

用户可见层保留：

- `Paperclip CN`
- `penclipai`
- `penclip.ing`
- `paperclipai.cn`

技术标识继续保留：

- `paperclip-cn`
- `@penclipai/*`
- `penclipai`
- `penclip`
- `PAPERCLIP_*`

#### 本地化基础设施

这些能力不能被同步冲掉：

- `react-i18next` / `i18next` 根层接入
- `ui/src/i18n.ts`
- `ui/public/locales/zh-CN/common.json`
- `ui/public/locales/en/common.json`
- 默认 `zh-CN`
- 语言切换器
- `Accept-Language` / `Content-Language`
- `Vary: Accept-Language`
- 服务端首屏 `html lang` / locale source 注入
- 服务端用户可见错误的 locale 处理

#### Windows 兼容层

这些改造不能被误回退：

- 用 Node 脚本替代 Unix-only shell 片段
- `dev/build` 链路中的 Windows 兼容处理
- `tsx` / dev watch 相关兼容修复

### 4.4 范围基线

上游同步 PR 的默认范围只包含三类改动：

- 拉取并合并上游 `master`
- 补齐或修正 Paperclip CN 的 UI 本地化
- 为了让这次同步结果可用、可验证、可合并而必须做的小修复

不要顺手加入无关重构、样式调整或额外功能。必须修问题时，优先在本次已触及的文件或路径里做最小补丁，避免扩大后续冲突面。

## 5. 标准流程

### 5.1 准备

先确认工作区干净，再抓取相关 remote：

```sh
git status --short
git fetch origin --prune
git fetch private --prune
git fetch upstream --prune
```

如果某个 remote 不存在，就删掉对应命令，不要补脑。

### 5.2 建立工作分支

从 Paperclip CN 当前目标基线切出工作分支和安全分支：

```sh
git checkout master
git pull --ff-only
git checkout -b codex/upstream-sync-YYYYMMDD
git branch codex/upstream-sync-YYYYMMDD-safety
```

### 5.3 先和 Paperclip CN 自己的目标分支对齐

如果存在独立 `fork remote`，先看你当前分支与 Paperclip CN 目标分支的关系：

```sh
git rev-list --left-right --count private/master...HEAD
```

解释：

- 左边：只在 `private/master` 上的提交数
- 右边：只在 `HEAD` 上的提交数

如果左边不为 0，先把 Paperclip CN 自己的历史补齐：

```sh
git merge private/master
```

### 5.4 先看范围，再引入上游

先看本次上游更新影响哪些区域：

```sh
git log --oneline --decorate --stat HEAD..origin/master
git diff --name-only HEAD..origin/master
```

重点判断：

- 是否动到了 i18n 基础设施
- 是否动到了高 churn UI 页面
- 是否动到了 package manifest、exports、workspace 或 dev scripts
- 是否动到了 shared types / API contract / schema

### 5.5 合并上游

确认影响范围后再做真实 merge：

```sh
git merge origin/master
```

## 6. 冲突处理原则

### 6.1 总原则

不要：

- 全部选 `ours`
- 全部选 `theirs`
- 冲突一多就整文件重做

更稳的做法是：

1. 先吸收上游结构
2. 再把 Paperclip CN 差异按最小补丁补回去

### 6.2 文件处理优先级

#### 以上游结构为主

这类文件通常应保留上游结构，再手动补回 Paperclip CN 差异：

- 大多数页面组件
- 共享组件
- server route / service
- package manifest
- 构建脚本

原因很简单：上游通常会在这些地方带来 bugfix、结构调整和工程改进。

#### 必须手动合并

这些文件不要整文件选边，必须手动合：

- `ui/public/locales/zh-CN/common.json`
- `ui/public/locales/en/common.json`
- `ui/src/i18n.ts`
- `ui/src/main.tsx`
- 语言切换器相关组件
- server locale 中间件与错误处理
- `README.md`
- `README.zh-CN.md`
- `doc/UI-LOCALIZATION.md`
- `doc/UPSTREAM-MERGE-RUNBOOK.md`

#### 通常优先保留 Paperclip CN 版本

这类文件如果是 Paperclip CN 自己新增的，通常保留我们的版本，再选择性吸收上游思路：

- `README.zh-CN.md`
- `doc/UI-LOCALIZATION.md`
- `doc/UPSTREAM-MERGE-RUNBOOK.md`

## 7. 审计重点

不要只审冲突文件，要审“这次 merge 实际影响到的区域”。

### 7.1 品牌审计

确认用户可见文案是否需要保留 `Paperclip CN`，同时不要把技术标识误改成 `penclip`。

重点看：

- `Paperclip` 是否该改回 `Paperclip CN`
- `paperclipai` / `penclipai` 是否落在正确边界
- package name、CLI 名、环境变量名是否被误改
- 命令提示是否区分了 repo-local 与 public/runtime 场景

补充判断规则：

- 不要机械把 `pnpm penclip` 改成 `npx penclip`
- 也不要机械把 `npx penclip` 改回 `pnpm penclip`
- repo 内开发、维护、脚本、工作树说明通常保留 `pnpm penclip`
- 运行中实例返回给 operator 的 remediation、CLI 错误恢复、onboarding manifest / onboarding.txt、UI snippet / generated text，需要单独判断是否应使用 `penclip` 或 `npx penclip`

### 7.2 UI 本地化审计

对所有触及的页面和共享组件检查：

- 标题
- 按钮
- 空状态
- 错误和 fallback
- 表单提示
- 卡片副文案
- tooltip / aria / toast

额外确认：

- 首屏语言来源顺序没有被冲坏
- 服务端仍返回 `Content-Language` 和 `Vary: Accept-Language`
- wizard / dialog 默认草稿仍只同步“未编辑”的默认值
- 共享组件没有把状态、优先级、图例文案重新写死
- CLI 错误提示、server 纯文本/JSON remediation、onboarding manifest / onboarding.txt、导出或邀请 snippet 等运行期文案，没有被遗漏在审计范围之外

术语以 `doc/UI-LOCALIZATION.md` 为准，尤其留意：

- `Agent -> 智能体`
- `Issue -> 任务`
- `Routine -> 例行任务`
- `Workspace -> 工作区`
- `Costs -> 成本`

### 7.3 locale JSON 审计

处理 locale 文件时遵循四条规则：

1. 先保留上游新增 key
2. 再补回 Paperclip CN 已有翻译
3. 中英文一起改
4. 不要引入重复 key

重点检查：

- 有没有丢新增 key
- 有没有把中文值回退成英文
- 有没有引入重复 key

### 7.4 lockfile 审计

默认策略：

- 如果本次同步没有改 `package.json`、`pnpm-workspace.yaml`、`.npmrc` 或 `pnpmfile.*`，不要带 `pnpm-lock.yaml`
- 如果改了 package-manager 输入，并且干净环境需要 lockfile 才能通过，就提交最小 lockfile diff

检查命令：

```sh
git diff --name-only HEAD -- pnpm-lock.yaml
```

没有 package-manager 输入变化时，恢复 lockfile：

```sh
git restore --staged --worktree pnpm-lock.yaml
```

有输入变化时，重新验证：

```sh
pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
pnpm install --frozen-lockfile
```

### 7.5 干净环境审计

如果本次同步动到了依赖、workspace 布线或 locale 基础设施，至少补做一次干净验证：

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run server/src/__tests__/ui-locale.test.ts server/src/__tests__/i18n.test.ts
```

Windows 机器如果要补 Linux 验证，优先 Docker，不默认推荐 WSL。

## 8. 验证与交付

### 8.1 质量门禁

按仓库要求，优先跑：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果某项因为既有 Windows / 本机环境问题不能作为阻塞项，必须在提交说明或 PR 描述里明确写清楚。

### 8.2 页面烟雾验证

至少检查这些页面：

- `/TES/dashboard`
- `/TES/onboarding`
- `/TES/costs`
- `/instance/settings/general`
- `/instance/settings/plugins`

优先确认：

- 默认语言仍是中文
- 语言切换器仍可用
- 高可见导航仍是中文
- 没有明显把 `Agent` 冲回英文

### 8.3 交付方式

完成验证后，通过工作分支交付，不直接更新 `master`：

```sh
git push -u private codex/upstream-sync-YYYYMMDD
```

然后发起：

- `codex/upstream-sync-YYYYMMDD -> master`

的 PR。

如果误在本地 `master` 上做完了同步，按下面顺序修正：

```sh
git switch -c codex/upstream-sync-YYYYMMDD
git push -u private codex/upstream-sync-YYYYMMDD
git branch -f master private/master
```

## 9. 常见错误

### 9.1 把技术标识也改成 Paperclip CN

错误做法：

- 改 package name
- 改 CLI 名
- 改环境变量名

正确做法：

- 只改用户可见品牌文案

### 9.2 为了保住中文，整文件保留旧版页面

后果：

- 错过上游 bugfix
- 下次更难合并

正确做法：

- 接受上游结构
- 重新补最小 i18n 补丁

### 9.3 只改中文 locale，不改英文 locale

后果：

- 英文模式缺 key
- fallback 异常

正确做法：

- 中英文一起改

### 9.4 把用户内容误当成漏翻

不要把这些算作需要修的翻译问题：

- 模型生成正文
- 评论正文
- 日志输出
- 外部插件名称
- 用户输入名称

### 9.5 跳过 Paperclip CN 自己的历史对齐

后果：

- PR 历史不清楚
- 同类冲突反复出现

正确做法：

- 先看 `fork/master...HEAD`
- 需要时先合 Paperclip CN 自己的目标分支

### 9.6 直接把同步结果留在 master

错误做法：

- 在本地 `master` 上执行 `git merge origin/master`
- 直接在本地 `master` 上解决冲突并提交
- 直接把本地 `master` 推到 Paperclip CN 远端

正确做法：

- 全程使用 `codex/upstream-sync-YYYYMMDD`
- 推送工作分支
- 通过 PR 合回 `master`

## 10. 快速模板

下面给的是“有独立私有 fork remote”的标准模板。remote 名称不同就替换成实际值：

```sh
git remote -v
git fetch origin --prune
git fetch private --prune
git checkout master
git pull --ff-only
git checkout -b codex/upstream-sync-YYYYMMDD
git branch codex/upstream-sync-YYYYMMDD-safety
git rev-list --left-right --count private/master...HEAD
git merge private/master
git log --oneline --decorate --stat HEAD..origin/master
git diff --name-only HEAD..origin/master
git merge origin/master
pnpm -r typecheck
pnpm test:run
pnpm build
git push -u private codex/upstream-sync-YYYYMMDD
```

如果 lockfile 不该带，额外执行：

```sh
git restore --staged --worktree pnpm-lock.yaml
```

## 11. 完成标准

一次上游同步是成功的，当且仅当下面四件事同时成立：

1. 上游结构和 bugfix 没丢
2. Paperclip CN 的品牌边界和中文增强没丢
3. Windows 兼容层没被误回退
4. 本次同步通过工作分支和 PR 交付，没有把结果直接留在 `master`
