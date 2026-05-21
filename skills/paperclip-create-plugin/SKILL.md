---
name: paperclip-create-plugin
required: false
description: >
  使用当前 alpha SDK/运行时新建 Paperclip 插件。适用于脚手架插件包、添加示例插件或更新插件
  编写文档；涵盖支持的 worker/UI 能力、路由约定、脚手架流程与验证步骤。
---

**中文名：** 写 Paperclip 插件（脚手架、worker/UI、验收）  
**系统 id：** `paperclip-create-plugin`

# 新建 Paperclip 插件

当你需要新建、脚手架化或撰写 Paperclip 插件文档时使用本技能。

## 1. 基础规则（按需优先阅读）

1. `doc/plugins/插件编写指南 PLUGIN_AUTHORING_GUIDE.md`
2. `packages/plugins/sdk/README.md`
3. 仅在未来向设计讨论时才需要：`doc/plugins/插件规范 PLUGIN_SPEC.md`

当前运行时的隐含前提：

- 插件 worker 代码受信任
- 插件 UI 与宿主同源，宿主代码同样受信任
- worker API 受能力（capability）约束
- 插件 UI **不会**因 manifest 能力而被沙箱隔离
- 宿主尚未提供可复用的共享插件 UI 组件库
- 当前运行时**不支持** `ctx.assets`

## 2. 推荐工作流

用脚手架生成样板代码，不要从零手写：

```bash
paperclipai plugin init @acme/my-plugin --output ~/dev/paperclip-plugins
```

若插件建在 Paperclip 仓库外，传 `--sdk-path`，让脚手架把本地 SDK/shared 快照到 `.paperclip-sdk/`：

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @acme/my-plugin \
  --output /absolute/path \
  --sdk-path /absolute/path/to/paperclip/packages/plugins/sdk
```

本仓库内的推荐放置位置：

- 示例插件：`packages/plugins/examples/`
- 将独立成包的插件：`packages/plugins/<name>/`

## 3. 脚手架之后的检查

重点核对：

- `paperclipai plugin install` auto-detects local paths (absolute, `./`, `../`, `~`, or an existing relative folder) and forwards `isLocalPath: true` to the server. Pass `--local` to force local mode if the heuristic is ambiguous.
- Paths are resolved to absolute paths before being sent to the server.
- The server watches built outputs (`dist/`) for local-path plugins and restarts the plugin worker on rebuild — you do not need to reinstall after every edit.
- UI hot reload via the SDK dev server (`pnpm dev:ui`, port `4177`) is optional and template-dependent; only mention it if the template wires `devUiUrl` and you verified it works end to end.
- `--version` only applies to npm package installs. Combining it with a local path is an error.

After install, inspect with:

```bash
paperclipai plugin list
paperclipai plugin inspect <plugin-key>
```

## 5. After scaffolding, sanity-check the package

Open and confirm:

- `src/manifest.ts` — declared capabilities and slots
- `src/worker.ts` — worker entry
- `src/ui/index.tsx` — UI entry (if applicable)
- `tests/plugin.spec.ts` — placeholder test
- `package.json` — `paperclipPlugin` block points at `dist/manifest.js`, `dist/worker.js`, `dist/ui/`

确保插件：

- 只声明已支持的能力
- 不使用 `ctx.assets`
- 不导入占位用的宿主 UI 组件桩
- UI 自给自足
- 仅在类型为 `page` 的 slot 上使用 `routePath`
- 开发时用**绝对本地路径**安装到 Paperclip 中调试

## 4. 若希望插件出现在应用内

要使示例可被聚合展示，需要改宿主侧的接线：

- `server/src/routes/plugins.ts` 中的 bundled 示例列表
- 列出本仓库内置示例的相关文档

仅当用户希望该插件作为**内置示例**暴露时再改。

## 5. 验证

始终执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

若同时修改了 SDK/宿主/插件运行时，再按需要做更大范围的仓库检查。

## 6. 文档预期

撰写或修改插件文档时：

- 明确区分「当前已实现」与 spec 里的远期设想
- 写清可信代码模型
- 勿承诺宿主 UI 组件或资产类 API
- 生产部署优先写 npm 包发布路径，而不是长期依赖拷贝本仓库路径
