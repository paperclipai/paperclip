# Paperclip CN Upstream Sync Runbook

## 1. 目的

这份 runbook 用来指导 Paperclip CN 从上游 `paperclipai/paperclip` 同步代码，并保住三类长期差异：

- 品牌边界
- UI 本地化与 locale 基础设施
- Windows 兼容层

## 2. 必读

每次同步前至少先读：

1. `AGENTS.md`
2. `doc/DEVELOPING.md`
3. `doc/UI-LOCALIZATION.md`
4. `doc/UPSTREAM-MERGE-RUNBOOK.md`

涉及 schema、shared contract、server 行为时，再补读：

1. `doc/SPEC-implementation.md`
2. `doc/DATABASE.md`

## 3. 先确认 remote 角色

不要预设谁是 `origin`、谁是 `upstream`。先看实际配置：

```sh
git remote -v
git branch -vv
git config --get-regexp "^branch\\.(master|codex/upstream-sync-YYYYMMDD)\\."
```

同步时只关心四个概念：

- `upstream remote`: 原始 Paperclip 仓库
- `fork remote`: Paperclip CN 自己的仓库
- `base branch`: 最终要合回去的分支，通常是 `master`
- `upstream ref`: 统一写成 `<upstream remote>/master`

常见布局：

- `origin = upstream`，`private = fork`
- `origin = fork`，`upstream = upstream`

后文命令都要先映射到这四个概念，不要机械照抄 remote 名。

## 4. 不可破坏的规则

### 4.1 分支规则

- 同步必须在工作分支完成，不要直接在本地 `master` 上 merge
- 工作分支：`codex/upstream-sync-YYYYMMDD`
- 安全分支：`codex/upstream-sync-YYYYMMDD-safety`
- 最终通过 PR 合回 Paperclip CN 的 `master`

### 4.2 同步策略

默认用 merge，不默认用 rebase：

```sh
git merge <upstream remote>/master
```

### 4.3 长期保留差异

品牌边界：

- 用户可见层保留 `Paperclip CN`、`penclipai`、`penclip.ing`、`paperclipai.cn`
- 技术标识继续保留 `paperclip-cn`、`@penclipai/*`、`penclip`、`PAPERCLIP_*`

本地化基础设施：

- `ui/src/i18n.ts`
- `ui/public/locales/zh-CN/common.json`
- `ui/public/locales/en/common.json`
- 默认 `zh-CN`
- 语言切换器与 `Accept-Language` / `Content-Language` / `Vary: Accept-Language`
- 服务端首屏 locale 注入与用户可见错误 locale

Windows 兼容层：

- Node 替代 Unix-only shell 片段
- dev/build/runtime 脚本中的 Windows 兼容修复
- `tsx` / watch 相关兼容修复
- 触及 dev/runtime 脚本时，优先确认是否仍应保持 `pnpm exec node --import tsx ...` 这类更稳写法

### 4.4 范围基线

上游同步 PR 默认只包含：

- 合并上游 `master`
- 补齐或修正 Paperclip CN 本地化
- 为了让这次同步可用、可验证、可合并而必须做的小修复

不要顺手带入无关重构、样式调整、额外功能，默认也不要新增 embedded-postgres、worktree、CLI e2e、真实 provision shell 这类重型测试。能用纯函数、helper、route/service 级测试覆盖的，就不要加完整集成链路。

如果发现的是上游路径或运行时契约问题，优先保持与上游一致；真要补洞，优先在 server/shared 外层收口，不要把同类补丁复制到每个 adapter。

## 5. 标准流程

### 5.1 准备

```sh
git status --short
git fetch origin --prune
git fetch private --prune
git fetch upstream --prune
```

某个 remote 不存在，就删掉对应命令。

### 5.2 建立工作分支

```sh
git checkout master
git pull --ff-only
git checkout -b codex/upstream-sync-YYYYMMDD
git branch codex/upstream-sync-YYYYMMDD-safety
```

### 5.3 先和 fork 的目标分支对齐

```sh
git rev-list --left-right --count <fork remote>/master...HEAD
```

如果左边不为 0，先补齐 fork 自己的历史：

```sh
git merge <fork remote>/master
```

### 5.4 先看范围，再引入上游

```sh
git log --oneline --decorate --stat HEAD..<upstream remote>/master
git diff --name-only HEAD..<upstream remote>/master
```

重点看是否动到：

- i18n 基础设施
- 高 churn UI 页面
- package manifest / exports / workspace / dev scripts
- shared type / API contract / schema
- `AGENT_HOME`、instructions bundle、adapter prompt 组装这类运行时契约

### 5.5 合并上游

```sh
git merge <upstream remote>/master
```

## 6. 冲突处理

总原则：先吸收上游结构，再把 Paperclip CN 差异按最小补丁补回去。

不要全选 `ours` / `theirs`，也不要冲突一多就整文件重做。

处理优先级：

- 以上游结构为主：大多数页面组件、共享组件、server route / service、package manifest、构建脚本、adapter 实现
- 必须手动合并：`ui/public/locales/zh-CN/common.json`、`ui/public/locales/en/common.json`、`ui/src/i18n.ts`、locale 中间件与错误处理、`doc/UI-LOCALIZATION.md`、`doc/UPSTREAM-MERGE-RUNBOOK.md`
- 通常优先保留 Paperclip CN 版本：`README.zh-CN.md`、`doc/UI-LOCALIZATION.md`、`doc/UPSTREAM-MERGE-RUNBOOK.md`

## 7. 审计重点

### 7.1 品牌

重点确认：

- 用户可见 `Paperclip` 是否应保留为 `Paperclip CN`
- 不要把 package name、CLI 名、环境变量名误改成品牌文案
- 不要机械把 `pnpm penclip` 和 `npx penclip` 相互替换

### 7.2 UI 本地化

对所有触及页面和共享组件检查：

- 标题、按钮、空状态、错误、表单提示、tooltip、aria、toast
- loading / skeleton / empty / error shell 是否和 live 页面保持同一布局约束
- 服务端 warning、validation hint、timeline/event 描述是否透传成英文
- CLI 错误提示、server remediation、onboarding manifest / onboarding.txt、导出或邀请 snippet 是否遗漏

术语以 `doc/UI-LOCALIZATION.md` 为准。

### 7.3 locale JSON

处理 locale 文件只记四条：先保留上游新增 key，再补回 Paperclip CN 翻译；中英文一起改；不要引入重复 key。

### 7.4 lockfile

默认规则：

- 没改 `package.json`、`pnpm-workspace.yaml`、`.npmrc`、`pnpmfile.*`，不要带 `pnpm-lock.yaml`
- 改了 package-manager 输入，且干净环境需要 lockfile，才提交最小 diff

检查：

```sh
git diff --name-only HEAD -- pnpm-lock.yaml
```

不该带时恢复：

```sh
git restore --staged --worktree pnpm-lock.yaml
```

### 7.5 干净环境

如果本次同步动到了依赖、workspace 布线或 locale 基础设施，至少补做：

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm test:run server/src/__tests__/ui-locale.test.ts server/src/__tests__/i18n.test.ts
```

### 7.6 upstream merge harness

每次 upstream merge 完成冲突处理后，先跑一遍轻量 harness，再跑完整门禁：

```sh
pnpm test:upstream-merge-harness
```

这个 harness 的目标不是替代 `pnpm test:run`，而是优先拦住“手工合并最容易引入、但完整门禁里不够显眼”的 merge-sensitive invariants。

设计原则：

- 只收跨多次 upstream merge 容易回归、或手工冲突处理时容易破坏的不变量
- 只收基础设施或契约级行为，不收单个业务功能细节
- 只收轻量、稳定、无外部依赖的测试，保证它能作为完整门禁前的快速闸门

维护规则：

- 具体测试文件清单属于实现细节，放在 `scripts/upstream-merge-harness.mjs`，不要把长期文档写成事故清单
- 本次同步暴露新回归时，先判断它是否符合上面三条；符合再纳入 harness，不符合就留在常规测试集
- 优先补纯函数、helper、middleware、route/service 级测试；不要直接把更重的 e2e 或 CLI 链路塞进 harness

### 7.7 测试重量

如果这次同步后 `pnpm test:run` 变慢或开始随机 timeout，先找最重的 suite，再区分它来自 upstream 已有覆盖、Paperclip CN 既有覆盖、还是本次分支新增覆盖。优先收敛“本次分支新增”的重型测试；不要为了提速直接删 upstream 覆盖。能通过抽 helper、降低测试层级、去掉重复 CLI/probe 白耗时解决的，优先修这些，不要先改全局 `maxWorkers` / `testTimeout`。

## 8. 验证与交付

### 8.1 质量门禁

先跑轻量 harness，尽早发现 merge 手工补丁引入的基础设施回归：

```sh
pnpm test:upstream-merge-harness
```

再跑完整门禁：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果门禁失败的主要形态是 timeout，先单独复跑失败测试确认是不是脏进程或本机状态，再看是否是本次分支新增的重型测试或实现里的慢 probe / 白耗时。只有在当前 PR 无法安全修根因时，才临时调整全局并发或超时；根因修掉后应回收这些兜底参数。

### 8.2 页面烟雾验证

至少检查：

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

### 8.3 PR 自查

在 push / 开 PR 前，至少确认：

- 触及的页面、共享组件和 locale diff 中，没有硬编码英文、未走 helper 的 aria/tooltip/label
- 上游如果改了容器宽度或页面结构，loading / skeleton / empty / error 状态仍和 live 页面一致
- 上游如果引入搜索、筛选或 bulk action，动作作用域仍与当前可见列表一致
- PR 描述按模板补齐必要字段

### 8.4 交付方式

```sh
git push -u <fork remote> codex/upstream-sync-YYYYMMDD
```

然后发起：

- `codex/upstream-sync-YYYYMMDD -> master`

的 PR。

如果误在本地 `master` 上做完同步，按下面顺序修正：

```sh
git switch -c codex/upstream-sync-YYYYMMDD
git push -u <fork remote> codex/upstream-sync-YYYYMMDD
git branch -f master <fork remote>/master
```

## 9. 常见错误

- 把技术标识也改成品牌文案
  - 正确做法：只改用户可见品牌文案
- 为了保住中文，整文件保留旧版页面
  - 正确做法：接受上游结构，再补最小 i18n 补丁
- 只改中文 locale，不改英文 locale
  - 正确做法：中英文一起改
- 把模型正文、评论正文、日志、插件名、用户输入误当成漏翻
- 跳过 fork 自己的历史对齐
- 直接在本地 `master` 上 merge、提交、推送
- 在同步 PR 里本地发明新的路径契约
- 为了提速直接删 upstream 覆盖，或长期保留全局 timeout/worker 兜底

## 10. 快速模板

下面给的是“存在独立 fork remote”的标准模板，remote 名称按实际替换：

```sh
git remote -v
git fetch origin --prune
git fetch private --prune
git checkout master
git pull --ff-only
git checkout -b codex/upstream-sync-YYYYMMDD
git branch codex/upstream-sync-YYYYMMDD-safety
git rev-list --left-right --count <fork remote>/master...HEAD
git merge <fork remote>/master
git log --oneline --decorate --stat HEAD..<upstream remote>/master
git diff --name-only HEAD..<upstream remote>/master
git merge <upstream remote>/master
pnpm test:upstream-merge-harness
pnpm -r typecheck
pnpm test:run
pnpm build
git push -u <fork remote> codex/upstream-sync-YYYYMMDD
```

如果 lockfile 不该带：

```sh
git restore --staged --worktree pnpm-lock.yaml
```

## 11. 完成标准

一次上游同步是成功的，当且仅当下面四件事同时成立：

1. 上游结构和 bugfix 没丢
2. Paperclip CN 的品牌边界和中文增强没丢
3. Windows 兼容层没被误回退
4. 本次同步通过工作分支和 PR 交付，没有把结果直接留在 `master`
