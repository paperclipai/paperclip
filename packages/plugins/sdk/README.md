# `@paperclipai/plugin-sdk`

面向 Paperclip 插件作者的官方 TypeScript SDK。

- **Worker SDK：** `@paperclipai/plugin-sdk` — `definePlugin`、上下文、生命周期
- **UI SDK：** `@paperclipai/plugin-sdk/ui` — React hooks 与插槽属性
- **测试：** `@paperclipai/plugin-sdk/testing` — 内存宿主测试夹具
- **打包工具：** `@paperclipai/plugin-sdk/bundlers` — esbuild/rollup 预设
- **开发服务器：** `@paperclipai/plugin-sdk/dev-server` — 静态 UI 服务器 + SSE 热重载

参考文档：`doc/plugins/PLUGIN_SPEC.md`

## 包接口概览

| 导入路径 | 用途 |
|--------|--------|
| `@paperclipai/plugin-sdk` | Worker 入口：`definePlugin`、`runWorker`、上下文类型、协议辅助函数 |
| `@paperclipai/plugin-sdk/ui` | UI 入口：`usePluginData`、`usePluginAction`、`usePluginStream`、`useHostContext`、插槽属性类型 |
| `@paperclipai/plugin-sdk/ui/hooks` | 仅 Hooks |
| `@paperclipai/plugin-sdk/ui/types` | UI 类型与插槽属性接口 |
| `@paperclipai/plugin-sdk/testing` | `createTestHarness`，用于单元/集成测试 |
| `@paperclipai/plugin-sdk/bundlers` | `createPluginBundlerPresets`，用于 worker/manifest/ui 构建 |
| `@paperclipai/plugin-sdk/dev-server` | `startPluginDevServer`、`getUiBuildSnapshot` |
| `@paperclipai/plugin-sdk/protocol` | JSON-RPC 协议类型与辅助函数（高级） |
| `@paperclipai/plugin-sdk/types` | Worker 上下文与 API 类型（高级） |

## Manifest 入口点

在插件 manifest 中声明：

- **`entrypoints.worker`**（必填）— Worker bundle 路径（如 `dist/worker.js`）。宿主加载此文件并调用 `setup(ctx)`。
- **`entrypoints.ui`**（使用 UI 时必填）— UI bundle 目录路径。宿主从此处为插槽和启动器加载组件。

## 安装

```bash
pnpm add @paperclipai/plugin-sdk
```

## 当前部署注意事项

该 SDK 已足够稳定，可用于本地开发和内部示例，但运行时部署模型仍处于早期阶段。

- 插件 Worker 和插件 UI 目前都应被视为可信代码。
- 插件 UI bundle 以同源 JavaScript 的形式运行在 Paperclip 主应用内部，可使用 board 会话调用普通的 Paperclip HTTP API，因此 manifest 中声明的能力并不构成前端沙箱。
- 本地路径安装和仓库示例插件属于开发工作流，假定插件源码检出存在于磁盘上。
- 对于需要部署的插件，请发布为 npm 包，并在运行时将其安装到 Paperclip 实例中。
- 当前宿主运行时要求可写文件系统、运行时可用的 `npm` 以及访问用于安装插件的包注册表的网络。
- 动态插件安装目前最适合单节点持久化部署。多实例云部署在各节点上的运行时安装可靠性仍需要共享的产物/分发模型。
- 宿主目前不为插件提供真正的共享 React 组件库。请使用普通 React 组件和 CSS 构建插件 UI。
- `ctx.assets` 在本构建的支持运行时中不可用，请勿依赖资源上传/读取 API。

如果您正在为他人部署编写插件，请将 npm 包安装作为受支持的路径，将仓库本地示例安装视为开发便利。

## Worker 快速入门

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.info("Issue created", { issueId: event.entityId });
    });

    ctx.data.register("health", async () => ({ status: "ok" }));
    ctx.actions.register("ping", async () => ({ pong: true }));

    ctx.tools.register("calculator", {
      displayName: "Calculator",
      description: "Basic math",
      parametersSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"]
      }
    }, async (params) => {
      const { a, b } = params as { a: number; b: number };
      return { content: `Result: ${a + b}`, data: { result: a + b } };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

**注意：** 必须调用 `runWorker(plugin, import.meta.url)`，这样当宿主运行您的 worker 时（例如 `node dist/worker.js`），RPC 宿主才会启动并保持进程存活。当该文件被导入时（例如用于测试），主模块检查会阻止宿主启动。

### Worker 生命周期与上下文

**生命周期（definePlugin）：**

| 钩子 | 用途 |
|------|--------|
| `setup(ctx)` | **必填。** 在启动时调用一次。注册事件处理器、作业、数据/动作/工具等。 |
| `onHealth?()` | 可选。返回 `{ status, message?, details? }` 用于健康状态仪表板。 |
| `onConfigChanged?(newConfig)` | 可选。在不重启的情况下应用新配置；若省略，宿主将重启 worker。 |
| `onShutdown?()` | 可选。在进程退出前执行清理（有限时间窗口）。 |
| `onValidateConfig?(config)` | 可选。返回 `{ ok, warnings?, errors? }` 用于设置 UI / 测试连接。 |
| `onWebhook?(input)` | 可选。处理 `POST /api/plugins/:pluginId/webhooks/:endpointKey`；若声明了 webhooks 则必填。 |

**setup 中的上下文（`ctx`）：** `config`、`events`、`jobs`、`launchers`、`http`、`secrets`、`activity`、`state`、`entities`、`projects`、`companies`、`issues`、`agents`、`goals`、`data`、`actions`、`streams`、`tools`、`metrics`、`logger`、`manifest`。Worker 端宿主 API 受能力限制，需在 manifest 中声明相应能力。

**Agents：** `ctx.agents.invoke(agentId, companyId, opts)` 用于单次调用。`ctx.agents.sessions` 用于双向对话：`create`、`list`、`sendMessage`（带流式 `onEvent` 回调）、`close`。详情参见 [插件编写指南](../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md#agent-sessions-two-way-chat)。

**Jobs：** 在 `manifest.jobs` 中声明，包含 `jobKey`、`displayName`、`schedule`（cron 表达式）。使用 `ctx.jobs.register(jobKey, fn)` 注册处理器。**Webhooks：** 在 `manifest.webhooks` 中声明 `endpointKey`；在 `onWebhook(input)` 中处理。**State：** `ctx.state.get/set/delete(scopeKey)`；作用域类型：`instance`、`company`、`project`、`project_workspace`、`agent`、`issue`、`goal`、`run`。

## 事件

在 `setup` 中通过 `ctx.events.on(name, handler)` 或 `ctx.events.on(name, filter, handler)` 订阅事件。使用 `ctx.events.emit(name, companyId, payload)` 发布插件作用域内的事件（需要 `events.emit` 能力）。

**核心领域事件（通过 `events.subscribe` 订阅）：**

| 事件 | 典型实体 |
|-------|-----------------|
| `company.created`, `company.updated` | company |
| `project.created`, `project.updated` | project |
| `project.workspace_created`, `project.workspace_updated`, `project.workspace_deleted` | project_workspace |
| `issue.created`, `issue.updated`, `issue.comment.created` | issue |
| `agent.created`, `agent.updated`, `agent.status_changed` | agent |
| `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | run |
| `goal.created`, `goal.updated` | goal |
| `approval.created`, `approval.decided` | approval |
| `cost_event.created` | cost |
| `activity.logged` | activity |

**插件间通信：** 订阅 `plugin.<pluginId>.<eventName>`（例如 `plugin.acme.linear.sync-done`）。使用 `ctx.events.emit("sync-done", companyId, payload)` 发布；宿主会自动添加命名空间前缀。

**过滤器（可选）：** 向 `on()` 传入第二个参数：`{ projectId?, companyId?, agentId? }`，使宿主仅投递匹配的事件。

**公司上下文：** 事件仍携带 `companyId` 用于公司作用域数据，但在当前运行时中，插件的安装和激活是实例级别的。

## 定时（周期性）作业

插件可以声明**定时作业**，由宿主按 cron 计划运行。适用于同步、摘要报告或清理等周期性任务。

1. **能力：** 将 `jobs.schedule` 添加到 `manifest.capabilities`。
2. **声明作业**，在 `manifest.jobs` 中：每个条目包含 `jobKey`、`displayName`、可选的 `description` 以及 `schedule`（5 字段 cron 表达式）。
3. **注册处理器**，在 `setup()` 中使用 `ctx.jobs.register(jobKey, async (job) => { ... })`。

**Cron 格式**（5 个字段：分钟、小时、月中的天、月、周中的天）：

| 字段 | 取值范围 | 示例 |
|-------------|----------|---------|
| 分钟 | 0–59     | `0`, `*/15` |
| 小时 | 0–23     | `2`, `*` |
| 月中的天 | 1–31   | `1`, `*` |
| 月 | 1–12     | `*` |
| 周中的天 | 0–6（周日=0） | `*`, `1-5` |

示例：`"0 * * * *"` = 每小时第 0 分钟；`"*/5 * * * *"` = 每 5 分钟；`"0 2 * * *"` = 每天 2:00。

**作业处理器上下文**（`PluginJobContext`）：

| 字段 | 类型 | 说明 |
|-------------|----------|-------------|
| `jobKey`    | string   | 与 manifest 声明匹配。 |
| `runId`     | string   | 本次运行的 UUID。 |
| `trigger`   | `"schedule" \| "manual" \| "retry"` | 触发本次运行的原因。 |
| `scheduledAt` | string | ISO 8601 格式的计划运行时间。 |

运行可由**计划**触发、从 UI/API **手动**触发，或作为**重试**触发（当操作员在失败后重新运行作业时）。在处理器中重新抛出异常可将运行标记为失败；宿主会记录该失败。宿主不会自动重试——操作员可从 UI 或 API 手动触发另一次运行。

示例：

**Manifest** — 添加 `jobs.schedule` 并声明作业：

```ts
// In your manifest (e.g. manifest.ts):
const manifest = {
  // ...
  capabilities: ["jobs.schedule", "plugin.state.write"],
  jobs: [
    {
      jobKey: "heartbeat",
      displayName: "Heartbeat",
      description: "Runs every 5 minutes",
      schedule: "*/5 * * * *",
    },
  ],
  // ...
};
```

**Worker** — 在 `setup()` 中注册处理器：

```ts
ctx.jobs.register("heartbeat", async (job) => {
  ctx.logger.info("Heartbeat run", { runId: job.runId, trigger: job.trigger });
  await ctx.state.set({ scopeKind: "instance", stateKey: "last-heartbeat" }, new Date().toISOString());
});
```

## UI 插槽与启动器

插槽是插件 React 组件的挂载点。启动器是宿主渲染的入口点（按钮、菜单项），用于打开插件 UI。在 `manifest.ui.slots` 中声明插槽，包含 `type`、`id`、`displayName`、`exportName`；对于上下文敏感的插槽，需添加 `entityTypes`。在 `manifest.ui.launchers`（或旧版 `manifest.launchers`）中声明启动器。

### 插槽类型 / 启动器放置区域

相同的值集合同时用作**插槽类型**（组件挂载位置）和**启动器放置区域**（启动器可出现的位置）。层级关系：

| 插槽类型 / 放置区域 | 作用域 | 实体类型（上下文敏感时） |
|----------------------------|-------|---------------------------------------|
| `page` | 全局 | — |
| `sidebar` | 全局 | — |
| `sidebarPanel` | 全局 | — |
| `settingsPage` | 全局 | — |
| `dashboardWidget` | 全局 | — |
| `globalToolbarButton` | 全局 | — |
| `detailTab` | 实体 | `project`, `issue`, `agent`, `goal`, `run` |
| `taskDetailView` | 实体 | （任务/问题上下文） |
| `commentAnnotation` | 实体 | `comment` |
| `commentContextMenuItem` | 实体 | `comment` |
| `projectSidebarItem` | 实体 | `project` |
| `toolbarButton` | 实体 | 因宿主界面而异 |
| `contextMenuItem` | 实体 | 因宿主界面而异 |

**作用域**描述插槽是否需要实体才能渲染。**全局**插槽无需特定实体即可渲染，但仍通过 `PluginHostContext` 接收当前活跃的 `companyId`——使用它将数据获取限定在当前公司范围内。**实体**插槽还需要 `entityId` 和 `entityType`（例如特定问题上的详情标签页）。

**实体类型**（用于插槽的 `entityTypes`）：`project` \| `issue` \| `agent` \| `goal` \| `run` \| `comment`。完整列表：从 `@paperclipai/plugin-sdk` 导入 `PLUGIN_UI_SLOT_TYPES` 和 `PLUGIN_UI_SLOT_ENTITY_TYPES`。

### 插槽组件说明

#### `page`

挂载在 `/plugins/:pluginId`（全局）或 `/:company/plugins/:pluginId`（公司上下文路由）的全页面扩展。适用于仪表板、配置向导或多步骤工作流等丰富的独立插件体验。接收 `PluginPageProps`，其中 `context.companyId` 设置为当前活跃公司。需要 `ui.page.register` 能力。

#### `sidebar`

在公司主侧边栏导航区域添加导航式条目，与核心导航项（仪表板、问题、目标等）并排渲染。适用于感觉原生于侧边栏的轻量级、始终可见的链接或状态指示器。接收 `PluginSidebarProps`，其中 `context.companyId` 设置为当前活跃公司。需要 `ui.sidebar.register` 能力。

#### `sidebarPanel`

在公司侧边栏导航区域下方的专用面板区域渲染更丰富的内联内容。适用于需要比导航链接更多垂直空间的迷你小部件、摘要卡片、快速操作面板或概览状态视图。通过 `useHostContext()` 接收设置为当前活跃公司的 `context.companyId`。需要 `ui.sidebar.register` 能力。

#### `settingsPage`

用自定义 React 组件替换自动生成的 JSON Schema 设置表单。当默认表单不够用时使用——例如插件需要多步骤配置、OAuth 流程、"测试连接"按钮或富文本输入控件时。接收 `PluginSettingsPageProps`，其中 `context.companyId` 设置为当前活跃公司。该组件负责通过 bridge（经由 `usePluginData` 和 `usePluginAction`）读写配置。

#### `dashboardWidget`

在主仪表板上渲染的卡片或区块。适用于与核心 Paperclip 信息并列展示插件数据的概览指标、状态指示器或摘要视图。接收 `PluginWidgetProps`，其中 `context.companyId` 设置为当前活跃公司。需要 `ui.dashboardWidget.register` 能力。

#### `detailTab`

项目、问题、代理、目标或运行详情页面上的附加标签页。当用户导航到该实体的详情视图时渲染。接收 `PluginDetailTabProps`，其中 `context.companyId` 设置为当前活跃公司，`context.entityId` / `context.entityType` 保证非空，因此可立即将数据获取限定在相关实体范围内。通过 manifest 插槽声明中的 `entityTypes` 数组指定标签页适用的实体类型。需要 `ui.detailTab.register` 能力。

#### `taskDetailView`

在任务或问题详情视图上下文中渲染的专用插槽。类似于 `detailTab`，但设计用于任务详情布局内的内联内容，而非独立标签页。与 `detailTab` 一样接收 `context.companyId`、`context.entityId` 和 `context.entityType`。需要 `ui.detailTab.register` 能力。

#### `projectSidebarItem`

在侧边栏项目列表中，在每个项目行下方**每个项目渲染一次**的链接或小组件。适用于添加可深度链接到插件详情标签页的项目作用域导航条目（例如"文件"、"Linear 同步"）：`/:company/projects/:projectRef?tab=plugin:<key>:<slotId>`。接收 `PluginProjectSidebarItemProps`，其中 `context.companyId` 设置为当前活跃公司，`context.entityId` 设置为项目 id，`context.entityType` 设置为 `"project"`。使用 manifest 插槽中的可选 `order` 字段控制排序位置。需要 `ui.sidebar.register` 能力。

#### `globalToolbarButton`

在全局顶部栏（面包屑栏）渲染的按钮，出现在每个页面上。适用于未限定到特定实体的全公司操作——例如通用搜索触发器、全局同步状态指示器，或适用于整个工作区的浮动操作。仅接收 `context.companyId` 和 `context.companyPrefix`；无实体上下文可用。需要 `ui.action.register` 能力。

#### `toolbarButton`

在实体页面（例如项目详情、问题详情）工具栏中渲染的按钮。适用于限定到当前实体的短暂上下文操作——例如触发项目同步、打开选择器或在该实体上运行快速命令。该组件可在内部打开插件自有的模态框用于确认或紧凑表单。接收 `context.companyId`、`context.entityId` 和 `context.entityType`；在 manifest 中声明 `entityTypes` 以控制按钮出现在哪些实体页面上。需要 `ui.action.register` 能力。

#### `contextMenuItem`

添加到宿主界面右键或溢出上下文菜单中的条目。适用于应用于光标下实体的辅助操作（例如"复制到 Linear"、"重新分析"）。接收设置为当前活跃公司的 `context.companyId`；实体上下文因宿主界面而异。需要 `ui.action.register` 能力。

#### `commentAnnotation`

在问题详情时间轴中每条评论下方渲染的逐条注释区域。适用于为评论添加解析后的文件链接、情感徽章、内联操作或任何逐条元数据。接收 `PluginCommentAnnotationProps`，其中 `context.entityId` 设置为评论 UUID，`context.entityType` 设置为 `"comment"`，`context.parentEntityId` 设置为父问题 UUID，`context.projectId` 设置为问题所属项目（如有），`context.companyPrefix` 设置为当前活跃公司的 slug。需要 `ui.commentAnnotation.register` 能力。

#### `commentContextMenuItem`

在问题详情时间轴中每条评论的"更多"下拉菜单（⋮）中渲染的逐条上下文菜单项。适用于添加逐条操作，例如"从评论创建子问题"、"翻译"、"标记审阅"或自定义插件操作。接收 `PluginCommentContextMenuItemProps`，其中 `context.entityId` 设置为评论 UUID，`context.entityType` 设置为 `"comment"`，`context.parentEntityId` 设置为父问题 UUID，`context.projectId` 设置为问题所属项目（如有），`context.companyPrefix` 设置为当前活跃公司的 slug。插件可以打开限定到该评论的抽屉、模态框或弹出框。⋮ 菜单按钮仅在至少有一个插件渲染可见内容的评论上显示。需要 `ui.action.register` 能力。

### 启动器操作与渲染选项

| 启动器操作 | 说明 |
|-----------------|-------------|
| `navigate` | 导航到一个路由（插件或宿主）。 |
| `openModal` | 打开一个模态框。 |
| `openDrawer` | 打开一个抽屉。 |
| `openPopover` | 打开一个弹出框。 |
| `performAction` | 执行一个操作（例如调用插件）。 |
| `deepLink` | 深度链接到插件或外部 URL。 |

| 渲染选项 | 取值 | 说明 |
|---------------|--------|-------------|
| `environment` | `hostInline`, `hostOverlay`, `hostRoute`, `external`, `iframe` | 启动器激活后期望的容器类型。 |
| `bounds` | `inline`, `compact`, `default`, `wide`, `full` | 叠加层/抽屉的尺寸提示。 |

### 能力

在 `manifest.capabilities` 中声明。按作用域分组：

| 作用域 | 能力 |
|-------|------------|
| **公司** | `companies.read` |
| | `projects.read` |
| | `project.workspaces.read` |
| | `issues.read` |
| | `issue.comments.read` |
| | `agents.read` |
| | `goals.read` |
| | `goals.create` |
| | `goals.update` |
| | `activity.read` |
| | `costs.read` |
| | `issues.create` |
| | `issues.update` |
| | `issue.comments.create` |
| | `activity.log.write` |
| | `metrics.write` |
| **实例** | `instance.settings.register` |
| | `plugin.state.read` |
| | `plugin.state.write` |
| **运行时** | `events.subscribe` |
| | `events.emit` |
| | `jobs.schedule` |
| | `webhooks.receive` |
| | `http.outbound` |
| | `secrets.read-ref` |
| **代理** | `agent.tools.register` |
| | `agents.invoke` |
| | `agent.sessions.create` |
| | `agent.sessions.list` |
| | `agent.sessions.send` |
| | `agent.sessions.close` |
| **UI** | `ui.sidebar.register` |
| | `ui.page.register` |
| | `ui.detailTab.register` |
| | `ui.dashboardWidget.register` |
| | `ui.commentAnnotation.register` |
| | `ui.action.register` |

完整列表见代码：从 `@paperclipai/plugin-sdk` 导入 `PLUGIN_CAPABILITIES`。

## UI 快速入门

```tsx
import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget() {
  const { data } = usePluginData<{ status: string }>("health");
  const ping = usePluginAction("ping");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <strong>Health</strong>
      <div>{data?.status ?? "unknown"}</div>
      <button onClick={() => void ping()}>Ping</button>
    </div>
  );
}
```

### Hooks 参考

#### `usePluginData<T>(key, params?)`

从 worker 注册的 `getData` 处理器获取数据。当 `params` 变化时重新获取。返回 `{ data, loading, error, refresh }`。

```tsx
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

interface SyncStatus {
  lastSyncAt: string;
  syncedCount: number;
  healthy: boolean;
}

export function SyncStatusWidget({ context }: PluginWidgetProps) {
  const { data, loading, error, refresh } = usePluginData<SyncStatus>("sync-status", {
    companyId: context.companyId,
  });

  if (loading) return <div>Loading…</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>Status: {data!.healthy ? "Healthy" : "Unhealthy"}</p>
      <p>Synced {data!.syncedCount} items</p>
      <p>Last sync: {data!.lastSyncAt}</p>
      <button onClick={refresh}>Refresh</button>
    </div>
  );
}
```

#### `usePluginAction(key)`

返回一个异步函数，用于调用 worker 的 `performAction` 处理器。失败时抛出 `PluginBridgeError`。

```tsx
import { useState } from "react";
import { usePluginAction, type PluginBridgeError } from "@paperclipai/plugin-sdk/ui";

export function ResyncButton({ context }: PluginWidgetProps) {
  const resync = usePluginAction("resync");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setError(null);
    try {
      await resync({ companyId: context.companyId });
    } catch (err) {
      setError((err as PluginBridgeError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={handleClick} disabled={busy}>
        {busy ? "Syncing..." : "Resync Now"}
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </div>
  );
}
```

#### `useHostContext()`

Reads the active company, project, entity, and user context. Use this to scope data fetches and actions.

```tsx
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";

export function IssueLinearLink({ context }: PluginDetailTabProps) {
  const { companyId, entityId, entityType } = context;
  const { data } = usePluginData<{ url: string }>("linear-link", {
    companyId,
    issueId: entityId,
  });

  if (!data?.url) return <p>No linked Linear issue.</p>;
  return <a href={data.url} target="_blank" rel="noopener">View in Linear</a>;
}
```

#### `usePluginStream<T>(channel, options?)`

Subscribes to a real-time event stream pushed from the plugin worker via SSE. The worker pushes events using `ctx.streams.emit(channel, event)` and the hook receives them as they arrive. Returns `{ events, lastEvent, connecting, connected, error, close }`.

```tsx
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";

interface ChatToken {
  text: string;
}

export function ChatMessages({ context }: PluginWidgetProps) {
  const { events, connected, close } = usePluginStream<ChatToken>("chat-stream", {
    companyId: context.companyId ?? undefined,
  });

  return (
    <div>
      {events.map((e, i) => <span key={i}>{e.text}</span>)}
      {connected && <span className="pulse" />}
      <button onClick={close}>Stop</button>
    </div>
  );
}
```

The SSE connection targets `GET /api/plugins/:pluginId/bridge/stream/:channel?companyId=...`. The host bridge manages the EventSource lifecycle; `close()` terminates the connection.

### UI authoring note

The current host does **not** provide a real shared component library to plugins yet. Use normal React components, your own CSS, or your own small design primitives inside the plugin package.

### Slot component props

Each slot type receives a typed props object with `context: PluginHostContext`. Import from `@paperclipai/plugin-sdk/ui`.

| Slot type | Props interface | `context` extras |
|-----------|----------------|------------------|
| `page` | `PluginPageProps` | — |
| `sidebar` | `PluginSidebarProps` | — |
| `settingsPage` | `PluginSettingsPageProps` | — |
| `dashboardWidget` | `PluginWidgetProps` | — |
| `globalToolbarButton` | `PluginGlobalToolbarButtonProps` | — |
| `detailTab` | `PluginDetailTabProps` | `entityId: string`, `entityType: string` |
| `toolbarButton` | `PluginToolbarButtonProps` | `entityId: string`, `entityType: string` |
| `commentAnnotation` | `PluginCommentAnnotationProps` | `entityId: string`, `entityType: "comment"`, `parentEntityId: string`, `projectId`, `companyPrefix` |
| `commentContextMenuItem` | `PluginCommentContextMenuItemProps` | `entityId: string`, `entityType: "comment"`, `parentEntityId: string`, `projectId`, `companyPrefix` |
| `projectSidebarItem` | `PluginProjectSidebarItemProps` | `entityId: string`, `entityType: "project"` |

Example detail tab with entity context:

```tsx
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

export function AgentMetricsTab({ context }: PluginDetailTabProps) {
  const { data, loading } = usePluginData<Record<string, string>>("agent-metrics", {
    agentId: context.entityId,
    companyId: context.companyId,
  });

  if (loading) return <div>Loading…</div>;
  if (!data) return <p>No metrics available.</p>;

  return (
    <dl>
      {Object.entries(data).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
```

## Launcher surfaces and modals

V1 does not provide a dedicated `modal` slot. Plugins can either:

- declare concrete UI mount points in `ui.slots`
- declare host-rendered entry points in `ui.launchers`

Supported launcher placement zones currently mirror the major host surfaces such as `projectSidebarItem`, `globalToolbarButton`, `toolbarButton`, `detailTab`, `settingsPage`, and `contextMenuItem`. Plugins may still open their own local modal from those entry points when needed.

Declarative launcher example:

```json
{
  "ui": {
    "launchers": [
      {
        "id": "sync-project",
        "displayName": "Sync",
        "placementZone": "toolbarButton",
        "entityTypes": ["project"],
        "action": {
          "type": "openDrawer",
          "target": "sync-project"
        },
        "render": {
          "environment": "hostOverlay",
          "bounds": "wide"
        }
      }
    ]
  }
}
```

The host returns launcher metadata from `GET /api/plugins/ui-contributions` alongside slot declarations.

When a launcher opens a host-owned overlay or page, `useHostContext()`,
`usePluginData()`, and `usePluginAction()` receive the current
`renderEnvironment` through the bridge. Use that to tailor compact modal UI vs.
full-page layouts without adding custom route parsing in the plugin.

## Project sidebar item

Plugins can add a link under each project in the sidebar via the `projectSidebarItem` slot. This is the recommended slot-based launcher pattern for project-scoped workflows because it can deep-link into a richer plugin tab. The component is rendered once per project with that project’s id in `context.entityId`. Declare the slot and capability in your manifest:

```json
{
  "ui": {
    "slots": [
      {
        "type": "projectSidebarItem",
        "id": "files",
        "displayName": "Files",
        "exportName": "FilesLink",
        "entityTypes": ["project"]
      }
    ]
  },
  "capabilities": ["ui.sidebar.register", "ui.detailTab.register"]
}
```

Minimal React component that links to the project’s plugin tab (see project detail tabs in the spec):

```tsx
import type { PluginProjectSidebarItemProps } from "@paperclipai/plugin-sdk/ui";

export function FilesLink({ context }: PluginProjectSidebarItemProps) {
  const projectId = context.entityId;
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const projectRef = projectId; // or resolve from host; entityId is project id
  return (
    <a href={`${prefix}/projects/${projectRef}?tab=plugin:your-plugin:files`}>
      Files
    </a>
  );
}
```

Use optional `order` in the slot to sort among other project sidebar items. See §19.5.1 in the plugin spec and project detail plugin tabs (§19.3) for the full flow.

## Toolbar launcher with a local modal

Two toolbar slot types are available depending on where the button should appear:

- **`globalToolbarButton`** — renders in the top bar on every page, scoped to the company. No entity context. Use for workspace-wide actions.
- **`toolbarButton`** — renders on entity detail pages (project, issue, etc.). Receives `entityId` and `entityType`. Declare `entityTypes` to control which pages the button appears on.

For short-lived actions, mount the appropriate slot type and open a plugin-owned modal inside the component. Use `useHostContext()` to scope the action to the current company or entity.

Project-scoped example (appears only on project detail pages):

```json
{
  "ui": {
    "slots": [
      {
        "type": "toolbarButton",
        "id": "sync-toolbar-button",
        "displayName": "Sync",
        "exportName": "SyncToolbarButton",
        "entityTypes": ["project"]
      }
    ]
  },
  "capabilities": ["ui.action.register"]
}
```

```tsx
import { useState } from "react";
import {
  useHostContext,
  usePluginAction,
} from "@paperclipai/plugin-sdk/ui";

export function SyncToolbarButton() {
  const context = useHostContext();
  const syncProject = usePluginAction("sync-project");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function confirm() {
    if (!context.projectId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await syncProject({ projectId: context.projectId });
      setOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Sync
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-background p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold">Sync this project?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Queue a sync for <code>{context.projectId}</code>.
            </p>
            {errorMessage ? (
              <p className="mt-2 text-sm text-destructive">{errorMessage}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void confirm()} disabled={submitting}>
                {submitting ? "Running…" : "Run sync"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
```

Prefer deep-linkable tabs and pages for primary workflows. Reserve plugin-owned modals for confirmations, pickers, and compact editors.

## Real-time streaming (`ctx.streams`)

Plugins can push real-time events from the worker to the UI using server-sent events (SSE). This is useful for streaming LLM tokens, live sync progress, or any push-based data.

### Worker side

In `setup()`, use `ctx.streams` to open a channel, emit events, and close when done:

```ts
const plugin = definePlugin({
  async setup(ctx) {
    ctx.actions.register("chat", async (params) => {
      const companyId = params.companyId as string;
      ctx.streams.open("chat-stream", companyId);

      for await (const token of streamFromLLM(params.prompt as string)) {
        ctx.streams.emit("chat-stream", { text: token });
      }

      ctx.streams.close("chat-stream");
      return { ok: true };
    });
  },
});
```

**API:**

| Method | Description |
|--------|-------------|
| `ctx.streams.open(channel, companyId)` | Open a named stream channel and associate it with a company. Sends a `streams.open` notification to the host. |
| `ctx.streams.emit(channel, event)` | Push an event to the channel. The `companyId` is automatically resolved from the prior `open()` call. |
| `ctx.streams.close(channel)` | Close the channel and clear the company mapping. Sends a `streams.close` notification. |

Stream notifications are fire-and-forget JSON-RPC messages (no `id` field). They are sent via `notifyHost()` synchronously during handler execution.

### UI side

Use the `usePluginStream` hook (see [Hooks reference](#usepluginstreamtchannel-options) above) to subscribe to events from the UI.

### Host-side architecture

The host maintains an in-memory `PluginStreamBus` that fans out worker notifications to connected SSE clients:

1. Worker emits `streams.emit` notification via stdout
2. Host (`plugin-worker-manager`) receives the notification and publishes to `PluginStreamBus`
3. SSE endpoint (`GET /api/plugins/:pluginId/bridge/stream/:channel?companyId=...`) subscribes to the bus and writes events to the response

The bus is keyed by `pluginId:channel:companyId`, so multiple UI clients can subscribe to the same stream independently.

### Streaming agent responses to the UI

`ctx.streams` and `ctx.agents.sessions` are complementary. The worker sits between them, relaying agent events to the browser in real time:

```
UI ──usePluginAction──▶ Worker ──sessions.sendMessage──▶ Agent
UI ◀──usePluginStream── Worker ◀──onEvent callback────── Agent
```

The agent doesn't know about streams — the worker decides what to relay. Encode the agent ID in the channel name to scope streams per agent.

**Worker:**

```ts
ctx.actions.register("ask-agent", async (params) => {
  const { agentId, companyId, prompt } = params as {
    agentId: string; companyId: string; prompt: string;
  };

  const channel = `agent:${agentId}`;
  ctx.streams.open(channel, companyId);

  const session = await ctx.agents.sessions.create(agentId, companyId);

  await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
    prompt,
    onEvent: (event) => {
      ctx.streams.emit(channel, {
        type: event.eventType,       // "chunk" | "done" | "error"
        text: event.message ?? "",
      });
    },
  });

  ctx.streams.close(channel);
  return { sessionId: session.sessionId };
});
```

**UI:**

```tsx
import { useState } from "react";
import { usePluginAction, usePluginStream } from "@paperclipai/plugin-sdk/ui";

interface AgentEvent {
  type: "chunk" | "done" | "error";
  text: string;
}

export function AgentChat({ agentId, companyId }: { agentId: string; companyId: string }) {
  const askAgent = usePluginAction("ask-agent");
  const { events, connected, close } = usePluginStream<AgentEvent>(`agent:${agentId}`, { companyId });
  const [prompt, setPrompt] = useState("");

  async function send() {
    setPrompt("");
    await askAgent({ agentId, companyId, prompt });
  }

  return (
    <div>
      <div>{events.filter(e => e.type === "chunk").map((e, i) => <span key={i}>{e.text}</span>)}</div>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <button onClick={send}>Send</button>
      {connected && <button onClick={close}>Stop</button>}
    </div>
  );
}
```

## Agent sessions (two-way chat)

Plugins can hold multi-turn conversational sessions with agents:

```ts
// Create a session
const session = await ctx.agents.sessions.create(agentId, companyId);

// Send a message and stream the response
await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
  prompt: "Help me triage this issue",
  onEvent: (event) => {
    if (event.eventType === "chunk") console.log(event.message);
    if (event.eventType === "done") console.log("Stream complete");
  },
});

// List active sessions
const sessions = await ctx.agents.sessions.list(agentId, companyId);

// Close when done
await ctx.agents.sessions.close(session.sessionId, companyId);
```

Requires capabilities: `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, `agent.sessions.close`.

Exported types: `AgentSession`, `AgentSessionEvent`, `AgentSessionSendResult`, `PluginAgentSessionsClient`.

## Testing utilities

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);
await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
```

## Bundler presets

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
// presets.esbuild.worker / presets.esbuild.manifest / presets.esbuild.ui
// presets.rollup.worker / presets.rollup.manifest / presets.rollup.ui
```

## Local dev server (hot-reload events)

```bash
paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177
```

Or programmatically:

```ts
import { startPluginDevServer } from "@paperclipai/plugin-sdk/dev-server";
const server = await startPluginDevServer({ rootDir: process.cwd() });
```

Dev server endpoints:
- `GET /__paperclip__/health` returns `{ ok, rootDir, uiDir }`
- `GET /__paperclip__/events` streams `reload` SSE events on UI build changes
