# 发布自动化设置

本文档涵盖当前 Paperclip 发布模型所需的 GitHub 和 npm 设置：

- 从 `master` 自动发布金丝雀版本（canary）
- 从选定的源引用（source ref）手动提升稳定版本（stable）
- 通过 GitHub OIDC 实现 npm 可信发布（trusted publishing）
- 公共仓库中受保护的发布基础设施

依赖此设置的仓库侧文件：

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`

注意：

- 发布工作流有意使用 `pnpm install --no-frozen-lockfile`
- 这符合仓库当前的策略，即 `pnpm-lock.yaml` 在清单更改合并到 `master` 后由 GitHub 自动化刷新
- 然后发布作业会在运行 `scripts/release.sh` 前恢复 `pnpm-lock.yaml`，因此发布脚本仍会看到干净的工作树（worktree）

## 1. 首先合并仓库更改

在接触 GitHub 或 npm 设置之前，请先合并发布自动化代码，以便引用的工作流文件名已存在于默认分支上。

必需文件：

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`

## 2. 配置 npm 可信发布（trusted publishing）

对 Paperclip 发布的每个公共包执行此操作。

至少包括：

- `paperclipai`
- `@paperclipai/server`
- `@paperclipai/ui`
- `packages/` 下的公共包

### 2.1. 在 npm 中，打开每个包的设置页面

对于每个包：

1. 以包的所有者身份打开 npm
2. 转到包设置/发布访问区域
3. 为 GitHub 仓库 `paperclipai/paperclip` 添加可信发布者（trusted publisher）

### 2.2. 每个包添加一个可信发布者条目

npm 目前允许每个包配置一个可信发布者。

配置：

- 工作流：`.github/workflows/release.yml`

仓库：

- `paperclipai/paperclip`

环境名称：

- 将 npm 可信发布者环境字段留空

原因：

- 单一的 `release.yml` 工作流同时处理金丝雀和稳定发布
- GitHub 环境 `npm-canary` 和 `npm-stable` 仍在 GitHub 端强制执行不同的审批规则

### 2.2.1. 新添加的公共包需要引导阶段（bootstrap phase）

可信发布是在 npm 包本身上配置的，而不是在仓库范围内。

这意味着全新的公共包在其 npm 包存在且其可信发布者已配置之前，不得自动注册到 CI 发布中。

仓库策略：

1. 将每个非私有包添加到 [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json)
2. 仅当 CI 预期发布该包时，才设置 `"publishFromCi": true`
3. 如果包尚未准备好进行 CI 发布，则保持 `"publishFromCi": false`
4. 在合并任何更改已启用发布的新包的 PR 之前，完成包引导

新包的引导序列：

1. 使用普通 npm 认证从受信任的维护者机器发布包一次
2. 在 npm 上打开该包，并为 `.github/workflows/release.yml` 添加 `paperclipai/paperclip` 可信发布者
3. 根据需要重新运行或干运行（dry-run）发布流程，以确认 CI 发布现在有效
4. 仅然后启用 `"publishFromCi": true`

PR CI 通过检查针对 npm 更改的已启用发布的包清单来强制执行此操作。这保持了 `master` 金丝雀发布的健康，同时保留了正常 CI 发布的无长期令牌（no-long-lived-token）模型。

### 2.3. 在移除旧认证前验证可信发布

工作流上线后：

1. 运行一次金丝雀发布
2. 确认 npm 发布在没有任何 `NPM_TOKEN` 的情况下成功
3. 运行一次稳定版干运行
4. 运行一次真正的稳定版发布

仅在此之后，您才应移除旧的基于令牌的访问权限。

## 3. 移除旧版 npm 令牌

可信发布生效后：

1. 撤销任何用于发布的仓库或组织 `NPM_TOKEN` 机密
2. 撤销任何曾用于发布 Paperclip 的个人自动化令牌
3. 如果 npm 提供包级设置以限制发布到可信发布者，请启用它

目标：

- GitHub Actions 中不应保留任何长期存在的 npm 发布令牌

## 4. 创建 GitHub 环境

在 GitHub 仓库中创建两个环境：

- `npm-canary`
- `npm-stable`

路径：

1. GitHub 仓库
2. `Settings`
3. `Environments`
4. `New environment`

## 5. 配置 `npm-canary`

`npm-canary` 的推荐设置：

- 环境名称：`npm-canary`
- 必需审阅者：无
- 等待计时器：无
- 部署分支和标签：
  - 仅选定的分支
  - 允许 `master`

原因：

- 每次推送到 `master` 都应能够自动发布金丝雀版本
- 金丝雀版本不应需要人工批准

## 6. 配置 `npm-stable`

`npm-stable` 的推荐设置：

- 环境名称：`npm-stable`
- 必需审阅者：尽可能至少一位除触发工作流的人员之外的维护者
- 防止自我审阅：启用
- 管理员绕过：如果您的团队可以容忍，则禁用
- 等待计时器：可选
- 部署分支和标签：
  - 仅选定的分支
  - 允许 `master`

原因：

- 稳定版发布应需要明确的人工批准门控
- 工作流是手动的，但环境仍应是真正的控制点

## 7. 保护 `master`

打开 `master` 的分支保护设置。

推荐规则：

1. 合并前需要拉取请求（pull requests）
2. 合并前需要状态检查通过
3. 需要代码所有者（code owners）的审阅
4. 当推送新提交时，撤销过时的批准
5. 限制谁可以直接推送到 `master`

至少确保工作流和发布脚本的更改在未经审阅的情况下无法落地。

## 8. 强制执行 CODEOWNERS 审阅

此仓库现在包含 `.github/CODEOWNERS`，但 GitHub 仅在分支保护要求代码所有者审阅时才强制执行。

在 `master` 的分支保护中，启用：

- `Require review from Code Owners`

然后验证所有者条目是否与您的实际维护者集匹配。

当前文件：

- `.github/CODEOWNERS`

如果 `@cryppadotta` 不是公共仓库中正确的审阅者身份，请在启用强制执行之前进行更改。

## 9. 特别保护发布基础设施

这些文件应始终触发代码所有者审阅：

- `.github/workflows/release.yml`
- `scripts/release.sh`
- `scripts/release-lib.sh`
- `scripts/release-package-map.mjs`
- `scripts/create-github-release.sh`
- `scripts/rollback-latest.sh`
- `doc/RELEASING.md`
- `doc/PUBLISHING.md`

如果您需要更强的控制，请添加一个仓库规则集（repository ruleset），明确阻止直接推送到：

- `.github/workflows/**`
- `scripts/release*`

## 10. 不要在 GitHub Actions 中存储 Claude 令牌

不要添加个人的 Claude 或 Anthropic 令牌用于自动变更日志生成。

推荐策略：

- 稳定版变更日志在受信任的维护者机器上本地生成
- 金丝雀版本从不生成变更日志

这使 LLM 支出保持有意，并避免高价值令牌留在 Actions 中。

## 11. 验证金丝雀工作流

设置完成后：

1. 将一个无害的提交合并到 `master`
2. 打开由该推送触发的 `Release` 工作流运行
3. 确认其通过验证
4. 确认在 `npm-canary` 环境下发布成功
5. 确认 npm 现在显示新的 `canary` 版本
6. 确认名为 `canary/vYYYY.MDD.P-canary.N` 的 git 标签已推送

安装路径检查：

```bash
npx paperclipai@canary onboard
```

## 12. 验证稳定版工作流

至少存在一个良好的金丝雀版本后：

1. 使用 `./scripts/release.sh stable --date YYYY-MM-DD --print-version` 解析目标稳定版本
2. 在您想要提升的源提交上准备 `releases/vYYYY.MDD.P.md`
3. 打开 `Actions` -> `Release`
4. 运行它：
   - `source_ref`：经过测试的提交 SHA 或金丝雀标签源提交
   - `stable_date`：留空或设置预期的 UTC 日期，如 `2026-03-18`
     不要输入像 `2026.318.0` 这样的版本；工作流会根据日期计算
   - `dry_run`：`true`
5. 确认干运行成功
6. 使用 `dry_run: false` 重新运行
7. 出现提示时批准 `npm-stable` 环境
8. 确认 npm `latest` 指向新的稳定版本
9. 确认 git 标签 `vYYYY.MDD.P` 存在
10. 确认 GitHub Release 已创建

实现说明：

- GitHub Actions 稳定版工作流使用 `PUBLISH_REMOTE=origin` 调用 `create-github-release.sh`
- 本地维护者使用时仍可在需要时显式传递 `PUBLISH_REMOTE=public-gh`

## 13. 建议的维护者策略

今后使用此策略：

- 金丝雀版本是自动且低成本的
- 稳定版是手动且经过批准的
- 只有稳定版才会获得公开说明和公告
- 发布说明在稳定版发布前提交
- 回滚使用 `npm dist-tag`，而不是取消发布（unpublish）

## 14. 故障排除

### 可信发布因认证错误而失败

检查：

1. GitHub 上的工作流文件名与 npm 中配置的文件名完全匹配
2. 该包具有针对正确仓库的可信发布者条目
3. 该作业具有 `id-token: write`
4. 该作业从预期的仓库运行，而不是从复刻（fork）运行

### 稳定版工作流运行但从不要求批准

检查：

1. `publish` 作业使用环境 `npm-stable`
2. 该环境确实配置了必需的审阅者
3. 该工作流在规范仓库中运行，而不是在复刻中

### CODEOWNERS 未触发

检查：

1. `.github/CODEOWNERS` 位于默认分支上
2. `master` 上的分支保护要求代码所有者审阅
3. 文件中的所有者身份是具有仓库访问权限的有效审阅者

## 相关文档

- [doc/RELEASING.md](RELEASING.md)
- [doc/PUBLISHING.md](PUBLISHING.md)
- [doc/plans/2026-03-17-发布自动化与版本号 release-automation-versioning.md](plans/2026-03-17-发布自动化与版本号 release-automation-versioning.md)