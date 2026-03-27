# @paperclipai/plugin-hello-world-example

展示最小可行 UI 扩展的官方参考插件。

## 功能演示

- 包含 `dashboardWidget` UI 插槽的清单文件
- 用于插件 UI 包的 `entrypoints.ui` 配置
- 在 Paperclip 仪表盘中渲染的最小 React 组件
- 从 `PluginWidgetProps` 读取宿主上下文（`companyId`）
- Worker 生命周期钩子（`setup`、`onHealth`）用于基本的运行时可观测性

## API 接口

- 本示例不添加自定义 HTTP 端点。
- 该组件通过宿主管理的插件 API（例如 `GET /api/plugins/ui-contributions`）被发现和渲染。

## 说明

本示例特意保持简单，旨在为 UI 插件作者提供最快的"Hello World"起步模板。
这是一个用于开发的仓库本地示例插件，不应被视为可用于通用生产构建的插件。

## 本地安装（开发环境）

在仓库根目录下，构建插件并通过本地路径安装：

```bash
pnpm --filter @paperclipai/plugin-hello-world-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example
```

**本地开发注意事项：**

- **请先构建。** 宿主通过清单中的 `entrypoints.worker`（例如 `./dist/worker.js`）解析 Worker。在安装前请先在插件目录中运行 `pnpm build`，确保 Worker 文件存在。
- **仅限开发环境的安装路径。** 本地路径安装方式假定已签出源代码，且此示例包存在于磁盘上。对于部署安装，请发布 npm 包，而不要依赖 monorepo 中的示例路径。
- **拉取代码后请重新安装。** 如果你在服务器存储 `package_path` 之前通过本地路径安装了插件，插件可能会显示状态 **error**（找不到 Worker）。请卸载后重新安装，以便服务器持久化路径并激活插件：
  `pnpm paperclipai plugin uninstall paperclip.hello-world-example --force` 然后
  `pnpm paperclipai plugin install ./packages/plugins/examples/plugin-hello-world-example`。
