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

### Slot component descriptions

#### `page`

A full-page extension mounted at `/plugins/:pluginId` (global) or `/:company/plugins/:pluginId` (company-context route). Use this for rich, standalone plugin experiences such as dashboards, configuration wizards, or multi-step workflows. Receives `PluginPageProps` with `context.companyId` set to the active company. Requires the `ui.page.register` capability.

#### `sidebar`

Adds a navigation-style entry to the main company sidebar navigation area, rendered alongside the core nav items (Dashboard, Issues, Goals, etc.). Use this for lightweight, always-visible links or status indicators that feel native to the sidebar. Receives `PluginSidebarProps` with `context.companyId` set to the active company. Requires the `ui.sidebar.register` capability.

#### `sidebarPanel`

Renders richer inline content in a dedicated panel area below the company sidebar navigation sections. Use this for mini-widgets, summary cards, quick-action panels, or at-a-glance status views that need more vertical space than a nav link. Receives `context.companyId` set to the active company via `useHostContext()`. Requires the `ui.sidebar.register` capability.

#### `settingsPage`

Replaces the auto-generated JSON Schema settings form with a custom React component. Use this when the default form is insufficient — for example, when your plugin needs multi-step configuration, OAuth flows, "Test Connection" buttons, or rich input controls. Receives `PluginSettingsPageProps` with `context.companyId` set to the active company. The component is responsible for reading and writing config through the bridge (via `usePluginData` and `usePluginAction`).

#### `dashboardWidget`

A card or section rendered on the main dashboard. Use this for at-a-glance metrics, status indicators, or summary views that surface plugin data alongside core Paperclip information. Receives `PluginWidgetProps` with `context.companyId` set to the active company. Requires the `ui.dashboardWidget.register` capability.

#### `detailTab`

An additional tab on a project, issue, agent, goal, or run detail page. Rendered when the user navigates to that entity's detail view. Receives `PluginDetailTabProps` with `context.companyId` set to the active company and `context.entityId` / `context.entityType` guaranteed to be non-null, so you can immediately scope data fetches to the relevant entity. Specify which entity types the tab applies to via the `entityTypes` array in the manifest slot declaration. Requires the `ui.detailTab.register` capability.

#### `taskDetailView`

A specialized slot rendered in the context of a task or issue detail view. Similar to `detailTab` but designed for inline content within the task detail layout rather than a separate tab. Receives `context.companyId`, `context.entityId`, and `context.entityType` like `detailTab`. Requires the `ui.detailTab.register` capability.

#### `projectSidebarItem`

A link or small component rendered **once per project** under that project's row in the sidebar Projects list. Use this to add project-scoped navigation entries (e.g. "Files", "Linear Sync") that deep-link into a plugin detail tab: `/:company/projects/:projectRef?tab=plugin:<key>:<slotId>`. Receives `PluginProjectSidebarItemProps` with `context.companyId` set to the active company, `context.entityId` set to the project id, and `context.entityType` set to `"project"`. Use the optional `order` field in the manifest slot to control sort position. Requires the `ui.sidebar.register` capability.

#### `globalToolbarButton`

A button rendered in the global top bar (breadcrumb bar) that appears on every page. Use this for company-wide actions that are not scoped to a specific entity — for example, a universal search trigger, a global sync status indicator, or a floating action that applies across the whole workspace. Receives only `context.companyId` and `context.companyPrefix`; no entity context is available. Requires the `ui.action.register` capability.

#### `toolbarButton`

A button rendered in the toolbar of an entity page (e.g. project detail, issue detail). Use this for short-lived, contextual actions scoped to the current entity — like triggering a project sync, opening a picker, or running a quick command on that entity. The component can open a plugin-owned modal internally for confirmations or compact forms. Receives `context.companyId`, `context.entityId`, and `context.entityType`; declare `entityTypes` in the manifest to control which entity pages the button appears on. Requires the `ui.action.register` capability.

#### `contextMenuItem`

An entry added to a right-click or overflow context menu on a host surface. Use this for secondary actions that apply to the entity under the cursor (e.g. "Copy to Linear", "Re-run analysis"). Receives `context.companyId` set to the active company; entity context varies by host surface. Requires the `ui.action.register` capability.

#### `commentAnnotation`

A per-comment annotation region rendered below each individual comment in the issue detail timeline. Use this to augment comments with parsed file links, sentiment badges, inline actions, or any per-comment metadata. Receives `PluginCommentAnnotationProps` with `context.entityId` set to the comment UUID, `context.entityType` set to `"comment"`, `context.parentEntityId` set to the parent issue UUID, `context.projectId` set to the issue's project (if any), and `context.companyPrefix` set to the active company slug. Requires the `ui.commentAnnotation.register` capability.

#### `commentContextMenuItem`

A per-comment context menu item rendered in the "more" dropdown menu (⋮) on each comment in the issue detail timeline. Use this to add per-comment actions such as "Create sub-issue from comment", "Translate", "Flag for review", or custom plugin actions. Receives `PluginCommentContextMenuItemProps` with `context.entityId` set to the comment UUID, `context.entityType` set to `"comment"`, `context.parentEntityId` set to the parent issue UUID, `context.projectId` set to the issue's project (if any), and `context.companyPrefix` set to the active company slug. Plugins can open drawers, modals, or popovers scoped to that comment. The ⋮ menu button only appears on comments where at least one plugin renders visible content. Requires the `ui.action.register` capability.

### Launcher actions and render options

| Launcher action | Description |
|-----------------|-------------|
| `navigate` | Navigate to a route (plugin or host). |
| `openModal` | Open a modal. |
| `openDrawer` | Open a drawer. |
| `openPopover` | Open a popover. |
| `performAction` | Run an action (e.g. call plugin). |
| `deepLink` | Deep link to plugin or external URL. |

| Render option | Values | Description |
|---------------|--------|-------------|
| `environment` | `hostInline`, `hostOverlay`, `hostRoute`, `external`, `iframe` | Container the launcher expects after activation. |
| `bounds` | `inline`, `compact`, `default`, `wide`, `full` | Size hint for overlays/drawers. |

### Capabilities

Declare in `manifest.capabilities`. Grouped by scope:

| Scope | Capability |
|-------|------------|
| **Company** | `companies.read` |
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
| **Instance** | `instance.settings.register` |
| | `plugin.state.read` |
| | `plugin.state.write` |
| **Runtime** | `events.subscribe` |
| | `events.emit` |
| | `jobs.schedule` |
| | `webhooks.receive` |
| | `http.outbound` |
| | `secrets.read-ref` |
| **Agent** | `agent.tools.register` |
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

Full list in code: import `PLUGIN_CAPABILITIES` from `@paperclipai/plugin-sdk`.

## UI quick start

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

### Hooks reference

#### `usePluginData<T>(key, params?)`

Fetches data from the worker's registered `getData` handler. Re-fetches when `params` changes. Returns `{ data, loading, error, refresh }`.

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

Returns an async function that calls the worker's `performAction` handler. Throws `PluginBridgeError` on failure.

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
