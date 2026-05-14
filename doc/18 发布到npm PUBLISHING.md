# 发布到 npm

Paperclip 包如何准备和发布到 npm 的底层参考文档。

维护者工作流请参阅 [doc/RELEASING.md](RELEASING.md)。本文档聚焦于打包内部机制。

## 当前发布入口

使用以下脚本：

- [`scripts/release.sh`](../scripts/release.sh) 用于金丝雀发布（canary）和稳定发布（stable）流程
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) 在推送稳定标签后使用
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) 用于重新指向 `latest`
- [`scripts/build-npm.sh`](../scripts/build-npm.sh) 用于 CLI 打包构建

Paperclip 不再使用发布分支（release branches）或 Changesets 进行发布。

## 为什么 CLI 需要特殊打包

CLI 包 `paperclipai` 引用了来自工作区包（workspace packages）的代码，例如：

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- `packages/adapters/` 下的适配器包（adapter packages）

这些工作区引用在开发环境中有效，但在可发布的 npm 包中无效。发布流程会临时重写版本号，然后构建可发布的 CLI 产物包（bundle）。

## `build-npm.sh`

运行：

```bash
./scripts/build-npm.sh
```

该脚本会：

1. 运行禁用令牌检查（forbidden token check），除非提供了 `--skip-checks`
2. 运行 `pnpm -r typecheck`
3. 使用 esbuild 将 CLI 入口打包到 `cli/dist/index.js`
4. 使用 `node --check` 验证打包后的入口文件
5. 将 `cli/package.json` 重写为可发布的 npm 清单（manifest），并将开发副本存储为 `cli/package.dev.json`
6. 将仓库的 `README.md` 复制到 `cli/README.md` 作为 npm 元数据

发布脚本退出后，开发清单和临时文件会自动恢复。

## 包发现与版本管理

公共包（public packages）从以下目录中发现：

- `packages/`
- `server/`
- `ui/`
- `cli/`

版本重写步骤现在使用 [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)，该脚本会：

- 查找所有公共包
- 按内部依赖关系进行拓扑排序（topological sort）
- 将每个包的版本重写为目标发布版本
- 将内部 `workspace:*` 依赖引用重写为精确的目标版本
- 更新 CLI 显示的版本字符串

这些重写是临时的。发布或试运行（dry-run）后，工作树会自动恢复。

## `@paperclipai/ui` 打包

UI 包发布的是预构建的静态资源（prebuilt static assets），而非源码工作区。

`ui` 包在 `prepack` 阶段使用 [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs) 切换为精简的发布清单，该清单会：

- 保留由发布流程管理的 `name` 和 `version`
- 仅发布 `dist/` 目录
- 从下游安装中省略仅限源码的依赖图

打包或发布后，`postpack` 会自动恢复开发清单。

### `@paperclipai/ui` 的首次手动发布

如果你需要手动发布一次 UI 包，请使用真实的包名：

- `@paperclipai/ui`

推荐从仓库根目录执行以下流程：

```bash
# 可选的完整性检查：首次发布前此处返回 404
npm view @paperclipai/ui version

# 确保 dist 产物是最新的
pnpm --filter @paperclipai/ui build

# 在正式发布前确认本地 npm 认证状态
npm whoami

# 安全预览即将发布的完整内容
cd ui
pnpm publish --dry-run --no-git-checks --access public

# 正式发布
pnpm publish --no-git-checks --access public
```

注意事项：

- 从 `ui/` 目录发布，而非仓库根目录。
- `prepack` 会自动将 `ui/package.json` 重写为精简的发布清单，命令完成后 `postpack` 会恢复开发清单。
- 如果 `npm view @paperclipai/ui version` 已经返回与 [`ui/package.json`](../ui/package.json) 中相同的版本号，请勿重复发布。请升级版本号或使用仓库级别的正常发布流程 [`scripts/release.sh`](../scripts/release.sh)。

如果首次正式发布返回 npm `E404` 错误，请在重试前检查 npm 端的先决条件：

- `npm whoami` 必须先成功。过期或缺失的 npm 登录会阻止发布。
- 对于组织作用域包（organization-scoped package）如 `@paperclipai/ui`，`paperclipai` npm 组织必须存在，且发布者必须是具有该作用域发布权限的成员。
- 公共作用域包的首次发布必须包含 `--access public`。
- npm 还要求发布账户开启双因素认证（2FA），或使用允许绕过 2FA 的细粒度令牌（granular token）。

## 版本格式

Paperclip 使用日历版本号（calendar versions）：

- 稳定版：`YYYY.MDD.P`
- 金丝雀版：`YYYY.MDD.P-canary.N`

示例：

- 稳定版：`2026.318.0`
- 金丝雀版：`2026.318.1-canary.2`

## 发布模型

### 金丝雀发布（Canary）

金丝雀版本发布到 npm 的 dist-tag `canary`。

示例：

- `paperclipai@2026.318.1-canary.2`

这样可以保持默认安装路径不变，同时允许通过以下方式显式安装：

```bash
npx paperclipai@canary onboard
```

发布脚本现在会在金丝雀发布后验证两件事：

- `canary` dist-tag 解析到刚刚发布的版本
- 该清单引用的每个已发布的内部 `@paperclipai/*` 依赖都已存在于 npm 上

脚本默认将 `latest -> canary` 视为失败，因为 npm 元数据可能会使默认安装路径指向未发布的金丝雀依赖图。只有在明确需要该 `latest` 行为时，才使用 `./scripts/release.sh canary --allow-canary-latest`。

### 稳定发布（Stable）

稳定发布使用 npm dist-tag `latest`。

示例：

- `paperclipai@2026.318.0`

稳定发布不会创建发布提交（release commit）。取而代之的是：

- 包版本被临时重写
- 从选定的源提交进行发布
- git 标签 `vYYYY.MDD.P` 指向该原始提交

## 可信发布（Trusted publishing）

预期的 CI 模型是通过 GitHub OIDC 进行 npm 可信发布。

这意味着：

- 仓库密钥中没有长期有效的 `NPM_TOKEN`
- GitHub Actions 获取短期发布凭证
- 可信发布者规则按工作流文件配置

设置步骤请参阅 [doc/RELEASE-AUTOMATION-SETUP.md](RELEASE-AUTOMATION-SETUP.md)。

## 新公共包的发布注册

Paperclip 不再自动发布每个非私有工作区包。CI 发布由 [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json) 控制。

当你添加新的公共包时：

1. 将其添加到清单中，并决定 CI 是否应立即发布
2. 如果 CI 应该发布，在合并前在 npm 上引导（bootstrap）该包
3. 如果 CI 暂时不应发布，保持 `"publishFromCi": false`
4. 仅为该包配置 npm 可信发布后，才启用 `"publishFromCi": true`

PR CI 现在会检查已变更的启用发布的包清单与 npm 的匹配情况。这可以在变更到达 `master` 之前捕获缺失的首次发布引导。

### 新包的一次性引导流程

全新包的首次发布仍然需要一位具有 npm 写入权限的人类维护者完成。之后，可信发布即可接管。

从仓库根目录为 `@paperclipai/adapter-acpx-local` 执行的示例：

```bash
# 安全预览
pnpm run release:bootstrap-package -- @paperclipai/adapter-acpx-local

# 从已认证的维护者机器上进行一次性首次发布
pnpm run release:bootstrap-package -- @paperclipai/adapter-acpx-local --publish --otp 123456
```

辅助脚本会：

- 检查该包是否尚未存在于 npm 上
- 构建目标包（除非传入 `--skip-build`）
- 在包目录中运行 `npm pack --dry-run`
- 仅在提供 `--publish --otp <code>` 时才运行真正的 `npm publish --access public`

对于真正的 `--publish` 步骤，维护者机器必须已通过 npm 认证。如果 `npm whoami` 返回 `401`，请先运行 `npm logout --registry=https://registry.npmjs.org/` 清除任何过期的本地认证，然后以 npm 组织成员身份在本地运行 `npm login` 或 `npm adduser`，最后重新运行辅助脚本。该本地人工认证仅用于一次性引导发布；我们不希望在 CI 中使用相同的认证模式。辅助脚本现在要求为 `--publish` 预先提供 `--otp <code>`，如果缺少一次性密码，则会在真正发布尝试之前失败。

首次发布成功后：

1. 打开 `https://www.npmjs.com/package/@paperclipai/adapter-acpx-local`
2. 进入 `Settings` → `Trusted publishing`
3. 添加仓库 `paperclipai/paperclip`
4. 设置工作流文件名为 `release.yml`
5. 可选：进入 `Settings` → `Publishing access` 并启用 `Require two-factor authentication and disallow tokens`
6. 在 [`scripts/release-package-manifest.json`](../scripts/release-package-manifest.json) 中保持 `publishFromCi: true`

完成上述步骤后，该包的后续金丝雀和稳定发布将通过 GitHub OIDC 自动化完成。手动步骤仅限于在 npm 上的首次包创建。

## 回滚模型（Rollback model）

回滚不会取消发布（unpublish）任何内容。

它会将 `latest` dist-tag 重新指向之前的稳定版本：

```bash
./scripts/rollback-latest.sh 2026.318.0
```

如果稳定版发布出现问题，这是恢复默认安装路径的最快方式。

## 相关文件

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`scripts/generate-ui-package-json.mjs`](../scripts/generate-ui-package-json.mjs)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)
