# 发布到 npm

有关如何为 npm 构建 Paperclip 包的低级参考。

对于维护者发布工作流程，请使用 [doc/RELEASING.md](RELEASING.md)。本文档仅涉及打包内部结构和生成可发布工件的脚本。

## 当前版本入口点

使用这些脚本而不是旧的一次性发布命令：

- [`scripts/release-start.sh`](../scripts/release-start.sh) 创建或恢复`release/X.Y.Z`
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) 在任何金丝雀或稳定版本之前
- [`scripts/release.sh`](../scripts/release.sh) 用于金丝雀和稳定的 npm 发布
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) 在回滚期间重新指向 `latest`
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) 推送稳定分支标签后

## 为什么CLI需要特殊包装

CLI 包、`paperclipai` 从工作区包导入代码，例如：

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- `packages/adapters/` 下的适配器包

这些工作区引用在开发期间使用 `workspace:*`。 npm 无法直接为最终用户安装这些引用，因此发布版本必须将 CLI 转换为可发布的独立包。

## `build-npm.sh`

运行：

```bash
./scripts/build-npm.sh
```

该脚本做了六件事：

1. 运行禁止令牌检查，除非提供 `--skip-checks`
2. 运行`pnpm -r typecheck`
3. 将 CLI 入口点与 esbuild 捆绑到 `cli/dist/index.js` 中
4. 使用 `node --check` 验证捆绑的入口点
5. 将 `cli/package.json` 重写为可发布的 npm 清单，并将开发副本存储为 `cli/package.dev.json`
6. 将存储库 `README.md` 复制到 `cli/README.md` 中以获取 npm 包元数据

发布脚本使用 `build-npm.sh`，以便 npm 用户安装真正的包，而不是未解决的工作区依赖项。

## 可发布的 CLI 布局

在开发过程中，[`cli/package.json`](../cli/package.json) 包含工作区引用。

在发布准备期间：

- `cli/package.json` 成为具有外部 npm 依赖范围的可发布清单
- `cli/package.dev.json` 临时存储开发清单
- `cli/dist/index.js` 包含捆绑的 CLI 入口点
- `cli/README.md` 被复制到 npm 元数据中

发布完成后，发布脚本将恢复开发清单并删除临时 README 副本。

## 包发现

发布工具会扫描工作区以查找以下公共包：

- `packages/`
- `server/`
- `cli/`

`ui/` 对于 npm 发布仍然被忽略，因为它是私有的。

这很重要，因为所有公共包都作为一个发布单元一起进行版本控制和发布。

## 金丝雀包装模型

Canary 作为 semver 预发行版发布，例如：

- `1.2.3-canary.0`
- `1.2.3-canary.1`

它们在 npm dist-tag `canary` 下发布。

这意味着：- `npx paperclipai@canary onboard` 可以明确安装它们
- `npx paperclipai onboard` 继续解决`latest`
- 稳定的更新日志可以保留在`releases/v1.2.3.md`

## 稳定的封装模型

稳定版本发布正常的 semver 版本，例如 npm dist-tag `latest` 下的 `1.2.3`。

稳定的发布流程还在 `release/X.Y.Z` 上创建本地发布提交和 git 标签。推送该分支提交/标签、创建 GitHub 版本以及将发布分支合并回 `master` 是随后作为单独的维护者步骤发生的。

## 回滚模型

回滚不会取消发布包。

相反，维护者应该将 `latest` dist-tag 移回之前的稳定版本：

```bash
./scripts/rollback-latest.sh <stable-version>
```

这可以保持历史记录完整，同时快速恢复默认安装路径。

## CI 注释

该存储库包含手动 GitHub Actions 发布工作流程，位于 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

推荐的 CI 发布设置：

- 通过 GitHub OIDC 使用 npm 可信发布
- 需要通过`npm-release`环境批准
- 从 `release/X.Y.Z` 运行版本
- 先使用金丝雀，然后使用稳定版

## 相关文件

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)